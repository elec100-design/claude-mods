import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { judge, lastLine, MAX_ERROR_STREAK } from '../hooks/register'
import type { Job } from '../types'

const PANE = { component: 'Pane', requestId: 'job-watch', props: {} } as const

// The host beneath the plugin. `output` is what the check command prints next.
function world(on: On) {
  const clock = mock.clock(on, { now: 0 })
  const host = { output: 'hashed 10', exitCode: 0, runs: [] as string[] }
  const submitted: string[] = []
  const toasts: string[] = []
  const status: (string | undefined)[] = []
  on('process.run', async (_$, e) => {
    host.runs.push((e as { argv: string[] }).argv.join(' '))
    return { value: { exitCode: host.exitCode, stdout: host.output, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('tool.register', async () => ({ value: undefined }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', async (_$, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('ui.toast', async (_$, e) => {
    toasts.push(String((e as { text?: string }).text ?? ''))
    return { value: undefined } as never
  })
  on('ui.notify', async () => ({ value: { isSent: true, channel: 'test' } }) as never)
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', async () => ({ cwd: '/tmp' }) as never)
  return { clock, host, submitted, toasts, status }
}

async function start($: unknown) {
  await ($ as never as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({
    cwd: '/tmp',
    surface: 'terminal',
    isInteractive: true,
  })
}

async function watch($: unknown, input: Record<string, unknown>) {
  return ($ as never as { tool: { call: (e: unknown) => Promise<{ text?: string; result?: unknown; deny?: string }> } }).tool.call({
    tool: 'mcp__job-watch__watch_job',
    tool_use_id: "tu1",
    ...input,
  })
}

const base: Job = {
  id: 'j', name: 'n', command: 'c', intervalSec: 60, notifyModel: true, startedAt: 0, deadline: 1e12,
  status: 'running', lastLine: '', lastCheckAt: 0, checks: 0, errorStreak: 0,
}

test('judge reads done, fail and error streaks', () => {
  expect(judge({ ...base, doneWhen: 'ALL DONE' }, 'x\nALL DONE\n', 0).status).toBe('done')
  expect(judge({ ...base, failWhen: 'ABORT' }, 'ABORT: only 3 files', 0).status).toBe('failed')
  expect(judge(base, 'boom', 1)).toEqual({ status: 'running', errorStreak: 1 })
  expect(judge({ ...base, errorStreak: MAX_ERROR_STREAK - 1 }, 'boom', 255).status).toBe('failed')
  expect(lastLine('a\nb\n\n  \n')).toBe('b')
})

test('a watched job is polled without the model and reported once done', async ($, on) => {
  const { clock, host, submitted, status } = world(on)
  await start($)
  const r = await watch($, { name: 'photo-hash', command: "ssh nas 'tail -1 hash.log'", done_when: 'ALL DONE', interval_seconds: 60 })
  await clock.settle()
  expect(r.deny).toBeUndefined()
  expect(host.runs.length).toBe(1)
  expect(host.runs[0]).toContain("tail -1 hash.log")
  expect(status.at(-1)).toContain('photo-hash')

  host.output = 'hashed 500'
  await clock.advance(60_000)
  expect(host.runs.length).toBe(2)
  expect(submitted.length).toBe(0)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'job-watch', surface, ...PANE } as never)
    expect(await ui.find({ type: 'Text', text: /hashed 500/ })).toBeDefined()
    await ui.unmount()
  }

  host.output = 'hashed 900\nALL DONE'
  await clock.advance(60_000)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('photo-hash')
  expect(submitted[0]).toContain('완료')
  expect(submitted[0]).toContain('ALL DONE')
  expect(status.at(-1)).toBeUndefined()

  await clock.advance(5 * 60_000)
  expect(host.runs.length).toBe(3)
})

test('a check that keeps failing ends the job as failed', async ($, on) => {
  const { clock, host, submitted } = world(on)
  await start($)
  host.exitCode = 255
  host.output = 'ssh: connect to host nas port 22: Operation timed out'
  await watch($, { name: 'backup', command: 'ssh nas true', interval_seconds: 30 })
  await clock.advance(30_000)
  expect(submitted.length).toBe(0)
  await clock.advance(30_000)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('실패')
  expect(submitted[0]).toContain(`${MAX_ERROR_STREAK}번 연속`)
})

test('the stop button ends a job without messaging the model', async ($, on) => {
  const { clock, host, submitted } = world(on)
  await start($)
  await watch($, { name: 'ingest', command: 'tail -1 log', interval_seconds: 30 })
  await clock.settle()
  const ui = await $.ui.mount({ plugin: 'job-watch', surface: 'terminal', ...PANE } as never)
  const stopKey = (await ui.find({ type: 'Button' })) as { key?: string } | undefined
  expect(stopKey?.key).toBeDefined()
  await ui.press({ key: stopKey!.key! })
  await clock.advance(5 * 60_000)
  expect(host.runs.length).toBe(1)
  expect(submitted.length).toBe(0)
  expect(await ui.find({ type: 'Text', text: /중지/ })).toBeDefined()
  await ui.unmount()
})

test('a bad regex is refused', async ($, on) => {
  world(on)
  await start($)
  const r = await watch($, { name: 'x', command: 'true', done_when: '(' })
  expect(r.deny ?? r.text).toContain('not a valid regex')
})
