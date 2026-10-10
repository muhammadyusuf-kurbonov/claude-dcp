export type OutputRow = {
  id: string
  tool: string
  summary: string
  chars: number
  isDropped: boolean
}

declare module 'claude-code' {
  interface PluginState {
    dcp: { rows: OutputRow[]; pending: string[] | null }
  }
}
