import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CheckResult, UserAction } from '../types'

const TOOL_REQUEST = 'mcp__handoff__request_user_action'
const DEFAULT_POLL_SEC = 15
const MIN_POLL_SEC = 5
// Background checks stop after this long; the buttons keep working.
const POLL_FOR_MS = 30 * 60_000
const CHECK_TIMEOUT_MS = 30_000
const OUTPUT_LINES = 5

const actions = atom({ plugin: 'handoff', key: 'actions' } as const, [])

const REQUEST_DESCRIPTION = [
  'Hand the user a step only they can do (log in, enter a password or 2FA code, approve something, run a command in their own terminal)',
  'and get told when it is done. Use this INSTEAD of asking in text and waiting for "done, check it".',
  'The step is shown above the user\'s prompt with Done and Cancel buttons. If you give `check`, a shell command that proves',
  'the step is done (e.g. `nlm login --check`), the plugin runs it when the user presses Done and also polls it in the',
  'background, so the step can complete without the user typing anything. You then receive one message with the check',
  'result. After calling this, end your turn and wait for that message.',
].join(' ')

const REQUEST_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', description: 'Short label, in the user\'s language (e.g. "NotebookLM 다시 로그인").' },
    steps: { type: 'string', description: 'One or two lines telling the user exactly what to do, in their language.' },
    check: { type: 'string', description: 'Optional shell command (run with /bin/sh -c) whose success proves the step is done.' },
    success_when: { type: 'string', description: 'Optional regex the check output must match; default is exit code 0.' },
    poll_seconds: { type: 'number', description: `Background check interval (default ${DEFAULT_POLL_SEC}, 0 = only on Done).` },
  },
  required: ['task', 'steps'],
}

export function judgeCheck(exitCode: number, output: string, successWhen?: string): boolean {
  if (successWhen) return new RegExp(successWhen, 'm').test(output)
  return exitCode === 0
}

