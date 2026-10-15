export type ContextRow = {
  name: string
  tokens: number
  color: string
  kind: 'used' | 'free' | 'buffer' | 'deferred'
}

export type ContextSnapshot = {
  total: number
  max: number
  percent: number
  rows: ContextRow[]
}

export type PendingPrompt = {
  text: string
  idleMinutes: number
  tokens: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-band': {
      snapshot: ContextSnapshot | null
      lastResponseAt: number | null
      now: number
      pending: PendingPrompt | null
      isWritingNote: boolean
      idle: { keeps: number; noted: boolean }
    }
  }
}
