import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { judgeCheck, tail } from '../hooks/register'

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 },
} as const

// The host beneath the plugin; `host.exitCode`/`host.output` is what the check prints next.
function world(on: On) {
  const clock = mock.clock(on, { now: 0 })
  const host = { exitCode: 1, output: 'Authentication failed: credentials expired', runs: 0 }
  const submitted: string[] = []
  on('process.run', async () => {
    host.runs += 1
    return { value: { exitCode: host.exitCode, stdout: host.output, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
  on('tool.register', async () => ({ value: undefined }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('prompt.submit', async (_$, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('session.start', async () => ({ cwd: '/tmp' }) as never)
  // What other plugins draw in the band beneath this one.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>CONTEXT-BAR</Text>
  })
  return { clock, host, submitted }
}

async function start($: unknown) {
  await ($ as { session: { start: (e: unknown) => Promise<unknown> } }).session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
}

async function request($: unknown, args: Record<string, unknown>) {
  return ($ as { tool: { call: (e: unknown) => Promise<{ text?: string; result?: unknown; deny?: string }> } }).tool.call({
    tool: 'mcp__handoff__request_user_action',
    tool_use_id: 'tu1',
    ...args,
  })
}

test('judgeCheck and tail', () => {
  expect(judgeCheck(0, 'ok')).toBe(true)
  expect(judgeCheck(1, 'nope')).toBe(false)
  expect(judgeCheck(0, 'Logged in as x', 'Logged in')).toBe(true)
  expect(judgeCheck(0, 'Authentication failed', 'Logged in')).toBe(false)
  expect(tail('a\nb\n\nc\nd\ne\nf\n', 3)).toBe('d\ne\nf')
})

test('with nothing pending the band is left to the other plugins', async ($, on) => {
  world(on)
  await start($)
  const ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND } as never)
  expect(await ui.find({ type: 'Text', text: /CONTEXT-BAR/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /할 일/ })).toBeUndefined()
  await ui.unmount()
})

test('a step shows above the other band; Done with a failing check shows why, then hands back once it passes', async ($, on) => {
  const { host, submitted } = world(on)
  await start($)
  const r = await request($, { task: 'NotebookLM 다시 로그인', steps: '터미널에서 nlm login 실행', check: 'nlm login --check', poll_seconds: 0 })
  expect(r.deny).toBeUndefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'handoff', surface, ...BAND } as never)
    expect(await ui.find({ type: 'Text', text: /NotebookLM 다시 로그인/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /nlm login 실행/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CONTEXT-BAR/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND } as never)
  const doneKey = ((await ui.find({ type: 'Button', text: /완료/ })) as { key?: string }).key!
  await ui.press({ key: doneKey })
  expect(submitted.length).toBe(0)
  expect(await ui.find({ type: 'Text', text: /확인 실패: Authentication failed/ })).toBeDefined()

  host.exitCode = 0
  host.output = 'Logged in as demo-user'
  await ui.press({ key: doneKey })
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('NotebookLM 다시 로그인')
  expect(submitted[0]).toContain('✔ 성공')
  expect(submitted[0]).toContain('Logged in as demo-user')
  expect(await ui.find({ type: 'Text', text: /할 일/ })).toBeUndefined()
  await ui.unmount()
})

test('"send anyway" hands back a failed check', async ($, on) => {
  const { submitted } = world(on)
  await start($)
  await request($, { task: 'ssh 키 등록', steps: 'NAS에 공개키 추가', check: 'ssh nas true', poll_seconds: 0 })
  const ui = await $.ui.mount({ plugin: 'handoff', surface: 'desktop', ...BAND } as never)
  const doneKey = ((await ui.find({ type: 'Button', text: /완료/ })) as { key?: string }).key!
  await ui.press({ key: doneKey })
  const sendKey = ((await ui.find({ type: 'Button', text: /그래도 전달/ })) as { key?: string }).key!
  await ui.press({ key: sendKey })
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('✘ 실패')
  await ui.unmount()
})

test('background polling completes the step without a press', async ($, on) => {
  const { clock, host, submitted } = world(on)
  await start($)
  await request($, { task: 'iCloud 2FA 입력', steps: '컨테이너 터미널에서 코드 입력', check: 'docker logs icloud | tail -1', success_when: 'Authenticated' })
  await clock.advance(15_000)
  expect(host.runs).toBe(1)
  expect(submitted.length).toBe(0)
  host.exitCode = 0
  host.output = 'Authenticated as user'
  await clock.advance(15_000)
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('자동 확인됨')
  await clock.advance(60_000)
  expect(host.runs).toBe(2)
})

test('a step with no check hands back on Done; cancel sends nothing', async ($, on) => {
  const { submitted } = world(on)
  await start($)
  await request($, { task: '브라우저 승인', steps: '열린 창에서 허용 클릭' })
  await request($, { task: '필요 없는 일', steps: '-' })
  const ui = await $.ui.mount({ plugin: 'handoff', surface: 'terminal', ...BAND } as never)
  const buttons = (await ui.find({ type: 'Button', text: /취소/ })) as { key?: string }
  expect(buttons.key).toBeDefined()
  const cancelSecond = (await ui.findAll?.({ type: 'Button', text: /취소/ })) as { key?: string }[] | undefined
  await ui.press({ key: (cancelSecond?.[1] ?? buttons).key! })
  const doneKey = ((await ui.find({ type: 'Button', text: /완료/ })) as { key?: string }).key!
  await ui.press({ key: doneKey })
  expect(submitted.length).toBe(1)
  expect(submitted[0]).toContain('확인 명령 없음')
  expect(await ui.find({ type: 'Text', text: /할 일/ })).toBeUndefined()
  await ui.unmount()
})
