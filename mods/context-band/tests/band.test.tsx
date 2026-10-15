import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { barCells, CACHE_TTL_MS, formatMinutes, formatTokens, idleStep, KEEP_PROMPT, statusText } from '../hooks/register'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 },
} as const

const TURN = {
  answer: 'done',
  durationMs: 10,
  isAborted: false,
  turnId: 't1',
  reason: 'end_turn',
  category: null,
  explanation: null,
} as never

// The engine beneath the plugin: a session `s1` whose context holds `total` tokens.
function world(on: On, total: number) {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const submitted: { text: string; origin?: unknown }[] = []
  const filled: string[] = []
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('session.id', async () => ({ value: 's1' }) as never)
  on('turn.complete', async () => ({ text: 'done' }) as never)
  on('prompt.submit', async (_$, e) => {
    submitted.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  on('session.usage', async () => ({ value: {
    startedAt: 0,
    rateLimits: [],
    context: {
      window: 1_000_000,
      breakdown: {
        categories: [
          { name: 'System prompt', tokens: 4_600, color: 'claude', isDeferred: false, kind: 'used' },
          { name: 'Messages', tokens: total - 4_600, color: 'success', isDeferred: false, kind: 'used' },
          { name: 'MCP tools (deferred)', tokens: 88_200, color: 'inactive', isDeferred: true, kind: 'deferred' },
          { name: 'Free space', tokens: 1_000_000 - total - 33_000, color: 'inactive', isDeferred: false, kind: 'free' },
          { name: 'Autocompact buffer', tokens: 33_000, color: 'warning', isDeferred: false, kind: 'buffer' },
        ],
        totalTokens: total,
        maxTokens: 1_000_000,
        rawMaxTokens: 1_000_000,
        autocompactSource: 'model-default',
        percentage: Math.round(total / 10_000),
        gridRows: [],
        model: 'claude-opus-5-5',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        isAutoCompactEnabled: true,
        apiUsage: null,
      },
    },
  } }) as never)
  return { clock, submitted, filled }
}

test('formats token counts and minutes', () => {
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(75_000)).toBe('75.0k')
  expect(formatTokens(1_000_000)).toBe('1.0M')
  expect(formatMinutes(42)).toBe('42분')
  expect(formatMinutes(133)).toBe('2시간 13분')
})

test('status line carries the figures and the cache countdown', () => {
  const snap = { total: 412_000, max: 1_000_000, percent: 41, rows: [] }
  expect(statusText(snap, null, 0)).toBe('Context 412.0k / 1.0M (41%)')
  expect(statusText(snap, 1_000, 1_000 + 23 * 60_000)).toBe('Context 412.0k / 1.0M (41%) · 캐시 37분')
  expect(statusText(snap, 1_000, 1_000 + CACHE_TTL_MS)).toBe('Context 412.0k / 1.0M (41%) · 캐시 만료')
})

test('bar cells fill the width exactly', () => {
  const rows = [
    { name: 'a', tokens: 4_600, color: 'claude', kind: 'used' as const },
    { name: 'b', tokens: 23_800, color: 'success', kind: 'used' as const },
    { name: 'Free space', tokens: 892_000, color: 'inactive', kind: 'free' as const },
    { name: 'buf', tokens: 33_000, color: 'warning', kind: 'buffer' as const },
  ]
  const cells = barCells(rows, 1_000_000, 60)
  expect(cells.reduce((a, b) => a + b, 0)).toBe(60)
  expect(cells.every(c => c >= 1)).toBe(true)
})

test('band shows totals, hover entries and the cache countdown after a turn', async ($, on) => {
  world(on, 28_400)
  await $.turn.complete(TURN)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'context-band', surface, ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /28\.4k \/ 1\.0M \(3%\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Messages 23\.8k · 2\.4%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Free space 938\.6k · 93\.9%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /캐시 60분/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a prompt within the cache window goes straight through', async ($, on) => {
  const { clock, submitted } = world(on, 250_000)
  await $.turn.complete(TURN)
  await clock.advance(30 * 60_000)

  const result = await $.prompt.submit({ text: 'next step', wait: false } as never)
  expect(result.drop).toBeUndefined()
  expect(submitted.map(s => s.text)).toEqual(['next step'])
})

test('a small context is not held even after expiry', async ($, on) => {
  const { clock, submitted } = world(on, 50_000)
  await $.turn.complete(TURN)
  await clock.advance(CACHE_TTL_MS + 60_000)

  const result = await $.prompt.submit({ text: 'hello', wait: false } as never)
  expect(result.drop).toBeUndefined()
  expect(submitted.length).toBe(1)
})

test('after expiry a large prompt is held, then sent on "send as is"', async ($, on) => {
  const { clock, submitted } = world(on, 250_000)
  await $.turn.complete(TURN)
  await clock.advance(2 * 60 * 60_000 + 13 * 60_000)

  const result = await $.prompt.submit({ text: 'continue', wait: false } as never)
  expect(result.drop).toContain('2시간 13분')
  expect(submitted.length).toBe(0)

  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'terminal', ...BAND } as never)
  expect(await ui.find({ type: 'Text', text: /캐시 만료/ })).toBeDefined()
  expect(await ui.find({ key: 'send' })).toBeDefined()
  await ui.press({ key: 'send' })
  expect(submitted.map(s => s.text)).toEqual(['continue'])
  expect(await ui.find({ key: 'send' })).toBeUndefined()
  await ui.unmount()
})

