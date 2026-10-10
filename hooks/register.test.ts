import type { On, SessionCompactResult, SessionMessage } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { STUB } from './prune'

const MESSAGES: SessionMessage[] = [
  { role: 'user', text: 'list files', toolUses: [], handle: 'h0' },
  {
    role: 'assistant',
    text: 'Looking.',
    handle: 'h1',
    toolUses: [{ tool_use_id: 'a', tool: 'Bash', input: { command: 'ls' }, text: 'x'.repeat(400) }],
  },
  {
    role: 'user',
    text: '',
    handle: 'h2',
    toolUses: [],
    toolResults: [{ tool_use_id: 'a', text: 'x'.repeat(400), isError: false }],
  },
]

const API = [
  { role: 'user' as const, content: [{ type: 'text', text: 'list files' }] },
  { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } }] },
  { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x'.repeat(400) }] },
]

const SUMMARY: SessionCompactResult = { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }

const RUN = {
  command: 'prune',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 120 },
} as const

const MARK = 'dcp-prune'

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

// What the engine's bottom does for a session's start, which the kit leaves out.
function bottom(on: On): void {
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e, next) => next(e))
}

test('/prune says how much goes, then runs /compact once it has returned', async ($, on) => {
  const clock = mock.clock(on)
  on('session.messages', () => ({ value: API }))
  let compacts = 0
  on('command.run', { command: 'compact' }, () => {
    compacts += 1

    return {}
  })

  const ran = await $.command.run({ ...RUN, args: '' })

  expect(ran.text).toBe('Dropping 1 tool output (~100 tokens).')
  expect(compacts).toBe(0)

  await clock.advance(1)

  expect(compacts).toBe(1)
})

test('the compaction a prune raises carries the stubs and runs no summary', async ($, on) => {
  const clock = mock.clock(on)
  on('session.messages', () => ({ value: API }))
  let summaries = 0
  on('session.compact', () => {
    summaries += 1

    return SUMMARY
  })
  let done: SessionCompactResult | undefined
  on('command.run', { command: 'compact' }, async (_$, e) => {
    done = await $.session.compact({ trigger: 'manual', instructions: e.args, messages: MESSAGES })

    return {}
  })

  await $.command.run({ ...RUN, args: '' })
  await clock.advance(1)

  expect(done?.messages?.[1]?.handle).toBe('h1')
  expect(done?.messages?.[2]?.toolResults?.[0]?.text).toBe(STUB)
  expect(done?.messages?.[0]?.handle).toBe('h0')
  expect(summaries).toBe(0)
})

test('the /compact after a prune is an ordinary one again', async ($, on) => {
  const clock = mock.clock(on)
  on('session.messages', () => ({ value: API }))
  on('session.compact', () => SUMMARY)
  on('command.run', { command: 'compact' }, async (_$, e) => {
    await $.session.compact({ trigger: 'manual', instructions: e.args, messages: MESSAGES })

    return {}
  })

  await $.command.run({ ...RUN, args: '' })
  await clock.advance(1)
  const later = await $.session.compact({ trigger: 'manual', messages: MESSAGES })

  expect(later.messages?.[0]?.text).toBe('summary')
})

test('a /compact that never compacts leaves no prune waiting', async ($, on) => {
  const clock = mock.clock(on)
  on('session.messages', () => ({ value: API }))
  on('session.compact', () => SUMMARY)
  on('command.run', { command: 'compact' }, () => ({}))

  await $.command.run({ ...RUN, args: '' })
  await clock.advance(1)
  const later = await $.session.compact({ trigger: 'manual', messages: MESSAGES })

  expect(later.messages?.[0]?.text).toBe('summary')
})

test('with nothing to drop it runs no /compact', async ($, on) => {
  const clock = mock.clock(on)
  on('session.messages', () => ({ value: [API[0]!] }))
  let compacts = 0
  on('command.run', { command: 'compact' }, () => {
    compacts += 1

    return {}
  })

  const ran = await $.command.run({ ...RUN, args: '' })
  await clock.advance(1)

  expect(ran.text).toBe('No tool outputs to drop.')
  expect(compacts).toBe(0)
})

