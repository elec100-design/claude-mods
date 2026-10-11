import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { describePlan, nextStep } from '../hooks/register'
import type { Plan } from '../types'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 },
} as const

function world(on: On, stored?: Record<string, unknown>) {
  mock.clock(on, { now: 1_000 })
  mock.store(on, stored)
  const submitted: { text: string; origin?: unknown }[] = []
  on('tool.register', async () => ({ value: undefined }) as never)
  on('prompt.submit', async (_$, e) => {
    submitted.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('prompt.compose', async () => ({ sections: [{ id: 'intro', text: 'You are Claude.', scope: 'shared' }] }) as never)
  on('session.start', async () => ({ cwd: '/proj' }) as never)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>CONTEXT-BAR</Text>
  })
  return { submitted }
}

async function start($: unknown, cwd = '/proj') {
  await ($ as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({ cwd, surface: 'terminal', isInteractive: true })
}

async function call($: unknown, tool: string, args: Record<string, unknown>) {
  return ($ as { tool: { call: (e: unknown) => Promise<{ text?: string; result?: unknown; deny?: string }> } }).tool.call({
    tool: `mcp__plan-track__${tool}`,
    tool_use_id: 'tu1',
    ...args,
  })
}

const sample: Plan = {
  title: 'LLM WIKI 개선',
  steps: [
    { label: 'P1 모순 찾기', status: 'done' },
    { label: 'P2 작업 전 조회', status: 'doing' },
    { label: 'P3 sources 복원', status: 'todo' },
  ],
  updatedAt: 1,
}

test('nextStep and describePlan', () => {
  expect(nextStep(sample)?.index).toBe(1)
  expect(nextStep({ ...sample, steps: sample.steps.map(s => ({ ...s, status: 'done' as const })) })).toBeNull()
  expect(describePlan(sample)).toContain('(1/3 done)')
  expect(describePlan(sample)).toContain('▶ 2. P2 작업 전 조회')
})

test('set and update a plan, shown above the other band', async ($, on) => {
  world(on)
  await start($)
  const r = await call($, 'set_plan', { title: 'LLM WIKI 개선', steps: ['P1 모순 찾기', 'P2 작업 전 조회', 'P3 sources 복원', 'P4 정리'] })
  expect(r.deny).toBeUndefined()
  await call($, 'update_plan', { step: 1, status: 'done', note: '19건 처리' })
  const u = await call($, 'update_plan', { step: 2, status: 'doing' })
  expect(String(u.result ?? u.text)).toContain('✔ 1. P1 모순 찾기 — 19건 처리')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'plan-track', surface, ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /LLM WIKI 개선/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\/4/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2\. P2 작업 전 조회/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CONTEXT-BAR/ })).toBeDefined()
    expect(await ui.find({ key: 'next' })).toBeDefined()
    await ui.unmount()
  }
})

test('bad updates are refused', async ($, on) => {
  world(on)
  await start($)
  expect((await call($, 'update_plan', { step: 1, status: 'done' })).deny).toContain('set_plan first')
  await call($, 'set_plan', { title: 't', steps: ['a', 'b'] })
  expect((await call($, 'update_plan', { step: 5, status: 'done' })).deny).toContain('1..2')
  expect((await call($, 'update_plan', { step: 1, status: 'finished' })).deny).toContain('status must be')
})

test('the next-step button asks for the next step in the user\'s words', async ($, on) => {
  const { submitted } = world(on)
  await start($)
  await call($, 'set_plan', { title: '송당 3단계 건축', steps: ['1단계 본관', '2단계 아트샵', '3단계 전시장'] })
  await call($, 'update_plan', { step: 1, status: 'done' })
  const ui = await $.ui.mount({ plugin: 'plan-track', surface: 'terminal', ...BAND } as never)
  await ui.press({ key: 'next' })
  expect(submitted.length).toBe(1)
  expect(submitted[0]!.text).toContain('2. 2단계 아트샵')
  expect((submitted[0]!.origin as { asUser?: boolean } | undefined)?.asUser).toBe(true)
  await ui.unmount()
})

test('no next button while a turn runs; close removes the plan', async ($, on) => {
  world(on)
  await start($)
  await call($, 'set_plan', { title: 't', steps: ['a'] })
  const busy = await $.ui.mount({ plugin: 'plan-track', surface: 'terminal', ...BAND, props: { ...BAND.props, isWorking: true } } as never)
  expect(await busy.find({ key: 'next' })).toBeUndefined()
  await busy.unmount()
  const ui = await $.ui.mount({ plugin: 'plan-track', surface: 'terminal', ...BAND } as never)
  await ui.press({ key: 'close' })
  expect(await ui.find({ type: 'Text', text: /계획/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /CONTEXT-BAR/ })).toBeDefined()
  await ui.unmount()
})

test('a new session in the same folder restores the plan and adds it to the prompt once', async ($, on) => {
  world(on, { plans: { '/proj': sample, '/other': { ...sample, title: 'other plan' } } })
  await start($, '/proj')
  const ui = await $.ui.mount({ plugin: 'plan-track', surface: 'desktop', ...BAND } as never)
  expect(await ui.find({ type: 'Text', text: /LLM WIKI 개선/ })).toBeDefined()
  await ui.unmount()

  const composed = await ($ as unknown as { prompt: { compose: (e: unknown) => Promise<{ sections: { id: string; text: string; scope: string }[] }> } }).prompt.compose({
    model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [],
  })
  const section = composed.sections.find(s => s.id === 'plan-track:plan')
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('▶ 2. P2 작업 전 조회')
  expect(composed.sections[0]!.id).toBe('intro')

  // A change mid-session leaves the prompt as it was, so the prompt cache holds.
  await call($, 'update_plan', { step: 2, status: 'done' })
  const again = await ($ as unknown as { prompt: { compose: (e: unknown) => Promise<{ sections: { id: string; text: string }[] }> } }).prompt.compose({
    model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [],
  })
  expect(again.sections.find(s => s.id === 'plan-track:plan')?.text).toBe(section?.text)
})
