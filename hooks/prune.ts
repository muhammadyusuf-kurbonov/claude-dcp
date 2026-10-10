import type { SessionMessage } from 'claude-code'

import type { OutputRow } from '../types'

export const STUB = '[tool output dropped by /prune]'

const NAMING_FIELDS = ['command', 'file_path', 'pattern', 'url', 'query', 'prompt']

export function oneLine(text: string, width: number): string {
  const line = Array.from(text.replace(/\s+/g, ' ').trim())

  return line.length > width ? `${line.slice(0, Math.max(0, width - 1)).join('')}…` : line.join('')
}

export function summarizeInput(tool: string, input: Record<string, unknown>, width: number): string {
  const named = NAMING_FIELDS.map(field => input[field]).find(value => typeof value === 'string')
  const picked = named ?? Object.values(input).find(value => typeof value === 'string') ?? ''

  return oneLine(String(picked), width)
}

// The conversation in Messages API form, as `$.session.messages({ as: 'api' })`
// answers it: unlike the rows, it holds only what the next request sends.
export type ApiRow = { role: string; content: { type: string; [field: string]: unknown }[] }

function textOf(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return ''
  }

  return content.map(block => (block?.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('')
}

export function listOutputs(messages: readonly ApiRow[]): OutputRow[] {
  const blocks = messages.flatMap(message => message.content)
  const results = new Map(
    blocks
      .filter(block => block.type === 'tool_result')
      .map(block => [String(block.tool_use_id), textOf(block.content)]),
  )

  return blocks
    .filter(block => block.type === 'tool_use')
    .flatMap(block => {
      const text = results.get(String(block.id))

      if (text === undefined || text === STUB) {
        return []
      }
      const input = (block.input ?? {}) as Record<string, unknown>

      return [
        {
          id: String(block.id),
          tool: String(block.name),
          summary: summarizeInput(String(block.name), input, 200),
          chars: text.length,
          isDropped: true,
        },
      ]
    })
}

// Only the rows holding the results are rewritten. A call's own row goes back
// whole: parallel calls are rows the engine merges by their handles, and a
// rebuilt one splits the group and orphans its siblings' results.
export function applyDrop(messages: readonly SessionMessage[], ids: ReadonlySet<string>): SessionMessage[] {
  return messages.map(message => {
    const results = message.toolResults ?? []

    if (!results.some(result => ids.has(result.tool_use_id) && result.text !== STUB)) {
      return message
    }

    return {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses,
      toolResults: results.map(result => {
        if (!ids.has(result.tool_use_id)) {
          return result
        }
        const { result: _result, ...kept } = result

        return { ...kept, text: STUB }
      }),
    }
  })
}

export function estimateTokens(chars: number): number {
  return Math.round(chars / 4)
}

export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return `~${tokens}`
  }

  return `~${(tokens / 1000).toFixed(tokens < 10000 ? 1 : 0).replace(/\.0$/, '')}k`
}

export function summaryLine(rows: readonly OutputRow[]): string {
  if (rows.length === 0) {
    return 'No tool outputs to drop.'
  }
  const chars = rows.reduce((sum, row) => sum + row.chars, 0)
  const noun = rows.length === 1 ? 'tool output' : 'tool outputs'

  return `Dropping ${rows.length} ${noun} (${formatTokens(estimateTokens(chars))} tokens).`
}

export function parseArgs(args: string): 'all' | 'interactive' | 'usage' {
  const trimmed = args.trim()

  if (trimmed === '') {
    return 'all'
  }

  return trimmed === '-i' || trimmed === '--interactive' ? 'interactive' : 'usage'
}
