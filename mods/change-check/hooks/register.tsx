import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CheckOutcome, CheckRun, CheckSpec, GitInfo } from '../types'

const TOOL_SET = 'mcp__change-check__set_check_command'
const STORE_KEY = 'commands'
const CHECK_TIMEOUT_MS = 120_000
const OUTPUT_LINES = 15
// Uncommitted changes older than this are worth a warning.
export const STALE_COMMIT_HOURS = 24

const changed = atom({ plugin: 'change-check', key: 'changed' } as const, [])
const running = atom({ plugin: 'change-check', key: 'running' } as const, false)
const last = atom({ plugin: 'change-check', key: 'last' } as const, null)
const git = atom({ plugin: 'change-check', key: 'git' } as const, null)
const dismissed = atom({ plugin: 'change-check', key: 'dismissed' } as const, false)

const SET_DESCRIPTION = [
  'Set the command the change-check plugin runs after a turn in which you edited files in this project folder',
  '(e.g. "npm test --silent", "npx tsc --noEmit", "pytest -q tests/unit"). It replaces the built-in syntax checks for',
  'this folder and is kept across sessions. Pass an empty command to go back to the built-in checks. Keep it under two minutes.',
].join(' ')

const SET_SCHEMA = {
  type: 'object',
  properties: { command: { type: 'string', description: 'Shell command run in the project folder; "" to clear.' } },
  required: ['command'],
}

export function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

const ext = (f: string) => f.slice(f.lastIndexOf('.')).toLowerCase()

// Which checks the changed files call for: the project's own command when set,
// otherwise a quick syntax check per kind of file.
export function planChecks(files: string[], opts: { custom?: string; hasLocalTsc: boolean }): CheckSpec[] {
  if (opts.custom) return [{ label: opts.custom, command: opts.custom }]
  const of = (...exts: string[]) => files.filter(f => exts.includes(ext(f)))
  const args = (list: string[]) => list.map(quote).join(' ')
  const checks: CheckSpec[] = []
  if (opts.hasLocalTsc && of('.ts', '.tsx', '.mts', '.cts').length > 0) {
    checks.push({ label: 'tsc', command: 'node_modules/.bin/tsc --noEmit -p .' })
  }
  const py = of('.py')
  if (py.length > 0) checks.push({ label: 'python', command: `python3 -m py_compile ${args(py)}` })
  const sh = of('.sh', '.bash')
  if (sh.length > 0) checks.push({ label: 'sh -n', command: `for f in ${args(sh)}; do sh -n "$f" || exit 1; done` })
  const json = of('.json')
  if (json.length > 0) {
    checks.push({
      label: 'json',
      command: `python3 -c 'import json,sys\nfor f in sys.argv[1:]:\n  try: json.load(open(f))\n  except Exception as e: sys.exit(f"{f}: {e}")' ${args(json)}`,
    })
  }
  const js = of('.js', '.mjs', '.cjs')
  if (js.length > 0) {
    checks.push({ label: 'node --check', command: `command -v node >/dev/null || exit 0; for f in ${args(js)}; do node --check "$f" || exit 1; done` })
  }
  return checks
}

export function tail(output: string, n = OUTPUT_LINES): string {
  return output
    .split('\n')
    .map(l => l.trimEnd())
    .filter(Boolean)
    .slice(-n)
    .join('\n')
}

// The first line worth showing from a failed check: an error line if there is one.
export function headline(output: string): string {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean)
  return lines.find(l => /error|Error|invalid|unexpected|failed/.test(l)) ?? lines[lines.length - 1] ?? ''
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

let project = ''

async function customCommand($: EngineInterface): Promise<string | undefined> {
  const v = (await $.store.get(STORE_KEY)) as Record<string, string> | undefined
  return v && typeof v === 'object' ? v[project] : undefined
}

async function refreshGit($: EngineInterface): Promise<void> {
  if (!project) return
  try {
    const status = await $.process.run(['git', '-C', project, 'status', '--porcelain'], { timeoutMs: 15_000 })
    if (status.exitCode !== 0) {
      await update($, git, () => null)
      return
    }
    const dirty = status.stdout.split('\n').filter(Boolean).length
    const log = await $.process.run(['git', '-C', project, 'log', '-1', '--format=%ct'], { timeoutMs: 15_000 })
    const at = Number(log.stdout.trim())
    const now = await $.clock.now()
    const info: GitInfo = { dirty, lastCommitHours: log.exitCode === 0 && at > 0 ? Math.floor((now / 1000 - at) / 3600) : null }
    await update($, git, () => info)
  } catch {
    await update($, git, () => null)
  }
}

// Runs after a turn that edited files, or at once from /check (`force`).
async function runChecks($: EngineInterface, force = false): Promise<void> {
  if (await read($, running)) return
  const pending = await read($, changed)
  const custom = await customCommand($)
  if (pending.length === 0 && !(force && custom)) return
  await update($, running, () => true)
  try {
    const files: string[] = []
    for (const f of pending) if (await $.fs.exists(f)) files.push(f)
    const hasLocalTsc = await $.fs.exists(`${project}/node_modules/.bin/tsc`)
    const checks = planChecks(files, { ...(custom ? { custom } : {}), hasLocalTsc })
    const outcomes: CheckOutcome[] = []
    for (const check of checks) {
      try {
        const ran = await $.process.run(['/bin/sh', '-c', check.command], { cwd: project, timeoutMs: CHECK_TIMEOUT_MS })
        outcomes.push({ label: check.label, ok: ran.exitCode === 0, output: tail(`${ran.stdout}\n${ran.stderr}`) })
      } catch (err) {
        outcomes.push({ label: check.label, ok: false, output: describeError(err) })
      }
    }
    const run: CheckRun = { at: await $.clock.now(), ok: outcomes.every(o => o.ok), files, outcomes }
    await update($, changed, list => list.filter(f => !pending.includes(f)))
    await update($, last, () => (outcomes.length > 0 ? run : null))
    await update($, dismissed, () => false)
    const failed = outcomes.find(o => !o.ok)
    if (failed) $.ui.toast(`검사 실패: ${failed.label}`)
  } finally {
    await update($, running, () => false)
  }
  await refreshGit($)
}

