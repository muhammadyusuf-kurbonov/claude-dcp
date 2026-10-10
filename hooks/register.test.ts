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
  on('command.run', { command: 'compact' }, async () => {
    done = await $.session.compact({ trigger: 'manual', messages: MESSAGES })

    return {}
  })

  await $.command.run({ ...RUN, args: '' })
  await clock.advance(1)

  expect(done?.messages?.[1]?.toolUses[0]?.text).toBe(STUB)
  expect(done?.messages?.[2]?.toolResults?.[0]?.text).toBe(STUB)
  expect(done?.messages?.[0]?.handle).toBe('h0')
  expect(summaries).toBe(0)
})

test('the /compact after a prune is an ordinary one again', async ($, on) => {
  const clock = mock.clock(on)
  on('session.messages', () => ({ value: API }))
  on('session.compact', () => SUMMARY)
  on('command.run', { command: 'compact' }, async () => {
    await $.session.compact({ trigger: 'manual', messages: MESSAGES })

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
  const sub = await $.session.compact({ trigger: 'manual', agentId: 'sub-1', messages: MESSAGES })

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
  const done = await $.session.compact({ trigger: 'manual', messages: broken })

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
