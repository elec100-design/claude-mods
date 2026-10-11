import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { headline, planChecks, quote } from '../hooks/register'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 },
} as const

const TURN = { answer: 'done', durationMs: 1, isAborted: false, turnId: 't', reason: 'end_turn', category: null, explanation: null } as never
const NOW = 1_800_000_000_000

// The host beneath the plugin: `host.check` answers each check command, `host.git` the repo.
function world(on: On) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  const host = {
    check: { exitCode: 0, stdout: '', stderr: '' },
    git: { status: '', exitCode: 0, lastCommit: Math.floor(NOW / 1000) - 3600 },
    commands: [] as string[],
  }
  const submitted: { text: string; origin?: unknown }[] = []
  on('process.run', async (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never
    if (argv[0] === 'git') {
      if (argv.includes('status')) return ok(host.git.status, host.git.exitCode)
      return ok(String(host.git.lastCommit), host.git.exitCode)
    }
    host.commands.push(argv[2] ?? '')
    return { value: { ...host.check, isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('fs.exists', async (_$, e) => ({ value: !String((e as { path: string }).path).includes('node_modules') }) as never)
  on('tool.register', async () => ({ value: undefined }) as never)
  on('command.register', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('turn.complete', async () => ({ text: 'done' }) as never)
  on('session.start', async () => ({ cwd: '/proj' }) as never)
  on('prompt.submit', async (_$, e) => {
    submitted.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('tool.call', { tool: 'Edit' }, async () => ({ result: { ok: true } }) as never)
  on('tool.call', { tool: 'Write' }, async () => ({ result: { ok: true } }) as never)
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>CONTEXT-BAR</Text>
  })
  return { clock, host, submitted }
}

async function start($: unknown) {
  await ($ as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
}

async function edit($: unknown, file: string, tool: 'Edit' | 'Write' = 'Edit') {
  await ($ as { tool: { call: (e: unknown) => Promise<unknown> } }).tool.call({
    tool,
    tool_use_id: `tu-${file}`,
    file_path: file,
    ...(tool === 'Edit' ? { old_string: 'a', new_string: 'b' } : { content: 'x' }),
  })
}

async function endTurn($: unknown, clock: { settle: () => Promise<void> }) {
  await ($ as { turn: { complete: (e: unknown) => Promise<unknown> } }).turn.complete(TURN)
  await clock.settle()
}

test('planChecks picks a check per kind of file, or the project command', () => {
  const checks = planChecks(['/p/a.py', '/p/b.sh', '/p/c.json', '/p/d.ts', '/p/e.md', "/p/it's.py"], { hasLocalTsc: true })
  expect(checks.map(c => c.label)).toEqual(['tsc', 'python', 'sh -n', 'json'])
  expect(checks[1]!.command).toContain(quote("/p/it's.py"))
  expect(planChecks(['/p/d.ts'], { hasLocalTsc: false })).toEqual([])
  expect(planChecks(['/p/a.py'], { custom: 'npm test', hasLocalTsc: false })).toEqual([{ label: 'npm test', command: 'npm test' }])
  expect(planChecks(['/p/readme.md'], { hasLocalTsc: false })).toEqual([])
  expect(headline('Compiling...\n  File "a.py", line 3\nSyntaxError: invalid syntax\n')).toBe('SyntaxError: invalid syntax')
})

test('a broken Python edit is reported above the band, and its errors can be sent', async ($, on) => {
  const { clock, host, submitted } = world(on)
  await start($)
  host.check = { exitCode: 1, stdout: '', stderr: '  File "/proj/query_expand.py", line 12\n    def f(:\nSyntaxError: invalid syntax' }
  await edit($, '/proj/query_expand.py')
  await endTurn($, clock)
  expect(host.commands.length).toBe(1)
  expect(host.commands[0]).toContain('py_compile')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'change-check', surface, ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /✘ python: SyntaxError: invalid syntax/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CONTEXT-BAR/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'change-check', surface: 'terminal', ...BAND } as never)
  await ui.press({ key: 'send-errors' })
  expect(submitted.length).toBe(1)
  expect(submitted[0]!.text).toContain('line 12')
  expect(await ui.find({ type: 'Text', text: /✘/ })).toBeUndefined()
  await ui.unmount()
})

test('a passing check shows once and clears when the user moves on', async ($, on) => {
  const { clock, host } = world(on)
  await start($)
  await edit($, '/proj/run.sh', 'Write')
  await edit($, '/proj/run.sh')
  await endTurn($, clock)
  expect(host.commands.length).toBe(1)
  const ui = await $.ui.mount({ plugin: 'change-check', surface: 'terminal', ...BAND } as never)
  expect(await ui.find({ type: 'Text', text: /✔ 파일 1개 · sh -n/ })).toBeDefined()
  await ($ as unknown as { prompt: { submit: (e: unknown) => Promise<unknown> } }).prompt.submit({ text: 'next', wait: false })
  expect(await ui.find({ type: 'Text', text: /✔/ })).toBeUndefined()
  await ui.unmount()
})

test('a turn with no edits runs nothing and shows nothing', async ($, on) => {
  const { clock, host } = world(on)
  await start($)
  await endTurn($, clock)
  expect(host.commands.length).toBe(0)
  const ui = await $.ui.mount({ plugin: 'change-check', surface: 'terminal', ...BAND } as never)
  expect(await ui.find({ type: 'Text', text: /검사/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /CONTEXT-BAR/ })).toBeDefined()
  await ui.unmount()
})

test('old uncommitted changes are flagged', async ($, on) => {
  const { host } = world(on)
  host.git = { status: ' M a.py\n M b.py\n?? c.md\n', exitCode: 0, lastCommit: Math.floor(NOW / 1000) - 33 * 3600 }
  await start($)
  const ui = await $.ui.mount({ plugin: 'change-check', surface: 'desktop', ...BAND } as never)
  expect(await ui.find({ type: 'Text', text: /미커밋 3개 · 마지막 커밋 33시간 전/ })).toBeDefined()
  await ui.unmount()
})

test('a project command replaces the built-in checks', async ($, on) => {
  const { clock, host } = world(on)
  await start($)
  const r = (await ($ as unknown as { tool: { call: (e: unknown) => Promise<{ deny?: string }> } }).tool.call({
    tool: 'mcp__change-check__set_check_command',
    tool_use_id: 'tu-set',
    command: 'npm test --silent',
  })) as { deny?: string }
  expect(r.deny).toBeUndefined()
  await edit($, '/proj/src/a.ts')
  await endTurn($, clock)
  expect(host.commands).toEqual(['npm test --silent'])
  // A turn with no edits does not run the project command again.
  await endTurn($, clock)
  expect(host.commands.length).toBe(1)
})