async function sendErrors($: EngineInterface): Promise<void> {
  const run = await read($, last)
  if (!run) return
  const details = run.outcomes
    .filter(o => !o.ok)
    .map(o => `## ${o.label}\n${o.output}`)
    .join('\n\n')
  await update($, dismissed, () => true)
  await $.prompt.submit({ text: `방금 수정한 파일의 검사에서 오류가 났어. 확인하고 고쳐줘.\n\n${details}`, asUser: true })
}

// A file an edit tool changed waits for the next check.
async function recordEdit($: EngineInterface, e: unknown, result: { deny?: unknown; isError?: unknown }): Promise<void> {
  if (result.deny !== undefined || result.isError) return
  const input = e as { file_path?: string; notebook_path?: string }
  const path = input.file_path ?? input.notebook_path
  if (path) await update($, changed, list => (list.includes(path) ? list : [...list, path]))
}

async function dismiss($: EngineInterface): Promise<void> {
  await update($, dismissed, () => true)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({ name: 'set_check_command', description: SET_DESCRIPTION, inputSchema: SET_SCHEMA })
    await $.command.register({ name: 'check', description: '수정한 파일 검사를 지금 실행합니다' })
    project = e.cwd
    await refreshGit($)
    return next(e)
  })

  // Every file an edit tool changed waits for the next check.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const result = await next(e)
    await recordEdit($, e, result)
    return result
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const result = await next(e)
    await recordEdit($, e, result)
    return result
  }).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const result = await next(e)
    await recordEdit($, e, result)
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Checks run after the turn is answered, so a slow one never holds it.
    $.clock.after(0, () => void runChecks($))
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    // A passing result has been seen once the person moves on.
    const run = await read($, last)
    if (run?.ok) await update($, dismissed, () => true)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'check' }, async $ => {
    const run = await read($, last)
    if (run) await update($, changed, list => [...new Set([...list, ...run.files])])
    await runChecks($, true)
    const now = await read($, last)
    if (!now) return { text: '검사할 파일이 없습니다.' }
    return { text: now.ok ? `검사 통과 (${now.outcomes.map(o => o.label).join(', ')})` : `검사 실패: ${now.outcomes.filter(o => !o.ok).map(o => o.label).join(', ')}` }
  })

  on('tool.call', { tool: TOOL_SET }, async ($, e) => {
    const command = String((e as unknown as Record<string, unknown>).command ?? '').trim()
    const saved = ((await $.store.get(STORE_KEY)) as Record<string, string> | undefined) ?? {}
    if (command) saved[project] = command
    else delete saved[project]
    await $.store.set(STORE_KEY, saved)
    return { result: command ? `After turns that edit files in ${project}, the plugin will run: ${command}` : `Back to the built-in syntax checks for ${project}.` }
  }).catch(($, e, next) => ({ deny: `change-check failed: ${describeError(next.error)}` }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const isRunning = await read($, running)
    const run = await read($, last)
    const isDismissed = await read($, dismissed)
    const info = await read($, git)
    const showRun = isRunning || (run !== null && !isDismissed)
    const isStale = info !== null && info.dirty > 0 && (info.lastCommitHours === null || info.lastCommitHours >= STALE_COMMIT_HOURS)
    if (e.props.hasSurvey || (!showRun && !isStale)) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const below = await next(e)
    const failed = run?.outcomes.find(o => !o.ok)
    const staleText = isStale
      ? `⚠ 미커밋 ${info!.dirty}개${info!.lastCommitHours === null ? ' (커밋 없음)' : ` · 마지막 커밋 ${info!.lastCommitHours}시간 전`}`
      : ''

    return (
      <Box flexDirection="column">
        <Box>
          <Box flexShrink={0}>
            <Text color="suggestion" bold>{'검사 '}</Text>
          </Box>
          {isRunning ? (
            <Box flexShrink={1}>
              <Text dimColor>{'검사 중… '}</Text>
            </Box>
          ) : showRun && run ? (
            failed ? (
              <Box flexShrink={1}>
                <Text color="error" wrap="truncate-end">{`✘ ${failed.label}: ${headline(failed.output)} `}</Text>
              </Box>
            ) : (
              <Box flexShrink={1}>
                <Text color="success" wrap="truncate-end">{`✔ 파일 ${run.files.length}개 · ${run.outcomes.map(o => o.label).join(', ')} `}</Text>
              </Box>
            )
          ) : null}
          {staleText ? (
            <Box flexShrink={1}>
              <Text color="warning" wrap="truncate-end">{`${staleText} `}</Text>
            </Box>
          ) : null}
          {failed && showRun && !isRunning && !e.props.isWorking ? (
            <Box flexShrink={0}>
              <Button key="send-errors" label="오류 전달" onPress={() => sendErrors($)} />
              <Text> </Text>
            </Box>
          ) : null}
          {showRun && !isRunning ? (
            <Box flexShrink={0}>
              <Button key="dismiss" label="×" onPress={() => dismiss($)} />
            </Box>
          ) : null}
        </Box>
        {below}
      </Box>
    )
  })
}
