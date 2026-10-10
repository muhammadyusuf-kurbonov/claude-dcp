import type { SessionMessage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import {
  STUB,
  applyDrop,
  estimateTokens,
  formatTokens,
  listOutputs,
  parseArgs,
  summarizeInput,
  summaryLine,
} from './prune'

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'list files', toolUses: [], handle: 'h0' },
  {
    role: 'assistant',
    text: 'Looking.',
    handle: 'h1',
    toolUses: [
      { tool_use_id: 'a', tool: 'Bash', input: { command: 'ls -la' }, text: 'x'.repeat(400), result: { stdout: 'x' } },
      { tool_use_id: 'b', tool: 'Read', input: { file_path: 'src/index.ts' }, text: 'y'.repeat(800) },
    ],
  },
  {
    role: 'user',
    text: '',
    handle: 'h2',
    toolUses: [],
    toolResults: [
      { tool_use_id: 'a', text: 'x'.repeat(400), isError: false, result: { stdout: 'x' } },
      { tool_use_id: 'b', text: 'y'.repeat(800), isError: false },
    ],
  },
  {
    role: 'assistant',
    text: 'Running.',
    handle: 'h3',
    toolUses: [{ tool_use_id: 'c', tool: 'Bash', input: { command: 'npm test' } }],
  },
]

describe('listOutputs', () => {
  test('lists answered calls oldest first, marked to drop', () => {
    expect(listOutputs(MESSAGES)).toEqual([
      { id: 'a', tool: 'Bash', summary: 'ls -la', chars: 400, isDropped: true },
      { id: 'b', tool: 'Read', summary: 'src/index.ts', chars: 800, isDropped: true },
    ])
  })

  test('skips a call still in flight', () => {
    expect(listOutputs(MESSAGES).some(row => row.id === 'c')).toBe(false)
  })

  test('skips an output already stubbed', () => {
    const pruned = applyDrop(MESSAGES, new Set(['a']))

    expect(listOutputs(pruned).map(row => row.id)).toEqual(['b'])
  })
})

describe('applyDrop', () => {
  test('stubs every chosen output on both sides of the pair', () => {
    const out = applyDrop(MESSAGES, new Set(['a', 'b']))

    expect(out[1]?.toolUses.map(u => u.text)).toEqual([STUB, STUB])
    expect(out[2]?.toolResults?.map(r => r.text)).toEqual([STUB, STUB])
  })

  test('keeps the call itself: tool, input and id', () => {
    const use = applyDrop(MESSAGES, new Set(['a']))[1]?.toolUses[0]

    expect(use?.tool).toBe('Bash')
    expect(use?.input).toEqual({ command: 'ls -la' })
    expect(use?.tool_use_id).toBe('a')
  })

  test('drops the stored record and the handle of a rewritten message', () => {
    const out = applyDrop(MESSAGES, new Set(['a']))

    expect(out[1]?.handle).toBeUndefined()
    expect(out[2]?.handle).toBeUndefined()
    expect(out[1]?.toolUses[0]?.result).toBeUndefined()
    expect(out[2]?.toolResults?.[0]?.result).toBeUndefined()
  })

  test('keeps the outputs not chosen in the same message', () => {
    const out = applyDrop(MESSAGES, new Set(['a']))

    expect(out[1]?.toolUses[1]?.text).toBe('y'.repeat(800))
    expect(out[2]?.toolResults?.[1]?.text).toBe('y'.repeat(800))
  })

  test('returns untouched messages as the same objects, handles included', () => {
    const out = applyDrop(MESSAGES, new Set(['a']))

    expect(out[0]).toBe(MESSAGES[0])
    expect(out[3]).toBe(MESSAGES[3])
  })

  test('an empty set changes nothing', () => {
    expect(applyDrop(MESSAGES, new Set())).toEqual(MESSAGES)
  })

  test('is idempotent', () => {
    const once = applyDrop(MESSAGES, new Set(['a', 'b']))

    expect(applyDrop(once, new Set(['a', 'b']))).toEqual(once)
  })

  test('keeps isError as it was', () => {
    const failed: SessionMessage[] = [
      { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e', tool: 'Bash', input: {}, text: 'boom', isError: true }] },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'e', text: 'boom', isError: true }] },
    ]
    const out = applyDrop(failed, new Set(['e']))

    expect(out[0]?.toolUses[0]?.isError).toBe(true)
    expect(out[1]?.toolResults?.[0]?.isError).toBe(true)
  })
})

describe('summarizeInput', () => {
  test('picks the field that names the call', () => {
    expect(summarizeInput('Bash', { command: 'ls -la', description: 'List' }, 40)).toBe('ls -la')
    expect(summarizeInput('Read', { file_path: 'a.ts' }, 40)).toBe('a.ts')
    expect(summarizeInput('Grep', { pattern: 'foo', path: 'src' }, 40)).toBe('foo')
  })

  test('falls back to the first string value, then to nothing', () => {
    expect(summarizeInput('mcp__x__y', { limit: 3, query: 'hello' }, 40)).toBe('hello')
    expect(summarizeInput('mcp__x__y', { limit: 3 }, 40)).toBe('')
  })

  test('shows one line, cut to width with an ellipsis', () => {
    const heredoc = `cat <<EOF\n${'z'.repeat(5000)}\nEOF`

    expect(summarizeInput('Bash', { command: heredoc }, 12)).toBe('cat <<EOF z…')
    expect(summarizeInput('Bash', { command: 'a\t b\n\nc' }, 40)).toBe('a b c')
  })
})

describe('tokens and summary', () => {
  test('estimates four characters to a token', () => {
    expect(estimateTokens(400)).toBe(100)
    expect(estimateTokens(0)).toBe(0)
  })

  test('formats with a tilde, and k from a thousand', () => {
    expect(formatTokens(950)).toBe('~950')
    expect(formatTokens(1234)).toBe('~1.2k')
    expect(formatTokens(38000)).toBe('~38k')
  })

  test('names the count and the size', () => {
    const rows = listOutputs(MESSAGES)

    expect(summaryLine(rows)).toBe('Dropped 2 tool outputs (~300 tokens).')
    expect(summaryLine(rows.slice(0, 1))).toBe('Dropped 1 tool output (~100 tokens).')
    expect(summaryLine([])).toBe('No tool outputs to drop.')
  })
})

describe('parseArgs', () => {
  test('reads the three forms', () => {
    expect(parseArgs('')).toBe('all')
    expect(parseArgs('  ')).toBe('all')
    expect(parseArgs('-i')).toBe('interactive')
    expect(parseArgs(' --interactive ')).toBe('interactive')
    expect(parseArgs('everything')).toBe('usage')
    expect(parseArgs('-i extra')).toBe('usage')
  })
})
