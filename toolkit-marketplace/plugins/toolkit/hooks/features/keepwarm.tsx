// Feature 3: Keep Warm — one click to keep the prompt cache from going cold. Never pings on its own.
// detectTtl is cache-clock's ttl.py, rewritten in TypeScript.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import type { WarmState } from '../../types'
import type { ToolInput } from './bus'
import type { AgentSpawnInput, AgentSpawnResult, ToolCallResult, TurnCompleteInput } from 'claude-code'
import { joinPath, projectSlug } from './paths'
import { getSettings, guard, homeDir, isOn, log } from './settings'
import { C, fmtClock, fmtTokens } from './ui'
import type { Els } from './ui'
import { isWindows, notify } from './windows'

export const EMPTY_WARM: WarmState = {
  ttlSec: null,
  ttlSource: null,
  lastAt: null,
  cachedTokens: null,
  dismissedFor: null,
  notifiedFor: null,
  transcriptPath: null,
  lastPing: null,
}
export const warmAtom = atom({ plugin: 'toolkit', key: 'warm' } as const, EMPTY_WARM)
export const tickAtom = atom({ plugin: 'toolkit', key: 'tick' } as const, 0)

export async function bumpTick($: EngineInterface): Promise<void> {
  await update($, tickAtom, t => (t + 1) % 1_000_000)
}

/** Reading this while drawing redraws the reader every second. */
export async function readTick($: EngineInterface): Promise<number> {
  return read($, tickAtom)
}

/** Milliseconds until the cache goes cold now, or null when unknown. */
export async function coldInMs($: EngineInterface): Promise<number | null> {
  return msToCold(await read($, warmAtom), await $.clock.now())
}

// ---- ttl.py, in TypeScript ----
export type TtlReading = { ttlSec: number | null; lastAt: number | null; cachedTokens: number | null }

type UsageLine = {
  type?: string
  timestamp?: string
  isSidechain?: boolean
  message?: {
    role?: string
    usage?: {
      input_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
    }
  }
}

/**
 * Reads transcript JSONL from the end: the newest main-thread assistant usage that wrote cache
 * decides the TTL (1h tokens written -> 3600 s, 5m tokens written -> 300 s). Lines that only read
 * the cache keep looking further back. The newest usage line gives the last request's time.
 */
export const detectTtl = (jsonl: string): TtlReading => {
  const lines = jsonl.split(/\r?\n/)
  let ttlSec: number | null = null
  let lastAt: number | null = null
  let cachedTokens: number | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]
    if (!raw || !raw.includes('"usage"')) continue
    let row: UsageLine
    try {
      row = JSON.parse(raw) as UsageLine
    } catch {
      continue
    }
    if (row.type !== 'assistant' || row.isSidechain === true) continue
    const u = row.message?.usage
    if (!u) continue
    if (lastAt === null) {
      const t = row.timestamp ? Date.parse(row.timestamp) : NaN
      lastAt = Number.isFinite(t) ? t : null
      cachedTokens = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.input_tokens ?? 0)
    }
    const oneHour = u.cache_creation?.ephemeral_1h_input_tokens ?? 0
    const fiveMin = u.cache_creation?.ephemeral_5m_input_tokens ?? 0
    if (oneHour > 0) {
      ttlSec = 3600
      break
    }
    if (fiveMin > 0 || (u.cache_creation_input_tokens ?? 0) > 0) {
      ttlSec = 300
      break
    }
  }
  return { ttlSec, lastAt, cachedTokens }
}

/**
 * Cost of a ping vs a cold re-read, in input-token equivalents, from the published cache
 * multipliers: a cache read is 0.1x input, a 5-minute write 1.25x, a 1-hour write 2x.
 */
export const pingVsCold = (cachedTokens: number, ttlSec: number): { ping: number; cold: number; pct: number } => {
  const ping = Math.round(cachedTokens * 0.1 + 20)
  const cold = Math.round(cachedTokens * (ttlSec >= 3600 ? 2 : 1.25))
  return { ping, cold, pct: cold > 0 ? Math.round((ping / cold) * 100) : 0 }
}

/** Milliseconds until the cache goes cold, or null when unknown. */
export const msToCold = (w: WarmState, now: number): number | null =>
  w.ttlSec === null || w.lastAt === null ? null : w.lastAt + w.ttlSec * 1000 - now

/** The bar shows in the last `leadSec` before cold, unless let go for this request. */
export const isWarnWindow = (w: WarmState, now: number, leadSec: number): boolean => {
  const left = msToCold(w, now)
  return left !== null && left > 0 && left <= leadSec * 1000 && w.dismissedFor !== w.lastAt
}

// ---- Reading the transcript ----
async function readTail($: EngineInterface, path: string): Promise<string | null> {
  try {
    return String(await $.fs.read(path))
  } catch {
    // Over 4 MiB: read the tail through PowerShell on Windows.
    if (!(await isWindows($))) return null
    try {
      const r = await $.process.run(
        ['powershell', '-NoProfile', '-NonInteractive', '-Command', 'Get-Content -LiteralPath $env:TOOLKIT_FILE -Tail 400'],
        { env: { TOOLKIT_FILE: path }, timeoutMs: 15_000 },
      )
      return r.exitCode === 0 ? r.stdout : null
    } catch {
      return null
    }
  }
}

