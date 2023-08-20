import * as core from '@actions/core'
import * as coreCommand from '@actions/core/lib/command'
import * as github from '@actions/github'
import * as path from 'path'
import * as gitSourceProvider from './externals/checkout-action/src/git-source-provider'
import * as inputHelper from './externals/checkout-action/src/input-helper'
import * as stateHelper from './externals/checkout-action/src/state-helper'

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

  // if (!pr_context.mergeable) {
  //   core.setFailed('PR is not mergeable. Abort.')
  //   return
  // }

  const pr_base: string | undefined = pr_context.base.sha

  if (!pr_base) {
    core.setFailed(`Failed to determine PR base. Abort.`)
    return
  }

  if (pr_context) {
    core.info('List properties of pr_context')
    core.info(JSON.stringify(pr_context, undefined, '\t'))

    //merge_base
  } else {
    core.error('Payload context is not set')
  }

  const pr_target_head: string | undefined = pr_context?.head.sha
  if (pr_target_head !== pr_base) {
    core.setFailed(
      `[WIP] PR base (${pr_base}) is not the same as target branch head (${pr_target_head}). This is unsupported at the moment, please rebase your branch. ${pr_context?.body}`
    )
    return
  }

  try {
    // Use github checkout action getInputs to retrieve default and maybe expose some
    // in the future is relevant
    const sourceSettings = await inputHelper.getInputs()
    // override some to match needed behaviour
    sourceSettings.persistCredentials = true
    // Start at branch point to generate base config export
    sourceSettings.ref = pr_base

    try {
      // Register github action problem matcher
      coreCommand.issueCommand(
        'add-matcher',
        {},
        path.join(__dirname, 'checkout-action-problem-matcher.json')
      )

      // Get sources
      await gitSourceProvider.getSource(sourceSettings)
    } finally {
      // Unregister problem matcher
      coreCommand.issueCommand('remove-matcher', {owner: 'checkout-git'}, '')
    }
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
}

// Main
if (!stateHelper.IsPost) {
  run()
}
// Post
else {
  cleanup()
}