test('an unknown argument prints usage', async $ => {
  const ran = await $.command.run({ ...RUN, args: 'everything' })

  expect(ran.text).toBe('Usage: /prune drops every tool output; /prune -i picks which.')
})

test('a compaction with nothing pending passes through', async ($, on) => {
  on('session.compact', () => SUMMARY)

  const manual = await $.session.compact({ trigger: 'manual', messages: MESSAGES })
  const auto = await $.session.compact({ trigger: 'auto', messages: MESSAGES })

  expect(manual.messages?.[0]?.text).toBe('summary')
  expect(auto.messages?.[0]?.text).toBe('summary')
})

test('while a prune waits, an automatic or a subagent compaction still summarizes', async ($, on) => {
  mock.clock(on)
  on('session.messages', () => ({ value: API }))
  on('session.compact', () => SUMMARY)

  await $.command.run({ ...RUN, args: '' })
  const auto = await $.session.compact({ trigger: 'auto', messages: MESSAGES })
  const sub = await $.session.compact({ trigger: 'manual', instructions: MARK, agentId: 'sub-1', messages: MESSAGES })

  expect(auto.messages?.[0]?.text).toBe('summary')
  expect(sub.messages?.[0]?.text).toBe('summary')
})

test('a prune that fails is skipped, never summarized', async ($, on) => {
  mock.clock(on)
  on('session.messages', () => ({ value: API }))
  let summaries = 0
  on('session.compact', () => {
    summaries += 1

    return SUMMARY
  })

  await $.command.run({ ...RUN, args: '' })
  // A message the rewrite throws on: one whose toolUses is null.
  const broken = [{ role: 'assistant', text: '', toolUses: null }] as unknown as SessionMessage[]
  const done = await $.session.compact({ trigger: 'manual', instructions: MARK, messages: broken })

  expect(done.skip).toBe('prune failed')
  expect(summaries).toBe(0)
})

test('a restart of the module forgets a prune that was waiting', async ($, on) => {
  bottom(on)
  mock.clock(on)
  on('session.messages', () => ({ value: API }))
  on('session.compact', () => SUMMARY)

  await $.command.run({ ...RUN, args: '' })
  await $.session.start(START)
  const later = await $.session.compact({ trigger: 'manual', messages: MESSAGES })

  expect(later.messages?.[0]?.text).toBe('summary')
})

test('in a headless session /prune says it cannot run', async ($, on) => {
  bottom(on)
  on('session.messages', () => ({ value: API }))
  await $.session.start({ ...START, surface: null, isInteractive: false })

  const ran = await $.command.run({ ...RUN, args: '' })

  expect(ran.text).toBe('/prune needs an interactive session.')
})

const TWO_API = [
  {
    role: 'assistant' as const,
    content: [
      { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: 'a.ts' } },
    ],
  },
  {
    role: 'user' as const,
    content: [
      { type: 'tool_result', tool_use_id: 'a', content: 'x'.repeat(400) },
      { type: 'tool_result', tool_use_id: 'b', content: 'y'.repeat(800) },
    ],
  },
]

const TWO: SessionMessage[] = [
  {
    role: 'assistant',
    text: '',
    handle: 'h1',
    toolUses: [
      { tool_use_id: 'a', tool: 'Bash', input: { command: 'ls' }, text: 'x'.repeat(400) },
      { tool_use_id: 'b', tool: 'Read', input: { file_path: 'a.ts' }, text: 'y'.repeat(800) },
    ],
  },
  {
    role: 'user',
    text: '',
    handle: 'h2',
    toolUses: [],
    toolResults: [
      { tool_use_id: 'a', text: 'x'.repeat(400), isError: false },
      { tool_use_id: 'b', text: 'y'.repeat(800), isError: false },
    ],
  },
]

