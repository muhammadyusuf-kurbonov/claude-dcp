import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OutputRow } from '../types'
import { applyDrop, estimateTokens, formatTokens, listOutputs, oneLine, parseArgs, summaryLine } from './prune'

const USAGE = 'Usage: /prune drops every tool output; /prune -i picks which.'

const PANE = 'prune'
// The instructions the mod's own /compact carries, so the hook answers that
// compaction and no other.
const MARK = 'dcp-prune'

const rows = atom({ plugin: 'dcp', key: 'rows' } as const, [])
const pending = atom({ plugin: 'dcp', key: 'pending' } as const, null)

// A command hook may not compact under the turn it holds, and a plugin's own
// $.session.compact() skips its own hooks. So the prune rides a marked
// /compact run from a timer, which the session.compact hook below answers.
async function compact($: EngineInterface): Promise<void> {
  let failure: string | undefined

  try {
    await $.command.run({ command: 'compact', args: MARK })
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

  // A prune already waiting takes these ids along: one /compact for both.
  let isWaiting = false
  await update($, pending, ids => {
    isWaiting = ids !== null

    return [...new Set([...(ids ?? []), ...picked.map(row => row.id)])]
  })

  if (!isWaiting) {
    $.clock.after(0, () => void compact($))
  }

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

    if (mode === 'all' || found.length === 0) {
      return { text: await prune($, found) }
    }

    await update($, rows, () => found)
    await $.ui.open({ id: PANE, title: 'Prune tool outputs', focus: true, closeOnEscape: true })

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, rows)
    const marked = list.filter(row => row.isDropped)
    const chars = marked.reduce((sum, row) => sum + row.chars, 0)
    const sizes = list.map(row => `${formatTokens(estimateTokens(row.chars))} tok`)
    const sizeWidth = Math.max(0, ...sizes.map(size => size.length))
    // mark (4), a gap, the size and the gap before it are kept at any width;
    // the tool column and then the summary give way.
    const room = Math.max(0, e.props.bodyColumns - 4 - 2 - sizeWidth - 2)
    const toolWidth = Math.min(16, room, Math.max(4, ...list.map(row => row.tool.length)))
    const summaryWidth = Math.max(0, room - toolWidth - 2)

    const setAll = (isDropped: boolean) => update($, rows, all => all.map(row => ({ ...row, isDropped })))
    const toggle = (id: string) =>
      update($, rows, all => all.map(row => (row.id === id ? { ...row, isDropped: !row.isDropped } : row)))
    const apply = async () => {
      // Taking the rows empties them, so a second press finds nothing to do.
      let taken: OutputRow[] | undefined
      await update($, rows, all => {
        taken = all

        return []
      })

      if (taken === undefined || taken.length === 0) {
        return
      }
      const picked = taken.filter(row => row.isDropped)
      await $.ui.close({ id: PANE })
      $.ui.toast(await prune($, picked))
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Button key="apply" variant="primary" hotkey="y" label="Apply" onPress={apply} />
          <Text> </Text>
          <Button key="all" plain hotkey="a" label="all" onPress={() => setAll(true)} />
          <Text> </Text>
          <Button key="none" plain hotkey="n" label="none" onPress={() => setAll(false)} />
          <Text dimColor> · y apply · esc cancel</Text>
        </Box>
        <Text dimColor>
          dropping {marked.length} of {list.length} · {formatTokens(estimateTokens(chars))} tok
        </Text>
        {list.map((row, index) => (
          <Button
            key={`row:${row.id}`}
            plain
            autoFocus={index === 0 ? true : undefined}
            dimColor={!row.isDropped}
            onPress={() => toggle(row.id)}
          >
            {row.isDropped ? 'drop' : 'keep'}
            {'  '}
            {toolWidth > 0 ? `${oneLine(row.tool, toolWidth).padEnd(toolWidth)}  ` : ''}
            {summaryWidth > 0 ? `${oneLine(row.summary, summaryWidth).padEnd(summaryWidth)}  ` : ''}
            <Text dimColor>{(sizes[index] ?? '').padStart(sizeWidth)}</Text>
          </Button>
        ))}
      </Box>
    )
  })

  on('session.compact', { trigger: 'manual' }, async ($, e, next) => {
    if (e.instructions !== MARK || e.agentId !== undefined) {
      return next(e)
    }

    const ids = await read($, pending)

    if (ids === null) {
      return { skip: 'nothing to prune' }
    }

    const messages = applyDrop(e.messages, new Set(ids))
    await update($, pending, () => null)

    return { messages }
  }).catch(($, e, next) =>
    // The mod's own compaction never reaches the summarizer, whatever failed.
    e.instructions !== MARK || e.agentId !== undefined ? next(e) : { skip: 'prune failed' },
  )
}
