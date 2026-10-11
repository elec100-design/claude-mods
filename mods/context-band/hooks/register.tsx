import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextRow, ContextSnapshot, PendingPrompt } from '../types'

// The prompt cache lives an hour; a prompt after that rewrites the whole context.
export const CACHE_TTL_MS = 60 * 60 * 1000
// Hold a prompt sent after expiry only when rewriting would be costly.
export const GUARD_MIN_TOKENS = 100_000
// Past this, suggest compacting once the turn ends.
export const COMPACT_HINT_TOKENS = 200_000
const STORE_KEY = 'lastResponseAt'
const STORE_LIMIT = 50

const snapshot = atom({ plugin: 'context-band', key: 'snapshot' } as const, null)
const lastResponseAt = atom({ plugin: 'context-band', key: 'lastResponseAt' } as const, null)
const nowAtom = atom({ plugin: 'context-band', key: 'now' } as const, 0)
const pending = atom({ plugin: 'context-band', key: 'pending' } as const, null)
const isWritingNote = atom({ plugin: 'context-band', key: 'isWritingNote' } as const, false)

// The session's folder, where the handoff note is written.
let cwd = ''

export const NOTE_PROMPT = [
  '이 대화를 새 세션에서 이어가기 위한 인계 노트를 Markdown으로 작성해줘. 새 세션의 Claude는 이 노트만 읽고 바로 작업을 이어가야 해.',
  '다음 제목과 순서를 지켜:',
  '# 인계 노트 (작성 시각)',
  '## 목표',
  '## 현재 상태',
  '## 완료한 일',
  '## 남은 일 (다음에 할 일부터 순서대로)',
  '## 결정 사항과 제약 (사용자가 정한 규칙과 선호 포함)',
  '## 관련 파일과 경로',
  '## 주의할 점 (실패했던 방법, 미해결 문제)',
  '## 새 세션 첫 지시 (새 세션에서 바로 붙여 넣을 한두 문장)',
  '경로, 명령, 설정값은 그대로 적고, 확인하지 않은 내용은 (추정)이라고 표시해. 노트 본문만 출력해.',
].join('\n')

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${min}분`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h}시간` : `${h}시간 ${m}분`
}

// Splits `width` cells among the rows in proportion to their tokens
// (largest remainder), giving every non-empty row at least one cell when it fits.
export function barCells(rows: ContextRow[], max: number, width: number): number[] {
  const exact = rows.map(r => (max > 0 ? (r.tokens / max) * width : 0))
  const cells = exact.map((x, i) => (rows[i]!.tokens > 0 ? Math.max(1, Math.floor(x)) : 0))
  let left = width - cells.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    if (rows[i]!.tokens > 0) {
      cells[i]! += 1
      left -= 1
    }
  }
  // Too many cells (minimums overflowed): take them back from the largest rows.
  while (left < 0) {
    const i = cells.indexOf(Math.max(...cells))
    cells[i]! -= 1
    left += 1
  }
  return cells
}

async function refresh($: EngineInterface): Promise<ContextSnapshot | null> {
  const { context } = await $.session.usage({ breakdown: 'summary' })
  const b = context.breakdown
  if (!b) return null
  const next: ContextSnapshot = {
    total: b.totalTokens,
    max: b.rawMaxTokens,
    percent: b.percentage,
    rows: b.categories.map(c => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind })),
  }
  await update($, snapshot, () => next)
  return next
}

// The last response time per session, kept across restarts so a resumed
// session knows how long it sat idle.
type Saved = Record<string, number>

async function loadSaved($: EngineInterface): Promise<Saved> {
  const v = await $.store.get(STORE_KEY)
  return v && typeof v === 'object' ? (v as Saved) : {}
}

async function saveResponseTime($: EngineInterface, at: number): Promise<void> {
  const id = await $.session.id()
  const saved = await loadSaved($)
  saved[id] = at
  const kept = Object.entries(saved)
    .sort((a, b) => b[1] - a[1])
    .slice(0, STORE_LIMIT)
  await $.store.set(STORE_KEY, Object.fromEntries(kept))
}

async function sendPending($: EngineInterface, compactFirst: boolean): Promise<void> {
  const p = await read($, pending)
  if (!p) return
  await update($, pending, () => null)
  if (compactFirst) {
    $.ui.toast('압축하는 중…')
    try {
      const result = await $.session.compact()
      if ('skip' in result && result.skip) $.ui.toast(`압축 건너뜀: ${result.skip}`)
    } catch (err) {
      $.ui.toast(`압축 실패: ${String(err)}`)
    }
  }
  await $.prompt.submit({ text: p.text, asUser: true })
}

