export type JobStatus = 'running' | 'done' | 'failed' | 'stopped' | 'timeout'

export type Job = {
  id: string
  name: string
  command: string
  intervalSec: number
  doneWhen?: string
  failWhen?: string
  notifyModel: boolean
  startedAt: number
  deadline: number
  status: JobStatus
  lastLine: string
  lastCheckAt: number
  checks: number
  errorStreak: number
  endedAt?: number
}

declare module 'claude-code' {
  interface PluginState {
    'job-watch': { jobs: Job[] }
  }
}
