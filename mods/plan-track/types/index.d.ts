export type StepStatus = 'todo' | 'doing' | 'done' | 'blocked'

export type PlanStep = { label: string; status: StepStatus; note?: string }

export type Plan = { title: string; steps: PlanStep[]; updatedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'plan-track': { plan: Plan | null }
  }
}