async function cancelPending($: EngineInterface): Promise<void> {
  const p = await read($, pending)
  if (!p) return
  await update($, pending, () => null)
  await $.prompt.fill({ text: p.text })
}

export const register: Register = on => {
  let tick: { cancel: () => void } | null = null
  let compactHinted = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    cwd = e.cwd
    const saved = await loadSaved($)
    const at = saved[await $.session.id()]
    if (at !== undefined) await update($, lastResponseAt, () => at)
    const started = await $.clock.now()
    await update($, nowAtom, () => started)
    tick?.cancel()
    tick = $.clock.every(60_000, () => {
      void $.clock.now().then(t => update($, nowAtom, () => t))
    })
    await refresh($)
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    // Only prompts typed here: not this plugin's resubmission, not remote,
    // scheduled or peer prompts, and not ones with attachments a resubmit would lose.
    const isTyped = !e.origin || e.origin.kind === 'composer'
    if (!isTyped || (e.attachments?.length ?? 0) > 0) return next(e)

    const last = await read($, lastResponseAt)
    const snap = await read($, snapshot)
    const now = await $.clock.now()
    await update($, nowAtom, () => now)
    if (last === null || snap === null) return next(e)
    const idle = now - last
    if (idle < CACHE_TTL_MS || snap.total < GUARD_MIN_TOKENS) return next(e)

    const held: PendingPrompt = { text: e.text, idleMinutes: Math.floor(idle / 60_000), tokens: snap.total }
    await update($, pending, () => held)
    return {
      drop: `캐시 만료(${formatMinutes(held.idleMinutes)} 쉼): 이대로 보내면 컨텍스트 ${formatTokens(held.tokens)}를 다시 기록합니다. 입력창 위에서 선택하세요.`,
    }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const at = await $.clock.now()
    await update($, lastResponseAt, () => at)
    await update($, nowAtom, () => at)
    await saveResponseTime($, at)
    const snap = await refresh($)
    if (snap && snap.total >= COMPACT_HINT_TOKENS && !compactHinted) {
      compactHinted = true
      $.ui.toast(`컨텍스트 ${formatTokens(snap.total)}: 작업 단계가 끝났다면 압축을 권장합니다`)
    }
    if (snap && snap.total < COMPACT_HINT_TOKENS) compactHinted = false
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    if (e.props.hasSurvey || snap === null) {
      return next(e)
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const inWindow = snap.rows.filter(r => r.kind !== 'deferred')
    const cells = barCells(inWindow, snap.max, 40)
    const held = await read($, pending)
    const last = await read($, lastResponseAt)
    const now = await read($, nowAtom)
    // Other plugins' band (a to-do line) draws above the context bar.
    const above = await next(e)

    const glyph = (r: ContextRow) => (r.kind === 'free' ? '░' : r.kind === 'buffer' ? '▒' : '█')
    const percentOf = (n: number) => (snap.max > 0 ? ((n / snap.max) * 100).toFixed(1) : '0.0')

    let cache: { text: string; color: string; dim: boolean } | null = null
    if (!e.props.isWorking && last !== null && now > 0) {
      const leftMin = Math.ceil((last + CACHE_TTL_MS - now) / 60_000)
      cache =
        leftMin <= 0
          ? { text: '캐시 만료', color: 'error', dim: false }
          : { text: `캐시 ${leftMin}분`, color: leftMin <= 10 ? 'warning' : 'inactive', dim: leftMin > 10 }
    }
    const isLarge = snap.total >= COMPACT_HINT_TOKENS && !e.props.isWorking && held === null
    const writingNote = await read($, isWritingNote)

    // Each bar segment and its info entry share a hover scope: pointing at the
    // segment reveals the entry on the second line. A held prompt takes the
    // second line over with its choices.
    return (
      <Box flexDirection="column">
        {above}
        <Box>
          <Box flexShrink={0}>
            <Text bold>Context </Text>
          </Box>
          {/* The bar gives up width first, so the figures beside it never wrap. */}
          <Box flexShrink={1} overflow="hidden">
            {inWindow.map((r, i) =>
              cells[i]! > 0 ? (
                <Box key={r.name} flexShrink={0} hover={{ scope: `ctx-${i}` }}>
                  <Text
                    color={r.kind === 'free' ? 'inactive' : r.color}
                    hover={{ scope: `ctx-${i}`, color: 'text', bold: true }}
                  >
                    {glyph(r).repeat(cells[i]!)}
                  </Text>
                </Box>
              ) : null,
            )}
          </Box>
          <Box flexShrink={0}>
            <Text wrap="truncate-end">{` ${formatTokens(snap.total)} / ${formatTokens(snap.max)} (${snap.percent}%)`}</Text>
          </Box>
        </Box>
        {held ? (
          <Box>
            <Text color="warning" wrap="truncate-end">
              {`⚠ 캐시 만료 · ${formatMinutes(held.idleMinutes)} 쉼 · ${formatTokens(held.tokens)} 재기록 `}
            </Text>
            <Button key="send" label="그대로 보내기" onPress={() => sendPending($, false)} />
            <Text> </Text>
            <Button key="compact-send" label="압축 후 보내기" onPress={() => sendPending($, true)} />
            <Text> </Text>
            <Button key="cancel" label="취소" onPress={() => cancelPending($)} />
          </Box>
        ) : (
          // Second line: free space always, the hovered segment's entry in front
          // of it, and the cache countdown with the compact button on the right.
          <Box height={1} justifyContent="space-between">
            <Box flexShrink={1}>
              {inWindow.map((r, i) =>
                r.kind === 'free' ? null : (
                  <Box key={r.name} display="none" hover={{ scope: `ctx-${i}`, display: 'flex' }}>
                    <Text wrap="truncate-end">
                      <Text color={r.color}>{glyph(r)}</Text>
                      {` ${r.name} ${formatTokens(r.tokens)} · ${percentOf(r.tokens)}%  `}
                    </Text>
                  </Box>
                ),
              )}
              {inWindow.map((r, i) =>
                r.kind === 'free' ? (
                  <Box key={r.name} flexShrink={0}>
                    <Text dimColor wrap="truncate-end" hover={{ scope: `ctx-${i}`, dimColor: false, bold: true }}>
                      {`${glyph(r)} ${r.name} ${formatTokens(r.tokens)} · ${percentOf(r.tokens)}%`}
                    </Text>
                  </Box>
                ) : null,
              )}
            </Box>
            <Box flexShrink={0}>
              {cache ? <Text color={cache.color} dimColor={cache.dim}>{cache.text}</Text> : null}
              {isLarge ? (
                <Box marginLeft={1}>
                  <Button key="compact" label="압축" onPress={() => compactNow($)} />
                </Box>
              ) : null}
              {writingNote ? (
                <Box marginLeft={1}>
                  <Text dimColor>인계 노트 작성 중…</Text>
                </Box>
              ) : !e.props.isWorking ? (
                <Box marginLeft={1}>
                  <Button key="handoff-note" label="인계 노트" onPress={() => startHandoffNote($)} />
                </Box>
              ) : null}
            </Box>
          </Box>
        )}
      </Box>
    )
  })
}