export function tail(output: string, n = OUTPUT_LINES): string {
  return output
    .split('\n')
    .map(l => l.trimEnd())
    .filter(Boolean)
    .slice(-n)
    .join('\n')
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

const timers = new Map<string, { cancel: () => void }>()
const inFlight = new Set<string>()

async function runCheck($: EngineInterface, action: UserAction): Promise<CheckResult | null> {
  if (!action.check) return null
  try {
    const ran = await $.process.run(['/bin/sh', '-c', action.check], { timeoutMs: CHECK_TIMEOUT_MS })
    const output = `${ran.stdout}\n${ran.stderr}`
    return { ok: judgeCheck(ran.exitCode, output, action.successWhen), exitCode: ran.exitCode, output: tail(output) }
  } catch (err) {
    return { ok: false, exitCode: -1, output: describeError(err) }
  }
}

async function remove($: EngineInterface, id: string): Promise<UserAction | undefined> {
  timers.get(id)?.cancel()
  timers.delete(id)
  let removed: UserAction | undefined
  await update($, actions, list => {
    removed = list.find(a => a.id === id)
    return list.filter(a => a.id !== id)
  })
  return removed
}

async function handBack($: EngineInterface, id: string, result: CheckResult | null, how: string): Promise<void> {
  const action = await remove($, id)
  if (!action) return
  const lines = [`[handoff] 사용자 작업 "${action.task}": ${how}.`]
  if (action.check && result) {
    lines.push(`확인 명령: ${action.check}`)
    lines.push(`확인 결과: ${result.ok ? '✔ 성공' : '✘ 실패'} (exit ${result.exitCode})`)
    if (result.output) lines.push(result.output)
  } else {
    lines.push('확인 명령 없음: 사용자가 완료를 눌렀습니다.')
  }
  await $.prompt.submit({ text: lines.join('\n') })
}

// The Done button: check first, hand back on success, otherwise show why.
async function done($: EngineInterface, id: string): Promise<void> {
  const action = (await read($, actions)).find(a => a.id === id)
  if (!action || inFlight.has(id)) return
  if (!action.check) return handBack($, id, null, '완료')
  inFlight.add(id)
  try {
    const result = await runCheck($, action)
    if (result?.ok) return await handBack($, id, result, '완료 (확인됨)')
    await update($, actions, list => list.map(a => (a.id === id && result ? { ...a, lastCheck: result } : a)))
  } finally {
    inFlight.delete(id)
  }
}

async function poll($: EngineInterface, id: string): Promise<void> {
  const action = (await read($, actions)).find(a => a.id === id)
  if (!action || inFlight.has(id)) return
  if ((await $.clock.now()) - action.createdAt > POLL_FOR_MS) {
    timers.get(id)?.cancel()
    timers.delete(id)
    return
  }
  inFlight.add(id)
  try {
    const result = await runCheck($, action)
    if (result?.ok) {
      $.ui.toast(`"${action.task}" 완료가 확인되어 Claude에게 전달합니다`)
      await handBack($, id, result, '완료 (자동 확인됨)')
    }
  } finally {
    inFlight.delete(id)
  }
}

function arm($: EngineInterface, action: UserAction): void {
  if (!action.check || action.pollSec <= 0) return
  timers.get(action.id)?.cancel()
  timers.set(action.id, $.clock.every(action.pollSec * 1000, () => void poll($, action.id)))
}

async function cancel($: EngineInterface, id: string): Promise<void> {
  await remove($, id)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'request_user_action', description: REQUEST_DESCRIPTION, inputSchema: REQUEST_SCHEMA, isDeferred: false })
    // A reload keeps the actions in state but not the timers: re-arm them.
    for (const action of await read($, actions)) arm($, action)
    return next(e)
  })

  on('tool.call', { tool: TOOL_REQUEST }, async ($, e) => {
    // A tool's arguments sit beside `tool` on the event itself.
    const input = e as unknown as Record<string, unknown>
    const task = String(input.task ?? '').trim()
    const steps = String(input.steps ?? '').trim()
    if (!task || !steps) return { deny: 'task and steps are required' }
    if (typeof input.success_when === 'string') {
      try {
        new RegExp(input.success_when)
      } catch {
        return { deny: `success_when is not a valid regex: ${input.success_when}` }
      }
    }
    const now = await $.clock.now()
    const poll = input.poll_seconds === undefined ? DEFAULT_POLL_SEC : Number(input.poll_seconds) || 0
    const action: UserAction = {
      id: `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      task,
      steps,
      ...(typeof input.check === 'string' && input.check.trim() ? { check: input.check.trim() } : {}),
      ...(typeof input.success_when === 'string' ? { successWhen: input.success_when } : {}),
      pollSec: poll > 0 ? Math.max(MIN_POLL_SEC, poll) : 0,
      createdAt: now,
    }
    await update($, actions, list => [...list.filter(a => a.task !== task), action])
    arm($, action)
    const how = action.check
      ? action.pollSec > 0
        ? `The check runs every ${action.pollSec}s and when they press Done.`
        : 'The check runs when they press Done.'
      : 'They will press Done.'
    return { result: `Shown to the user. ${how} End your turn; you will get one message when it is done.` }
  }).catch(($, e, next) => ({ deny: `handoff failed: ${describeError(next.error)}` }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, actions)
    if (e.props.hasSurvey || list.length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    // Other plugins' band (the context bar) still draws beneath ours.
    const below = await next(e)

    return (
      <Box flexDirection="column">
        {list.map(a => (
          <Box key={a.id} flexDirection="column">
            <Box>
              <Text color="warning" bold>{'할 일 '}</Text>
              <Text bold>{`${a.task} `}</Text>
              <Button key={`done-${a.id}`} label={a.lastCheck && !a.lastCheck.ok ? '다시 확인' : '완료'} onPress={() => done($, a.id)} />
              <Text> </Text>
              {a.lastCheck && !a.lastCheck.ok ? (
                <>
                  <Button key={`send-${a.id}`} label="그래도 전달" onPress={() => handBack($, a.id, a.lastCheck ?? null, '사용자가 완료를 눌렀지만 확인 실패')} />
                  <Text> </Text>
                </>
              ) : null}
              <Button key={`cancel-${a.id}`} label="취소" onPress={() => cancel($, a.id)} />
            </Box>
            <Text dimColor wrap="truncate-end">{`  ${a.steps}`}</Text>
            {a.lastCheck && !a.lastCheck.ok ? (
              <Text color="error" wrap="truncate-end">{`  ✘ 확인 실패: ${a.lastCheck.output.split('\n').pop() ?? ''}`}</Text>
            ) : null}
          </Box>
        ))}
        {below}
      </Box>
    )
  })
}
