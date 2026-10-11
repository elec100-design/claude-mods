import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Job, JobStatus } from '../types'

const PANE = 'job-watch'
const TOOL_WATCH = 'mcp__job-watch__watch_job'
const TOOL_STOP = 'mcp__job-watch__stop_job'
const MIN_INTERVAL_SEC = 15
const DEFAULT_INTERVAL_SEC = 60
const DEFAULT_TIMEOUT_MIN = 24 * 60
// A check that fails this many times in a row ends the job as failed.
export const MAX_ERROR_STREAK = 3
const CHECK_TIMEOUT_MS = 60_000
const KEEP_ENDED = 10

const jobs = atom({ plugin: 'job-watch', key: 'jobs' } as const, [])

const WATCH_DESCRIPTION = [
  'Watch a long-running job (a remote copy, hashing, ingest, backup, build) without polling it yourself.',
  'Use this INSTEAD of sleep loops, `until` loops or Monitor when you only need to know when a job finishes or fails.',
  'Give a shell command that prints the job\'s current state (for example `ssh nas \'tail -1 ~/job.log\'`),',
  'and regexes that mean done or failed. The plugin runs the command every interval_seconds with no model calls,',
  'shows progress to the user, and sends you one message when the job is done, failed, its check errors',
  `${MAX_ERROR_STREAK} times in a row, or it times out. After calling this, end your turn and wait for that message.`,
].join(' ')

const WATCH_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short label shown to the user.' },
    command: { type: 'string', description: 'Shell command (run with /bin/sh -c) that prints the job state. Keep it fast.' },
    done_when: { type: 'string', description: 'Regex; the job is done when the output matches it.' },
    fail_when: { type: 'string', description: 'Regex; the job failed when the output matches it.' },
    interval_seconds: { type: 'number', description: `Seconds between checks (min ${MIN_INTERVAL_SEC}, default ${DEFAULT_INTERVAL_SEC}).` },
    timeout_minutes: { type: 'number', description: `Give up after this many minutes (default ${DEFAULT_TIMEOUT_MIN}).` },
    notify_model: { type: 'boolean', description: 'Send you a message when it ends (default true).' },
  },
  required: ['name', 'command'],
}

const STOP_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string', description: 'The watched job\'s name.' } },
  required: ['name'],
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

