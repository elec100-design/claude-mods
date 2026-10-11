export type CheckResult = { ok: boolean; exitCode: number; output: string }

export type UserAction = {
  id: string
  task: string
  steps: string
  check?: string
  successWhen?: string
  pollSec: number
  createdAt: number
  lastCheck?: CheckResult
}

declare module 'claude-code' {
  interface PluginState {
    handoff: { actions: UserAction[] }
  }
}
