import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Plan, PlanStep, StepStatus } from '../types'

const TOOL_SET = 'mcp__plan-track__set_plan'
const TOOL_UPDATE = 'mcp__plan-track__update_plan'
const STORE_KEY = 'plans'
const STORE_LIMIT = 30
const STATUSES: readonly StepStatus[] = ['todo', 'doing', 'done', 'blocked']

const plan = atom({ plugin: 'plan-track', key: 'plan' } as const, null)

const SET_DESCRIPTION = [
  'Record a multi-step plan (phases P1..Pn, build stages, a migration checklist) so the user sees its progress above their',
  'prompt and can start the next step with one button. Call it when you propose or the user accepts a plan with 3 or more',
  'steps; calling it again replaces the plan. The plan is kept per project folder, so a later session in the same folder',
  'shows it too. Then keep it current with update_plan as steps start and finish.',
].join(' ')

const SET_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Short plan title in the user\'s language.' },
    steps: { type: 'array', items: { type: 'string' }, description: 'Step labels in order, short (e.g. "P1 모순 찾기").' },
  },
  required: ['title', 'steps'],
}

const UPDATE_DESCRIPTION = 'Mark a step of the current plan (set_plan) as doing, done, blocked or todo, optionally with a short note. Call it when you start a step and when you finish it.'

const UPDATE_SCHEMA = {
  type: 'object',
  properties: {
    step: { type: 'number', description: '1-based step number.' },
    status: { type: 'string', enum: STATUSES },
    note: { type: 'string', description: 'Optional short note (result, blocker).' },
  },
  required: ['step', 'status'],
}

export const GLYPH: Record<StepStatus, string> = { todo: '○', doing: '▶', done: '✔', blocked: '✘' }

export function nextStep(p: Plan): { index: number; step: PlanStep } | null {
  const i = p.steps.findIndex(s => s.status === 'doing' || s.status === 'todo')
  return i === -1 ? null : { index: i, step: p.steps[i]! }
}