const PANE = {
  plugin: 'dcp',
  component: 'Pane',
  requestId: 'prune',
  props: {
    title: 'Prune tool outputs',
    isFocused: true,
    bodyColumns: 80,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// What the engine's bottom does for a pane and a toast, which the kit leaves out.
function surface(on: On): { opened: string[]; closed: string[]; toasts: string[] } {
  const seen = { opened: [] as string[], closed: [] as string[], toasts: [] as string[] }
  on('ui.open', (_$, e) => {
    seen.opened.push(e.id)

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    seen.closed.push(e.id)

    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    seen.toasts.push(e.text)

    return { value: undefined }
  })

  return seen
}

for (const where of ['terminal', 'desktop'] as const) {
  test(`/prune -i lists every output marked to drop (${where})`, async ($, on) => {
    mock.clock(on)
    const seen = surface(on)
    on('session.messages', () => ({ value: TWO_API }))

    const ran = await $.command.run({ ...RUN, args: '-i' })
    const ui = await $.ui.mount({ ...PANE, surface: where })

    expect(ran.text).toBeUndefined()
    expect(seen.opened).toEqual(['prune'])
    expect((await ui.find({ key: 'row:a' }))?.text).toContain('drop')
    expect((await ui.find({ key: 'row:b' }))?.text).toContain('a.ts')
    expect(await ui.find({ type: 'Text', text: 'dropping 2 of 2 · ~300 tok' })).toBeDefined()
    await ui.unmount()
  })

  test(`a pressed row is kept, and Apply drops only the rest (${where})`, async ($, on) => {
    const clock = mock.clock(on)
    const seen = surface(on)
    on('session.messages', () => ({ value: TWO_API }))
    let done: SessionCompactResult | undefined
    on('command.run', { command: 'compact' }, async (_$, e) => {
      done = await $.session.compact({ trigger: 'manual', instructions: e.args, messages: TWO })

      return {}
    })

    await $.command.run({ ...RUN, args: '-i' })
    const ui = await $.ui.mount({ ...PANE, surface: where })
    await ui.press({ key: 'row:b' })

    expect((await ui.find({ key: 'row:b' }))?.text).toContain('keep')
    expect(await ui.find({ type: 'Text', text: 'dropping 1 of 2 · ~100 tok' })).toBeDefined()

    await ui.press({ key: 'apply' })
    await clock.advance(1)

    expect(done?.messages?.[1]?.toolResults?.map(result => result.text)).toEqual([STUB, 'y'.repeat(800)])
    expect(seen.closed).toEqual(['prune'])
    expect(seen.toasts).toEqual(['Dropping 1 tool output (~100 tokens).'])
    await ui.unmount()
  })

  test(`none keeps everything, all drops everything, and Apply on none drops nothing (${where})`, async ($, on) => {
    const clock = mock.clock(on)
    const seen = surface(on)
    on('session.messages', () => ({ value: TWO_API }))
    let compacts = 0
    on('command.run', { command: 'compact' }, () => {
      compacts += 1

      return {}
    })

    await $.command.run({ ...RUN, args: '-i' })
    const ui = await $.ui.mount({ ...PANE, surface: where })
    await ui.press({ key: 'none' })

    expect(await ui.find({ type: 'Text', text: 'dropping 0 of 2' })).toBeDefined()

    await ui.press({ key: 'all' })

    expect(await ui.find({ type: 'Text', text: 'dropping 2 of 2' })).toBeDefined()

    await ui.press({ key: 'none' })
    await ui.press({ key: 'apply' })
    await clock.advance(1)

    expect(compacts).toBe(0)
    expect(seen.toasts).toEqual(['No tool outputs to drop.'])
    await ui.unmount()
  })
}

test('/prune -i with nothing to drop opens no pane', async ($, on) => {
  const seen = surface(on)
  on('session.messages', () => ({ value: [] }))

  const ran = await $.command.run({ ...RUN, args: '-i' })

  expect(ran.text).toBe('No tool outputs to drop.')
  expect(seen.opened).toEqual([])
})

test('a row shows a long multi-line input as one cut line', async ($, on) => {
  mock.clock(on)
  surface(on)
  const heredoc = `cat <<EOF\n${'z'.repeat(5000)}\nEOF`
  on('session.messages', () => ({
    value: [
      { role: 'assistant' as const, content: [{ type: 'tool_use', id: 'h', name: 'Bash', input: { command: heredoc } }] },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'h', content: 'out' }] },
    ],
  }))

  await $.command.run({ ...RUN, args: '-i' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const row = (await ui.find({ key: 'row:h' }))?.text ?? ''

  expect(row).not.toContain('\n')
  expect(row.length).toBeLessThanOrEqual(80)
  expect(row).toContain('…')
  await ui.unmount()
})

test('two prunes before the first /compact run one compaction and no summary', async ($, on) => {
  const clock = mock.clock(on)
  on('session.messages', () => ({ value: API }))
  let summaries = 0
  on('session.compact', () => {
    summaries += 1

    return SUMMARY
  })
  let compacts = 0
  on('command.run', { command: 'compact' }, async (_$, e) => {
    compacts += 1
    await $.session.compact({ trigger: 'manual', instructions: e.args, messages: MESSAGES })

    return {}
  })

  await $.command.run({ ...RUN, args: '' })
  await $.command.run({ ...RUN, args: '' })
  await clock.advance(1)

  expect(compacts).toBe(1)
  expect(summaries).toBe(0)
})

test("the mod's own compaction with nothing to prune is skipped, never summarized", async ($, on) => {
  let summaries = 0
  on('session.compact', () => {
    summaries += 1

    return SUMMARY
  })

  const done = await $.session.compact({ trigger: 'manual', instructions: MARK, messages: MESSAGES })

  expect(done.skip).toBe('nothing to prune')
  expect(summaries).toBe(0)
})

test("the person's own /compact while a prune waits summarizes with its instructions, and the prune still lands", async ($, on) => {
  const clock = mock.clock(on)
  on('session.messages', () => ({ value: API }))
  const told: (string | undefined)[] = []
  on('session.compact', (_$, e) => {
    told.push(e.instructions)

    return SUMMARY
  })
  let done: SessionCompactResult | undefined
  on('command.run', { command: 'compact' }, async (_$, e) => {
    done = await $.session.compact({ trigger: 'manual', instructions: e.args, messages: MESSAGES })

    return {}
  })

  await $.command.run({ ...RUN, args: '' })
  const own = await $.session.compact({ trigger: 'manual', instructions: 'keep the plan', messages: MESSAGES })
  await clock.advance(1)

  expect(own.messages?.[0]?.text).toBe('summary')
  expect(told).toEqual(['keep the plan'])
  expect(done?.messages?.[2]?.toolResults?.[0]?.text).toBe(STUB)
})

test('Apply pressed twice prunes once', async ($, on) => {
  const clock = mock.clock(on)
  const seen = surface(on)
  on('session.messages', () => ({ value: TWO_API }))
  let compacts = 0
  on('command.run', { command: 'compact' }, () => {
    compacts += 1

    return {}
  })

  await $.command.run({ ...RUN, args: '-i' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await Promise.all([ui.press({ key: 'apply' }), ui.press({ key: 'apply' })])
  await clock.advance(1)

  expect(compacts).toBe(1)
  expect(seen.toasts).toEqual(['Dropping 2 tool outputs (~300 tokens).'])
  await ui.unmount()
})

test('the controls are drawn above the rows', async ($, on) => {
  mock.clock(on)
  surface(on)
  on('session.messages', () => ({ value: TWO_API }))

  await $.command.run({ ...RUN, args: '-i' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const keys = (await ui.findAll({ type: 'Button' })).map(button => button.key)

  expect(keys).toEqual(['apply', 'all', 'none', 'row:a', 'row:b'])
  await ui.unmount()
})

test('a row fits a narrow pane', async ($, on) => {
  mock.clock(on)
  surface(on)
  on('session.messages', () => ({
    value: [
      {
        role: 'assistant' as const,
        content: [{ type: 'tool_use', id: 'w', name: 'mcp__playwright__browser_navigate', input: { url: 'z'.repeat(90) } }],
      },
      { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 'w', content: 'q'.repeat(52000) }] },
    ],
  }))

  await $.command.run({ ...RUN, args: '-i' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 30 }, surface: 'terminal' })
  const row = (await ui.find({ key: 'row:w' }))?.text ?? ''

  expect(row.length).toBeLessThanOrEqual(30)
  expect(row).toContain('~13k tok')
  await ui.unmount()
})