test('cancel puts the held prompt back without sending it', async ($, on) => {
  const { clock, submitted, filled } = world(on, 250_000)
  await $.turn.complete(TURN)
  await clock.advance(CACHE_TTL_MS + 60_000)
  await $.prompt.submit({ text: 'later', wait: false } as never)

  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND } as never)
  await ui.press({ key: 'cancel' })
  expect(submitted.length).toBe(0)
  expect(filled).toEqual(['later'])
  await ui.unmount()
})

test('a large context shows the compact button', async ($, on) => {
  world(on, 250_000)
  await $.turn.complete(TURN)
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'terminal', ...BAND } as never)
  expect(await ui.find({ key: 'compact' })).toBeDefined()
  await ui.unmount()
})

test('the handoff-note button writes Handoff.md, keeps the old one, and copies the first message', async ($, on) => {
  const { clock } = world(on, 250_000)
  const files: Record<string, string> = { '/proj/Handoff.md': 'old note' }
  const copied: string[] = []
  const asked: string[] = []
  on('session.start', async () => ({ cwd: '/proj' }) as never)
  on('model.fork', async (_$, e) => {
    asked.push((e as { prompt: string }).prompt)
    return { value: { isAnswered: true, text: '# 인계 노트\n## 목표\n모드 5종', usage: {} } } as never
  })
  on('fs.exists', async (_$, e) => ({ value: (e as { path: string }).path in files }) as never)
  on('fs.read', async (_$, e) => ({ value: files[(e as { path: string }).path] }) as never)
  on('fs.write', async (_$, e) => {
    const w = e as { path: string; text: string }
    files[w.path] = w.text
    return { value: undefined } as never
  })
  on('ui.copy', async (_$, e) => {
    copied.push((e as { text: string }).text)
    return { value: { isCopied: true } } as never
  })
  await ($ as unknown as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.turn.complete(TURN)

  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND } as never)
  await ui.press({ key: 'handoff-note' })
  await clock.settle()
  expect(asked[0]).toContain('인계 노트')
  expect(files['/proj/Handoff.md']).toContain('## 목표')
  expect(files['/proj/Handoff.prev.md']).toBe('old note')
  expect(copied[0]).toContain('/proj/Handoff.md')
  expect(await ui.find({ key: 'handoff-note' })).toBeDefined()
  await ui.unmount()
})

test('idle rule: keep warm while cheaper than lapsing, then note once, small contexts left alone', () => {
  // 400k context, 60k of it fixed: a keep costs 40k, a handoff ~184k, a rewrite 800k.
  const big = { total: 400_000, base: 60_000, noted: false }
  expect(idleStep({ ...big, keeps: 0 })).toBe('keep')
  expect(idleStep({ ...big, keeps: 3 })).toBe('keep')
  expect(idleStep({ ...big, keeps: 4 })).toBe('note')
  expect(idleStep({ ...big, keeps: 4, noted: true })).toBe('none')
  expect(idleStep({ ...big, keeps: -1 })).toBe('none')
  expect(idleStep({ total: 50_000, base: 30_000, keeps: 0, noted: false })).toBe('none')
})

test('near expiry while idle the cache is kept warm by a fork, then a note is written without touching the clipboard', async ($, on) => {
  const { clock } = world(on, 400_000)
  const asked: string[] = []
  const files: Record<string, string> = {}
  const copied: string[] = []
  on('session.start', async () => ({ cwd: '/proj' }) as never)
  on('model.fork', async (_$, e) => {
    const prompt = (e as { prompt: string }).prompt
    asked.push(prompt)
    const usage = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 399_000, cache_creation_input_tokens: 0 }
    return { value: { isAnswered: true, text: prompt === KEEP_PROMPT ? '.' : '# 인계 노트', usage } } as never
  })
  on('fs.exists', async () => ({ value: false }) as never)
  on('fs.write', async (_$, e) => {
    const w = e as { path: string; text: string }
    files[w.path] = w.text
    return { value: undefined } as never
  })
  on('ui.copy', async (_$, e) => {
    copied.push((e as { text: string }).text)
    return { value: { isCopied: true } } as never
  })
  await ($ as unknown as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.turn.complete(TURN)

  await clock.advance(50 * 60_000)
  await clock.settle()
  expect(asked.length).toBe(0)

  // Base here is the 4.6k system prompt: a handoff (~77k) costs less than two keeps (40k each).
  await clock.advance(6 * 60_000)
  await clock.settle()
  expect(asked).toEqual([KEEP_PROMPT])
  const band = await $.ui.mount({ plugin: 'context-band', surface: 'terminal', ...BAND } as never)
  expect(await band.find({ type: 'Text', text: /유지 1회/ })).toBeDefined()
  await band.unmount()

  await clock.advance(56 * 60_000)
  await clock.settle()
  expect(asked.length).toBe(2)
  expect(asked[1]).toContain('인계 노트')
  expect(files['/proj/Handoff.md']).toContain('인계 노트')
  expect(copied.length).toBe(0)

  // Nothing more once the note is written and the cache lapses.
  await clock.advance(3 * 60 * 60_000)
  await clock.settle()
  expect(asked.length).toBe(2)

  // Back after expiry: the held prompt offers the new session.
  await $.prompt.submit({ text: 'continue', wait: false } as never)
  const ui = await $.ui.mount({ plugin: 'context-band', surface: 'desktop', ...BAND } as never)
  await ui.press({ key: 'copy-handoff' })
  expect(copied[0]).toContain('/proj/Handoff.md')
  await ui.unmount()
})