// The note is written after the press is answered: a fork can take a minute.
async function startHandoffNote($: EngineInterface): Promise<void> {
  if (await read($, isWritingNote)) return
  await update($, isWritingNote, () => true)
  $.clock.after(0, () => void writeHandoffNote($))
}

// Asks a fork of this conversation (served from its prompt cache, no turn added)
// for a handoff note, writes it to Handoff.md in the session's folder, and puts
// the new session's first message on the clipboard.
async function writeHandoffNote($: EngineInterface): Promise<void> {
  try {
    $.ui.toast('인계 노트 작성 중… (현재 대화 기준)')
    const reply = await $.model.fork({ prompt: NOTE_PROMPT })
    if (!reply.isAnswered) {
      $.ui.toast(`인계 노트 실패: ${reply.reason}`)
      return
    }
    const path = `${cwd || '.'}/Handoff.md`
    if (await $.fs.exists(path)) {
      const previous = await $.fs.read(path)
      if (typeof previous === 'string') await $.fs.write(`${cwd || '.'}/Handoff.prev.md`, previous)
    }
    await $.fs.write(path, `${reply.text.trim()}\n`)
    const firstMessage = `${path} 를 읽고 이어서 진행해줘.`
    const copied = await $.ui.copy({ text: firstMessage }).catch(() => ({ isCopied: false as const }))
    $.ui.toast(
      copied.isCopied
        ? `Handoff.md 작성 완료 · 새 세션 첫 메시지를 클립보드에 복사했습니다`
        : `Handoff.md 작성 완료: ${path}`,
    )
  } catch (err) {
    $.ui.toast(`인계 노트 실패: ${String(err)}`)
  } finally {
    await update($, isWritingNote, () => false)
  }
}

async function compactNow($: EngineInterface): Promise<void> {
  $.ui.toast('압축하는 중…')
  try {
    const result = await $.session.compact()
    if ('skip' in result && result.skip) {
      $.ui.toast(`압축 건너뜀: ${result.skip}`)
      return
    }
    await refresh($)
  } catch (err) {
    $.ui.toast(`압축 실패: ${String(err)}`)
  }
}
