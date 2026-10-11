export type CheckSpec = { label: string; command: string }

export type CheckOutcome = { label: string; ok: boolean; output: string }

export type CheckRun = { at: number; ok: boolean; files: string[]; outcomes: CheckOutcome[] }

export type GitInfo = { dirty: number; lastCommitHours: number | null }

declare module 'claude-code' {
  interface PluginState {
    'change-check': {
      changed: string[]
      running: boolean
      last: CheckRun | null
      git: GitInfo | null
      dismissed: boolean
    }
  }
}