export function lastLine(output: string): string {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

export function formatElapsed(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}분`
  const h = Math.floor(min / 60)
  return `${h}시간 ${min % 60}분`
}

// What one check's output means for the job: still running, or how it ended.
export function judge(job: Job, output: string, exitCode: number): { status: JobStatus; errorStreak: number } {
  if (job.failWhen && new RegExp(job.failWhen, 'm').test(output)) return { status: 'failed', errorStreak: 0 }
  if (job.doneWhen && new RegExp(job.doneWhen, 'm').test(output)) return { status: 'done', errorStreak: 0 }
  if (exitCode !== 0) {
    const errorStreak = job.errorStreak + 1
    return { status: errorStreak >= MAX_ERROR_STREAK ? 'failed' : 'running', errorStreak }
  }
  return { status: 'running', errorStreak: 0 }
}

const LABEL: Record<JobStatus, string> = {
  running: '실행 중',
  done: '완료',
  failed: '실패',
  stopped: '중지',
  timeout: '시간 초과',
}

const timers = new Map<string, { cancel: () => void }>()
const inFlight = new Set<string>()

async function setStatusLine($: EngineInterface): Promise<void> {
  const running = (await read($, jobs)).filter(j => j.status === 'running')
  $.ui.status(running.length > 0 ? `작업 감시 ${running.length}개: ${running.map(j => j.name).join(', ')}` : undefined)
}

function arm($: EngineInterface, job: Job): void {
  timers.get(job.id)?.cancel()
  timers.set(job.id, $.clock.every(job.intervalSec * 1000, () => void check($, job.id)))
}

async function finish($: EngineInterface, job: Job): Promise<void> {
  timers.get(job.id)?.cancel()
  timers.delete(job.id)
  await setStatusLine($)
  if (job.status === 'stopped') return
  const head = `작업 "${job.name}" ${LABEL[job.status]} (${formatElapsed((job.endedAt ?? job.startedAt) - job.startedAt)})`
  $.ui.toast(head)
  void $.ui.notify(`${head}\n${job.lastLine}`, { title: '작업 감시' }).catch(() => undefined)
  if (job.notifyModel) {
    const why =
      job.status === 'timeout' ? '감시 시간이 끝났습니다.'
      : job.status === 'failed' && job.errorStreak >= MAX_ERROR_STREAK ? `확인 명령이 ${MAX_ERROR_STREAK}번 연속 실패했습니다.`
      : ''
    await $.prompt.submit({
      text: [`[job-watch] ${head}. ${why}`.trim(), `확인 명령: ${job.command}`, `마지막 출력: ${job.lastLine || '(없음)'}`].join('\n'),
    })
  }
}

async function check($: EngineInterface, id: string): Promise<void> {
  if (inFlight.has(id)) return
  const job = (await read($, jobs)).find(j => j.id === id)
  if (!job || job.status !== 'running') return
  inFlight.add(id)
  try {
    let output = ''
    let exitCode = 0
    try {
      const ran = await $.process.run(['/bin/sh', '-c', job.command], { timeoutMs: CHECK_TIMEOUT_MS })
      output = `${ran.stdout}\n${ran.stderr}`
      exitCode = ran.exitCode
    } catch (err) {
      output = String(err)
      exitCode = 1
    }
    const now = await $.clock.now()
    const verdict = judge(job, output, exitCode)
    const status: JobStatus = verdict.status === 'running' && now >= job.deadline ? 'timeout' : verdict.status
    const next: Job = {
      ...job,
      status,
      errorStreak: verdict.errorStreak,
      lastLine: lastLine(output) || job.lastLine,
      lastCheckAt: now,
      checks: job.checks + 1,
      ...(status !== 'running' ? { endedAt: now } : {}),
    }
    await update($, jobs, list => list.map(j => (j.id === id ? next : j)))
    if (status !== 'running') await finish($, next)
  } finally {
    inFlight.delete(id)
  }
}

async function stop($: EngineInterface, id: string): Promise<Job | undefined> {
  const now = await $.clock.now()
  let stopped: Job | undefined
  await update($, jobs, list =>
    list.map(j => {
      if (j.id !== id || j.status !== 'running') return j
      stopped = { ...j, status: 'stopped', endedAt: now }
      return stopped
    }),
  )
  if (stopped) await finish($, stopped)
  return stopped
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'watch_job', description: WATCH_DESCRIPTION, inputSchema: WATCH_SCHEMA, isDeferred: false })
    await $.tool.register({ name: 'stop_job', description: 'Stop watching a job registered with watch_job.', inputSchema: STOP_SCHEMA })
    await $.command.register({ name: 'jobs', description: '감시 중인 작업 창을 엽니다' })
    // A reload keeps the jobs in state but not the timers: re-arm them.
    for (const job of await read($, jobs)) {
      if (job.status === 'running') arm($, job)
    }
    await setStatusLine($)
    return next(e)
  })

  on('tool.call', { tool: TOOL_WATCH }, async ($, e) => {
    const input = e as unknown as Record<string, unknown>
    const name = String(input.name ?? '').trim()
    const command = String(input.command ?? '').trim()
    if (!name || !command) return { deny: 'name and command are required' }
    for (const key of ['done_when', 'fail_when'] as const) {
      const pattern = input[key]
      if (typeof pattern === 'string') {
        try {
          new RegExp(pattern)
        } catch {
          return { deny: `${key} is not a valid regex: ${pattern}` }
        }
      }
    }
    const now = await $.clock.now()
    const intervalSec = Math.max(MIN_INTERVAL_SEC, Number(input.interval_seconds) || DEFAULT_INTERVAL_SEC)
    const job: Job = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name,
      command,
      intervalSec,
      ...(typeof input.done_when === 'string' ? { doneWhen: input.done_when } : {}),
      ...(typeof input.fail_when === 'string' ? { failWhen: input.fail_when } : {}),
      notifyModel: input.notify_model !== false,
      startedAt: now,
      deadline: now + (Number(input.timeout_minutes) || DEFAULT_TIMEOUT_MIN) * 60_000,
      status: 'running',
      lastLine: '',
      lastCheckAt: 0,
      checks: 0,
      errorStreak: 0,
    }
    // A job of the same name replaces the running one; ended jobs are trimmed.
    const same = (await read($, jobs)).find(j => j.name === name && j.status === 'running')
    if (same) await stop($, same.id)
    await update($, jobs, list => {
      const running = list.filter(j => j.status === 'running')
      const ended = list.filter(j => j.status !== 'running').slice(-KEEP_ENDED)
      return [...ended, ...running, job]
    })
    arm($, job)
    // The first check runs after the call is answered: a slow command (ssh)
    // must not hold the tool call past its hook budget.
    $.clock.after(0, () => void check($, job.id))
    void $.ui.open({ id: PANE, title: '작업 감시' })
    await setStatusLine($)
    return {
      result: `Watching "${name}" (checking every ${intervalSec}s). End your turn; you will get a message when it ends.`,
    }
  }).catch(($, e, next) => ({ deny: `job-watch failed: ${describeError(next.error)}` }))

  on('tool.call', { tool: TOOL_STOP }, async ($, e) => {
    const name = String((e as unknown as Record<string, unknown>).name ?? "")
    const job = (await read($, jobs)).find(j => j.name === name && j.status === 'running')
    if (!job) return { deny: `No running job named "${name}"` }
    await stop($, job.id)
    return { result: `Stopped watching "${name}".` }
  }).catch(($, e, next) => ({ deny: `job-watch failed: ${describeError(next.error)}` }))

  on('command.run', { command: 'jobs' }, async $ => {
    await $.ui.open({ id: PANE, title: '작업 감시' })
    const running = (await read($, jobs)).filter(j => j.status === 'running').length
    return { text: running > 0 ? `감시 중인 작업 ${running}개` : '감시 중인 작업이 없습니다.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, jobs)
    const now = await $.clock.now()
    const color: Record<JobStatus, string> = {
      running: 'suggestion',
      done: 'success',
      failed: 'error',
      stopped: 'inactive',
      timeout: 'warning',
    }

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>감시 중인 작업이 없습니다. Claude가 watch_job으로 등록합니다.</Text>}
        {[...list].reverse().map(job => (
          <Box key={job.id} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={color[job.status]} bold>{`● ${job.name} `}</Text>
              <Text dimColor>
                {`${LABEL[job.status]} · ${formatElapsed((job.endedAt ?? now) - job.startedAt)} · 확인 ${job.checks}회`}
                {job.errorStreak > 0 ? ` · 오류 ${job.errorStreak}회` : ''}
              </Text>
              {job.status === 'running' ? (
                <Box marginLeft={1}>
                  <Button key={`stop-${job.id}`} label="중지" onPress={() => void stop($, job.id)} />
                </Box>
              ) : null}
            </Box>
            <Text wrap="truncate-end">{`  ${job.lastLine || '(아직 출력 없음)'}`}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}
