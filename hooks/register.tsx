import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OutputRow } from '../types'
import { applyDrop, listOutputs, parseArgs, summaryLine } from './prune'

const USAGE = 'Usage: /prune drops every tool output; /prune -i picks which.'

const pending = atom({ plugin: 'dcp', key: 'pending' } as const, null)

// A command hook may not compact under the turn it holds, and a plugin's own
// $.session.compact() skips its own hooks. So the prune rides a /compact run
// from a timer, which the session.compact hook below answers.
async function compact($: EngineInterface): Promise<void> {
  let failure: string | undefined

  try {
    await $.command.run({ command: 'compact' })
  } catch (error) {
    failure = String(error)
  }

  if ((await read($, pending)) !== null) {
    await update($, pending, () => null)
    $.ui.log(`Prune skipped: ${failure ?? 'the compaction did not run'}`)
  }
}

async function prune($: EngineInterface, picked: readonly OutputRow[]): Promise<string> {
  if (picked.length === 0) {
    return summaryLine([])
  }

  await update($, pending, () => picked.map(row => row.id))
  $.clock.after(0, () => void compact($))

  return summaryLine(picked)
}

export const register: Register = on => {
  let isInteractive = true

  on('session.start', async ($, e, next) => {
    isInteractive = e.isInteractive
    await update($, pending, () => null)
    await $.command.register({
      name: 'prune',
      description: 'Drop tool outputs from the context (-i to pick which)',
      argumentHint: '[-i]',
    })

    return next(e)
  })

  on('command.run', { command: 'prune' }, async ($, e) => {
    const mode = parseArgs(e.args)

    if (mode === 'usage') {
      return { text: USAGE }
    }

    if (!isInteractive) {
      return { text: '/prune needs an interactive session.' }
    }

    const found = listOutputs(await $.session.messages({ as: 'api' }))

    return { text: await prune($, found) }
  })

  on('session.compact', { trigger: 'manual' }, async ($, e, next) => {
    const ids = await read($, pending)

    if (ids === null || e.agentId !== undefined) {
      return next(e)
    }

    const messages = applyDrop(e.messages, new Set(ids))
    await update($, pending, () => null)

    return { messages }
  }).catch(async ($, e, next) => {
    if (next.called || e.agentId !== undefined) {
      return next(e)
    }

    try {
      if ((await read($, pending)) === null) {
        return next(e)
      }
    } catch {
      return { skip: 'prune failed' }
    }

    return { skip: 'prune failed' }
  })
}
