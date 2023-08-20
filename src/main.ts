import * as core from '@actions/core'
import * as coreCommand from '@actions/core/lib/command'
import * as exec from '@actions/exec'
import * as fsHelper from './externals/checkout-action/src/fs-helper'
import * as github from '@actions/github'
import * as gitSourceProvider from './externals/checkout-action/src/git-source-provider'
import * as inputHelper from './externals/checkout-action/src/input-helper'
import * as io from '@actions/io'
import * as path from 'path'
import * as stateHelper from './externals/checkout-action/src/state-helper'
import {GitCommandManager} from './externals/checkout-action/src/git-command-manager'
import {IGitSourceSettings} from './externals/checkout-action/src/git-source-settings'

const EXPORT_REPOSITORY_PATH = `/tmp/${github.context.job}/${github.context.runNumber}`

async function run(): Promise<void> {
  const pr_context = github.context.payload.pull_request
  if (!pr_context) {
    core.setFailed('PR context is unset. Abort.')
    return
  }

  if (pr_context.merged) {
    core.info('PR already merged. Early out.')
    return
  }

  if (!pr_context.base.sha) {
    core.setFailed(`Failed to retrieve PR base from context. Abort.`)
    return
  }
  if (!pr_context.head.sha) {
    core.setFailed(`Failed to retrieve PR head from context. Abort.`)
    return
  }

  try {
    // Use github checkout action getInputs to retrieve default and maybe expose some
    // in the future is relevant
    const sourceSettings = await inputHelper.getInputs()
    // override some to match needed behaviour
    sourceSettings.persistCredentials = true
    // Start at branch point to generate base config export
    sourceSettings.commit = pr_context.base.sha

    const confRepository = await setupGitRepository(sourceSettings)

    core.startGroup('Fetch base and head')
    await confRepository.fetch([pr_context.base.sha, pr_context.head.sha], {})
    core.endGroup()

    // We should be able to use `pr_context.merge_base` but Gitea sends a outdated one
    const mergeBase = await confRepository.mergeBase(
      pr_context.base.sha,
      pr_context.head.sha
    )
    if (mergeBase !== pr_context.base.sha) {
      core.setFailed(
        `Merge base between PR Base (${pr_context.base.sha}) and PR head (${pr_context.head.sha}) is different from PR base current head (found merge-base ${mergeBase}). This is unsupported at the moment, please rebase your branch.`
      )
      return
    }

    const exportRepository = await initExportRepo()

    // Do a first export on base commit
    const initialCommitMessage = await getPrettyCommitMessage(confRepository)
    await exportConf(
      exportRepository,
      sourceSettings.repositoryPath,
      initialCommitMessage
    )
    // TODO(TDS): Tag this commit?
    const baseExportedCommit = await exportRepository.revParse('HEAD')

    const commitList = await getCommitList(
      confRepository,
      pr_context.base.sha,
      pr_context.head.sha
    )
    for (const commit of commitList) {
      await confRepository.checkout(commit, '')
      const commitMessage = await getPrettyCommitMessage(confRepository)
      await exportConf(
        exportRepository,
        sourceSettings.repositoryPath,
        commitMessage
      )
    }

    const lastExportedCommit = await exportRepository.revParse('HEAD')

    core.info(
      `Finished config export. ${baseExportedCommit} to ${lastExportedCommit}`
    )
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

async function cleanup(): Promise<void> {
  try {
    await gitSourceProvider.cleanup(stateHelper.RepositoryPath)
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    core.warning(`${(error as any)?.message ?? error}`)
  }
  try {
    await gitSourceProvider.cleanup(EXPORT_REPOSITORY_PATH)
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    core.warning(`${(error as any)?.message ?? error}`)
  }
}

async function setupGitRepository(
  sourceSettings: IGitSourceSettings
): Promise<GitCommandManager> {
  core.startGroup('Setup conf repository')
  try {
    // Register github action problem matcher
    coreCommand.issueCommand(
      'add-matcher',
      {},
      path.join(__dirname, 'checkout-action-problem-matcher.json')
    )

    // Force depth 1 as we need to get history for 2 branches,
    // which is not handle by checkout-action
    sourceSettings.fetchDepth = 1
    // Setup repository
    await gitSourceProvider.getSource(sourceSettings)

    const git = await GitCommandManager.createCommandManager(
      sourceSettings.repositoryPath,
      sourceSettings.lfs,
      sourceSettings.sparseCheckout != null
    )

    return git
  } finally {
    // Unregister problem matcher
    coreCommand.issueCommand('remove-matcher', {owner: 'checkout-git'}, '')

    core.endGroup()
  }
}

async function initExportRepo(): Promise<GitCommandManager> {
  core.startGroup('Initialize export repository')

  // Remove conflicting file path
  if (fsHelper.fileExistsSync(EXPORT_REPOSITORY_PATH)) {
    await io.rmRF(EXPORT_REPOSITORY_PATH)
  }

  // Create directory
  if (!fsHelper.directoryExistsSync(EXPORT_REPOSITORY_PATH)) {
    await io.mkdirP(EXPORT_REPOSITORY_PATH)
  }

  const git = await GitCommandManager.createCommandManager(
    EXPORT_REPOSITORY_PATH,
    false,
    false
  )

  await git.init()

  core.endGroup()
  return git
}

async function getPrettyCommitMessage(git: GitCommandManager): Promise<string> {
  core.startGroup('Generate pretty commit for exported configuration')
  const revParseOutput = await git.execGit([
    'rev-parse',
    '--abbrev-ref',
    'HEAD'
  ])
  const logOutput = await git.execGit([
    'log',
    '--no-decorate',
    '--oneline',
    '-1'
  ])
  core.endGroup()
  return `${revParseOutput.stdout.trim()} - ${logOutput.stdout.trim()}`
}

async function getCommitList(
  git: GitCommandManager,
  base: string,
  head: string
): Promise<string[]> {
  core.startGroup(`Get commits included in range ]${base}, ${head}]`)
  const args = ['rev-list', '--reverse', '--first-parent', `${base}...${head}`]
  const output = await git.execGit(args)
  core.endGroup()
  return output.stdout.trim().split('\n')
}

async function exportConf(
  exportRepository: GitCommandManager,
  confRepositoryPath: string,
  commitMessage: string
): Promise<void> {
  core.startGroup('Export Configuration')

  core.startGroup('Remove previously exported configuration')
  const gitRmArgs = ['rm', '--quiet', '--recursive', '--force', '--', '*']
  // Remove previous export
  await exportRepository.execGit(gitRmArgs)
  core.endGroup()

  core.startGroup('Find Python2 exe')
  let python2Path
  try {
    python2Path = await io.which('python2', true)
  } catch {
    python2Path = await io.which('python', true)
  }
  core.endGroup()

  core.startGroup('Run exporter')
  const exportArgs = [
    '-m',
    'administration.master_config_utils',
    'export',
    '--skip-check',
    '--tree',
    `"${EXPORT_REPOSITORY_PATH}"`
  ]
  await exec.exec(`"${python2Path}"`, exportArgs, {cwd: confRepositoryPath})
  core.endGroup()

  core.startGroup('Add exported configuration')
  const gitAddArgs = ['add', '--force', '--', '*']
  await exportRepository.execGit(gitAddArgs)
  core.endGroup()

  core.startGroup('Commit exported configuration')
  const gitCommitArgs = ['commit', '-m', commitMessage]
  await exportRepository.execGit(gitCommitArgs)
  core.endGroup()

  core.endGroup()
}

// Main
if (!stateHelper.IsPost) {
  run()
}
// Post
else {
  cleanup()
}