// The plan as the model reads it, in a tool result or the session's opening prompt.
export function describePlan(p: Plan): string {
  const done = p.steps.filter(s => s.status === 'done').length
  const lines = p.steps.map((s, i) => `${GLYPH[s.status]} ${i + 1}. ${s.label}${s.note ? ` — ${s.note}` : ''}`)
  return [`Plan "${p.title}" (${done}/${p.steps.length} done):`, ...lines].join('\n')
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

// Plans are kept per project folder across sessions.
type Saved = Record<string, Plan>
let project = ''
// The plan as it stood when the session started: the only text this mod puts in
// the system prompt, fixed for the session so the prompt cache stays valid.
let openingSummary: string | null = null

async function loadSaved($: EngineInterface): Promise<Saved> {
  const v = await $.store.get(STORE_KEY)
  return v && typeof v === 'object' ? (v as Saved) : {}
}

async function save($: EngineInterface, next: Plan | null): Promise<void> {
  await update($, plan, () => next)
  if (!project) return
  const saved = await loadSaved($)
  if (next) saved[project] = next
  else delete saved[project]
  const kept = Object.entries(saved)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
    .slice(0, STORE_LIMIT)
  await $.store.set(STORE_KEY, Object.fromEntries(kept))
}

async function startNext($: EngineInterface): Promise<void> {
  const p = await read($, plan)
  const next = p && nextStep(p)
  if (!p || !next) return
  await $.prompt.submit({ text: `계획 "${p.title}"의 다음 단계 "${next.index + 1}. ${next.step.label}"를 진행해줘.`, asUser: true })
}

async function close($: EngineInterface): Promise<void> {
  await save($, null)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'set_plan', description: SET_DESCRIPTION, inputSchema: SET_SCHEMA, isDeferred: false })
    await $.tool.register({ name: 'update_plan', description: UPDATE_DESCRIPTION, inputSchema: UPDATE_SCHEMA, isDeferred: false })
    project = e.cwd
    let current = await read($, plan)
    if (current === null) {
      current = (await loadSaved($))[project] ?? null
      if (current) await update($, plan, () => current)
    }
    openingSummary = current && nextStep(current) ? describePlan(current) : null
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!openingSummary) return composed
    return {
      sections: [
        ...composed.sections,
        {
          id: 'plan-track:plan',
          scope: 'session' as const,
          text: `# Plan in progress for this project\n${openingSummary}\nKeep it current with update_plan.`,
        },
      ],
    }
  })

  on('tool.call', { tool: TOOL_SET }, async ($, e) => {
    // A tool's arguments sit beside `tool` on the event itself.
    const input = e as unknown as Record<string, unknown>
    const title = String(input.title ?? '').trim()
    const steps = Array.isArray(input.steps) ? input.steps.map(s => String(s).trim()).filter(Boolean) : []
    if (!title || steps.length === 0) return { deny: 'title and at least one step are required' }
    const p: Plan = { title, steps: steps.map(label => ({ label, status: 'todo' })), updatedAt: await $.clock.now() }
    await save($, p)
    return { result: `${describePlan(p)}\nShown to the user. Mark steps with update_plan as they start and finish.` }
  }).catch(($, e, next) => ({ deny: `plan-track failed: ${describeError(next.error)}` }))

  on('tool.call', { tool: TOOL_UPDATE }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const p = await read($, plan)
    if (!p) return { deny: 'No plan: call set_plan first.' }
    const index = Number(input.step) - 1
    const status = String(input.status) as StepStatus
    if (!Number.isInteger(index) || index < 0 || index >= p.steps.length) return { deny: `step must be 1..${p.steps.length}` }
    if (!STATUSES.includes(status)) return { deny: `status must be one of ${STATUSES.join(', ')}` }
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : undefined
    const steps = p.steps.map((s, i) => {
      if (i === index) return { label: s.label, status, ...(note ? { note } : s.note ? { note: s.note } : {}) }
      // One step runs at a time.
      return status === 'doing' && s.status === 'doing' ? { ...s, status: 'todo' as const } : s
    })
    const updated: Plan = { ...p, steps, updatedAt: await $.clock.now() }
    await save($, updated)
    return { result: describePlan(updated) }
  }).catch(($, e, next) => ({ deny: `plan-track failed: ${describeError(next.error)}` }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, plan)
    if (e.props.hasSurvey || p === null) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    // Other plugins' band (to-dos, the context bar) still draws beneath.
    const below = await next(e)
    const done = p.steps.filter(s => s.status === 'done').length
    const upcoming = nextStep(p)
    const color: Record<StepStatus, string> = { todo: 'inactive', doing: 'suggestion', done: 'success', blocked: 'error' }

    return (
      <Box flexDirection="column">
        <Box>
          <Box flexShrink={0}>
            <Text color="suggestion" bold>{'계획 '}</Text>
          </Box>
          <Box flexShrink={1}>
            <Text bold wrap="truncate-end">{`${p.title} `}</Text>
          </Box>
          <Box flexShrink={0}>
            {p.steps.map((s, i) => (
              <Text key={`s-${i}`} color={color[s.status]}>{GLYPH[s.status]}</Text>
            ))}
            <Text dimColor>{` ${done}/${p.steps.length} `}</Text>
          </Box>
          {upcoming ? (
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">{`· ${upcoming.index + 1}. ${upcoming.step.label} `}</Text>
            </Box>
          ) : (
            <Box flexShrink={0}>
              <Text color="success">{'· 모두 완료 '}</Text>
            </Box>
          )}
          {upcoming && !e.props.isWorking ? (
            <Box flexShrink={0}>
              <Button key="next" label={upcoming.step.status === 'doing' ? '계속' : '다음 단계'} onPress={() => startNext($)} />
              <Text> </Text>
            </Box>
          ) : null}
          <Box flexShrink={0}>
            <Button key="close" label={upcoming ? '×' : '닫기'} onPress={() => close($)} />
          </Box>
        </Box>
        {below}
      </Box>
    )
  })
}
