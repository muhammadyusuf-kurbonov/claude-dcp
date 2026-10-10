import type { EngineInterface, Register } from 'claude-code'

const STUB = '[tool output dropped by /prune]'
const OUT = '/tmp/claude-1000/-home-muhammadyusuf-kurbonov-Projects-MyProjects-claude-dcp/685d6bce-9814-49b0-ad62-a54b629570bf/scratchpad/probe1/result'
let isProbing = false

async function run($: EngineInterface, source: string) {
  let line: string
  try {
    const done = await $.session.compact()
    line = `${source}: ${JSON.stringify(Object.keys(done))} ${done.messages?.length ?? done.skip}`
  } catch (error) {
    line = `${source} threw: ${String(error)}`
  } finally {
    isProbing = false
  }
  $.ui.log(line)
  await $.fs.write(`${OUT}-${source}.txt`, line)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'prune', description: 'Probe: stub every tool output' })

    return next(e)
  })

  on('command.run', { command: 'prune' }, async ($, e) => {
    isProbing = true
    const mode = e.args.trim()
    $.clock.after(0, () => {
      void (async () => {
        let line: string
        try {
          const done =
            mode === 'submit'
              ? await $.prompt.submit({ text: '/compact', asUser: true })
              : await $.command.run({ command: 'compact', args: '' })
          line = `${mode}: ${JSON.stringify(done)}`
        } catch (error) {
          line = `${mode} threw: ${String(error)}`
        }
        $.ui.log(line)
        await $.fs.write(`${OUT}-via-${mode}.txt`, line)
      })()
    })

    return { text: 'probe scheduled' }
  })

  on('prompt.submit', ($, e, next) => {
    if (e.text.includes('PRUNE_AFTER_TURN')) {
      isProbing = true
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (isProbing) {
      await run($, 'turn')
    }

    return done
  })

  on('session.compact', async ($, e, next) => {
    await $.fs.write(`${OUT}-compact-${e.trigger}.txt`, JSON.stringify(e, null, 1))
    if (!isProbing) {
      return next(e)
    }

    const messages = e.messages.map(m => {
      const hasResult = (m.toolResults?.length ?? 0) > 0 || m.toolUses.some(u => u.text !== undefined)

      if (!hasResult) {
        return m
      }

      return {
        role: m.role,
        text: m.text,
        toolUses: m.toolUses.map(({ result: _r, ...u }) => (u.text === undefined ? u : { ...u, text: STUB })),
        toolResults: m.toolResults?.map(({ result: _r, ...r }) => ({ ...r, text: STUB })),
      }
    })

    isProbing = false
    await $.fs.write(`${OUT}-hook-answered.txt`, e.trigger)

    return { messages }
  })
}