export async function transcriptPathFor($: EngineInterface): Promise<string> {
  const w = await read($, warmAtom)
  if (w.transcriptPath) return w.transcriptPath
  const cwd = await $.session.cwd()
  return joinPath(await homeDir($), '.claude', 'projects', projectSlug(cwd), `${await $.session.id()}.jsonl`)
}

export async function refreshTtl($: EngineInterface): Promise<void> {
  const path = await transcriptPathFor($)
  const text = await readTail($, path)
  const r = text ? detectTtl(text) : { ttlSec: null, lastAt: null, cachedTokens: null }
  await update($, warmAtom, (w): WarmState => ({
    ...w,
    ttlSec: r.ttlSec ?? w.ttlSec ?? 300,
    ttlSource: r.ttlSec !== null ? 'transcript' : w.ttlSource === 'transcript' ? 'transcript' : 'assumed',
    lastAt: Math.max(w.lastAt ?? 0, r.lastAt ?? 0) || null,
    cachedTokens: w.cachedTokens ?? r.cachedTokens,
  }))
}

/** Called after each main-thread model step: the cache was just touched. */
export async function onMainStep($: EngineInterface, cachedTokens: number | null): Promise<void> {
  const now = await $.clock.now()
  await update($, warmAtom, w => ({ ...w, lastAt: now, cachedTokens: cachedTokens ?? w.cachedTokens }))
}

export async function keepWarm($: EngineInterface): Promise<void> {
  const r = await $.model.fork({ prompt: 'Reply with the single word: ok' })
  if (r.isAnswered) {
    const now = await $.clock.now()
    await update($, warmAtom, w => ({ ...w, lastAt: now, lastPing: now }))
    $.ui.toast(`Cache kept warm (${fmtTokens(r.usage.cache_read_input_tokens)} read from cache).`)
    void log($, 'keep-warm', `ping ok, cache read ${r.usage.cache_read_input_tokens}`)
  } else {
    $.ui.toast(`Keep warm failed: ${r.reason}`)
    void log($, 'keep-warm', `ping failed: ${r.reason}`)
  }
}

export function letItGo($: EngineInterface): Promise<WarmState> {
  return update($, warmAtom, w => ({ ...w, dismissedFor: w.lastAt }))
}

let isWorking = false
export const setWorking = (v: boolean): void => {
  isWorking = v
}

/** Each second: the 2-minute warning notification. */
export async function warmTick($: EngineInterface): Promise<void> {
  if (isWorking || !(await isOn($, 'keepWarm'))) return
  const w = await read($, warmAtom)
  const s = await getSettings($)
  const now = await $.clock.now()
  if (!isWarnWindow(w, now, s.keepWarmLeadSec) || w.notifiedFor === w.lastAt) return
  await update($, warmAtom, x => ({ ...x, notifiedFor: x.lastAt }))
  const left = msToCold(w, now) ?? 0
  void notify($, 'Keep warm', `Prompt cache goes cold in ${fmtClock(left)}. Open Claude to keep it warm.`)
}

export const registerKeepWarm = (on: On): void => {
  on('classic.Stop', async ($, e, next) => {
    await guard($, 'keep-warm', async () => {
      const path = (e as { transcript_path?: string }).transcript_path
      if (typeof path === 'string' && path.length > 0) await update($, warmAtom, w => ({ ...w, transcriptPath: path }))
    })
    return next(e)
  })
}

export async function keepwarmTurnStart(_$: EngineInterface, agentId: string | undefined): Promise<void> {
  if (agentId === undefined) setWorking(true)
}

export async function keepwarmTurnComplete($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  if (e.agentId !== undefined) return
  setWorking(false)
  if (await isOn($, 'keepWarm')) await refreshTtl($)
}

export async function renderWarmBand($: EngineInterface, E: Els, working: boolean): Promise<RenderElement | null> {
  if (working || !(await isOn($, 'keepWarm'))) return null
  await read($, tickAtom) // redraw every second while shown
  const w = await read($, warmAtom)
  const s = await getSettings($)
  const now = await $.clock.now()
  if (!isWarnWindow(w, now, s.keepWarmLeadSec)) return null
  const left = msToCold(w, now) ?? 0
  const { Box, Text, Button } = E
  const cost = w.cachedTokens !== null && w.ttlSec !== null ? pingVsCold(w.cachedTokens, w.ttlSec) : null
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={C.amber}>❄</Text>
      <Text color={C.text}>Cache goes cold in {fmtClock(left)}</Text>
      <Text color={C.muted} wrap="truncate-end">
        {cost
          ? `Ping ≈ ${fmtTokens(cost.ping)} vs cold re-read ≈ ${fmtTokens(cost.cold)} (input-token equiv., ${cost.pct}%)`
          : 'Ping cost: —'}
        {w.ttlSource === 'assumed' ? ' · TTL assumed 5 min' : ''}
      </Text>
      <Button key="warm-keep" variant="primary" label="Keep warm" onPress={() => void keepWarm($)} />
      <Button key="warm-go" label="Let it go" onPress={() => void letItGo($)} />
    </Box>
  )
}
