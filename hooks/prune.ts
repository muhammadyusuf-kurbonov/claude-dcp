import type { SessionMessage } from 'claude-code'

import type { OutputRow } from '../types'

export const STUB = '[tool output dropped by /prune]'

const NAMING_FIELDS = ['command', 'file_path', 'pattern', 'url', 'query', 'prompt']

export function summarizeInput(tool: string, input: Record<string, unknown>, width: number): string {
  const named = NAMING_FIELDS.map(field => input[field]).find(value => typeof value === 'string')
  const picked = named ?? Object.values(input).find(value => typeof value === 'string') ?? ''
  const line = String(picked).replace(/\s+/g, ' ').trim()

  return line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line
}

export function listOutputs(messages: readonly SessionMessage[]): OutputRow[] {
  return messages.flatMap(message =>
    message.toolUses
      .filter(use => use.text !== undefined && use.text !== STUB)
      .map(use => ({
        id: use.tool_use_id,
        tool: use.tool,
        summary: summarizeInput(use.tool, use.input, 200),
        chars: use.text?.length ?? 0,
        isDropped: true,
      })),
  )
}

export function applyDrop(messages: readonly SessionMessage[], ids: ReadonlySet<string>): SessionMessage[] {
  return messages.map(message => {
    const isTouched =
      message.toolUses.some(use => ids.has(use.tool_use_id) && use.text !== undefined && use.text !== STUB) ||
      (message.toolResults ?? []).some(result => ids.has(result.tool_use_id) && result.text !== STUB)

    if (!isTouched) {
      return message
    }

    const rebuilt: SessionMessage = {
      role: message.role,
      text: message.text,
      toolUses: message.toolUses.map(use => {
        if (!ids.has(use.tool_use_id) || use.text === undefined) {
          return use
        }
        const { result: _result, ...kept } = use

        return { ...kept, text: STUB }
      }),
    }

    if (message.toolResults !== undefined) {
      rebuilt.toolResults = message.toolResults.map(result => {
        if (!ids.has(result.tool_use_id)) {
          return result
        }
        const { result: _result, ...kept } = result

        return { ...kept, text: STUB }
      })
    }

    return rebuilt
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

  return `Dropped ${rows.length} ${noun} (${formatTokens(estimateTokens(chars))} tokens).`
}

export function parseArgs(args: string): 'all' | 'interactive' | 'usage' {
  const trimmed = args.trim()

  if (trimmed === '') {
    return 'all'
  }

  return trimmed === '-i' || trimmed === '--interactive' ? 'interactive' : 'usage'
}
