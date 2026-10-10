import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { OutputRow } from '../types'
import { applyDrop, estimateTokens, formatTokens, listOutputs, oneLine, parseArgs, summaryLine } from './prune'

const USAGE = 'Usage: /prune drops every tool output; /prune -i picks which.'

const PANE = 'prune'

const rows = atom({ plugin: 'dcp', key: 'rows' } as const, [])
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
    const toolWidth = Math.min(16, Math.max(4, ...list.map(row => row.tool.length)))
    const sizeWidth = Math.max(0, ...sizes.map(size => size.length))
    // mark (4) and three two-cell gaps around tool, summary and size
    const summaryWidth = Math.max(8, e.props.bodyColumns - 4 - toolWidth - sizeWidth - 6)

    const setAll = (isDropped: boolean) => update($, rows, all => all.map(row => ({ ...row, isDropped })))
    const toggle = (id: string) =>
      update($, rows, all => all.map(row => (row.id === id ? { ...row, isDropped: !row.isDropped } : row)))
    const apply = async () => {
      const picked = (await read($, rows)).filter(row => row.isDropped)
      await $.ui.close({ id: PANE })
      $.ui.toast(await prune($, picked))
    }

    return (
      <Box flexDirection="column">
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
            {oneLine(row.tool, toolWidth).padEnd(toolWidth)}
            {'  '}
            {oneLine(row.summary, summaryWidth).padEnd(summaryWidth)}
            {'  '}
            <Text dimColor>{(sizes[index] ?? '').padStart(sizeWidth)}</Text>
          </Button>
        ))}
        <Text dimColor>
          dropping {marked.length} of {list.length} · {formatTokens(estimateTokens(chars))} tok
        </Text>
        <Box>
          <Button key="apply" variant="primary" label="Apply" onPress={apply} />
          <Text> </Text>
          <Button key="all" plain hotkey="a" label="all" onPress={() => setAll(true)} />
          <Text> </Text>
          <Button key="none" plain hotkey="n" label="none" onPress={() => setAll(false)} />
          <Text dimColor> · esc cancel</Text>
        </Box>
      </Box>
    )
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
