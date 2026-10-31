// Feature 5: Plan Usage Meter. Zero tokens.
// LIVE: the rate-limit windows the last API response reported ($.session.usage().rateLimits).
// Estimate: local transcripts of every Claude Code chat on this computer, against a learned cap.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement } from 'claude-code'

import type { UsageState, UsageWindow } from '../../types'
import type { ToolInput } from './bus'
import type { AgentSpawnInput, AgentSpawnResult, ToolCallResult, TurnCompleteInput } from 'claude-code'
import { joinPath } from './paths'
import { homeDir, isOn, log, readJson, writeJson } from './settings'
import { blockBar, C, DASH, fmtClock, fmtTokens, levelColor, svgBar, svgOf } from './ui'
import type { Els } from './ui'
import { readTick } from './keepwarm'
import { notify } from './windows'

const EMPTY_WINDOW: UsageWindow = { pct: null, resetsAt: null, tokens: null }
export const EMPTY_USAGE: UsageState = { mode: 'none', five: EMPTY_WINDOW, week: EMPTY_WINDOW, checkedAt: null }
export const usageAtom = atom({ plugin: 'toolkit', key: 'usage' } as const, EMPTY_USAGE)

export const FIVE_H = 5 * 3600_000
export const WEEK = 7 * 24 * 3600_000

// ---------------------------------------------------------------------------
// Pure logic (tested)
// ---------------------------------------------------------------------------

export type UsageEvent = { at: number; tokens: number }

/** One assistant request's tokens from a transcript line; cache reads are left out. */
export const parseUsageLines = (jsonl: string): (UsageEvent & { key: string })[] => {
  const out: (UsageEvent & { key: string })[] = []
  for (const raw of jsonl.split(/\r?\n/)) {
    if (!raw.includes('"usage"') || !raw.includes('"assistant"')) continue
    try {
      const row = JSON.parse(raw) as {
        type?: string
        timestamp?: string
        requestId?: string
        message?: { id?: string; usage?: Record<string, number> }
      }
      if (row.type !== 'assistant' || !row.message?.usage || !row.timestamp) continue
      const u = row.message.usage
      const at = Date.parse(row.timestamp)
      if (!Number.isFinite(at)) continue
      const tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      const id = row.message.id || row.requestId ? `${row.message.id ?? ''}:${row.requestId ?? ''}` : `t:${at}:${tokens}`
      out.push({ at, tokens, key: id })
    } catch {
      // skip a broken line
    }
  }
  return out
}

/** Claude Code writes one line per content block; keep one row per message+request. */
export const dedupe = (rows: readonly (UsageEvent & { key: string })[]): UsageEvent[] => {
  const seen = new Map<string, UsageEvent>()
  for (const r of rows) {
    const prev = seen.get(r.key)
    if (!prev || r.tokens > prev.tokens) seen.set(r.key, { at: r.at, tokens: r.tokens })
  }
  return [...seen.values()]
}

/**
 * The current 5-hour block: it starts at the first message after the previous block ended
 * (floored to the hour, as the plan counts it) and lasts 5 hours. Null when no block is open now.
 */
export const currentBlock = (events: readonly UsageEvent[], now: number): { start: number; end: number; tokens: number } | null => {
  const sorted = [...events].filter(e => e.at <= now).sort((a, b) => a.at - b.at)
  let block: { start: number; end: number; tokens: number } | null = null
  for (const e of sorted) {
    if (block === null || e.at >= block.end) {
      const start = Math.floor(e.at / 3600_000) * 3600_000
      block = { start, end: start + FIVE_H, tokens: 0 }
    }
    block.tokens += e.tokens
  }
  return block !== null && now < block.end ? block : null
}

export const weekTokens = (events: readonly UsageEvent[], now: number): number =>
  events.filter(e => e.at > now - WEEK && e.at <= now).reduce((a, e) => a + e.tokens, 0)

export const pctOf = (tokens: number, cap: number | null): number | null =>
  cap === null || cap <= 0 ? null : Math.round((tokens / cap) * 1000) / 10

/** A cap learned from a live reading: tokens counted locally at the moment the plan said pct%. */
export const learnCap = (tokens: number, pct: number): number | null => (pct >= 10 && tokens > 0 ? Math.round(tokens / (pct / 100)) : null)

/** Which warning thresholds a move from `prev` to `now` (percent) crosses. */
export const crossed = (prev: number | null, now: number | null, marks: readonly number[] = [80, 95]): number[] =>
  now === null ? [] : marks.filter(m => now >= m && (prev === null || prev < m))

export const usageColor = (pct: number | null): string => (pct === null ? C.grey : levelColor(pct, 70, 90))

export const LIMIT_TEXT = /usage limit|rate limit|limit reached|hit your (?:usage )?limit|limit will reset|out of (?:extra )?usage/i

// ---------------------------------------------------------------------------
// Session wiring
// ---------------------------------------------------------------------------

type Saved = { capFive: number | null; capWeek: number | null; notified: Record<string, string> }
let saved: Saved | null = null
let lastFivePct: number | null = null
let lastWeekPct: number | null = null
let wasOver = false

async function loadSaved($: EngineInterface): Promise<Saved> {
  if (saved) return saved
  const raw = (await readJson($, 'usage.json')) as Partial<Saved> | undefined
  saved = {
    capFive: typeof raw?.capFive === 'number' ? raw.capFive : null,
    capWeek: typeof raw?.capWeek === 'number' ? raw.capWeek : null,
    notified: typeof raw?.notified === 'object' && raw.notified !== null ? (raw.notified as Record<string, string>) : {},
  }
  return saved
}

async function persist($: EngineInterface): Promise<void> {
  if (saved) await writeJson($, 'usage.json', saved)
}

/** Reads every transcript touched in the last 7 days (each under 4 MiB). */
export async function scanTranscripts($: EngineInterface, now: number): Promise<UsageEvent[]> {
  const root = joinPath(await homeDir($), '.claude', 'projects')
  if (!(await $.fs.exists(root))) return []
  const rows: (UsageEvent & { key: string })[] = []
  for (const dir of await $.fs.list(root)) {
    if (dir.kind !== 'dir') continue
    const folder = joinPath(root, dir.name)
    let files
    try {
      files = await $.fs.list(folder)
    } catch {
      continue
    }
    for (const f of files) {
      if (f.kind !== 'file' || !f.name.endsWith('.jsonl') || f.mtimeMs < now - WEEK || f.size > 4 * 1024 * 1024) continue
      try {
        rows.push(...parseUsageLines(String(await $.fs.read(joinPath(folder, f.name)))))
      } catch {
        // unreadable file: skipped
      }
    }
  }
  return dedupe(rows)
}

let lastScan = 0
let cachedEvents: UsageEvent[] = []

export async function fiveHourPct($: EngineInterface): Promise<number | null> {
  return (await read($, usageAtom)).five.pct
}

export async function refreshUsage($: EngineInterface, force = false): Promise<void> {
  if (!(await isOn($, 'planUsage'))) return
  const now = await $.clock.now()
  const sv = await loadSaved($)
  const live = (await $.session.usage()).rateLimits
  const five = live.find(r => r.kind === 'five_hour')
  const week = live.find(r => r.kind === 'seven_day')
  if (force || now - lastScan > 60_000) {
    cachedEvents = await scanTranscripts($, now)
    lastScan = now
  }
  const block = currentBlock(cachedEvents, now)
  const wk = weekTokens(cachedEvents, now)
  let next: UsageState
  if (five || week) {
    // Learn caps from live readings, for when live data is missing later.
    if (five && block) sv.capFive = learnCap(block.tokens, five.percentUsed) ?? sv.capFive
    if (week) sv.capWeek = learnCap(wk, week.percentUsed) ?? sv.capWeek
    next = {
      mode: 'live',
      five: { pct: five?.percentUsed ?? null, resetsAt: five?.resetsAt ? Date.parse(five.resetsAt) : null, tokens: block?.tokens ?? null },
      week: { pct: week?.percentUsed ?? null, resetsAt: week?.resetsAt ? Date.parse(week.resetsAt) : null, tokens: wk },
      checkedAt: now,
    }
  } else {
    next = {
      mode: cachedEvents.length > 0 ? 'estimate' : 'none',
      five: { pct: block ? pctOf(block.tokens, sv.capFive) : 0, resetsAt: block?.end ?? null, tokens: block?.tokens ?? 0 },
      week: { pct: pctOf(wk, sv.capWeek), resetsAt: null, tokens: wk },
      checkedAt: now,
    }
  }
  await update($, usageAtom, () => next)
  await persist($)

  // Notifications: 80%, 95%, and "You're back" after a reset.
  const key = String(next.five.resetsAt ?? 'none')
  for (const m of crossed(lastFivePct, next.five.pct)) {
    if (sv.notified[`five${m}`] === key) continue
    sv.notified[`five${m}`] = key
    void notify($, 'Plan usage', `5-hour window at ${m}%${next.five.resetsAt ? `, resets in ${fmtClock(next.five.resetsAt - now)}` : ''}.`)
  }
  for (const m of crossed(lastWeekPct, next.week.pct)) {
    const wkKey = String(next.week.resetsAt ?? Math.floor(now / WEEK))
    if (sv.notified[`week${m}`] === wkKey) continue
    sv.notified[`week${m}`] = wkKey
    void notify($, 'Plan usage', `Weekly limit at ${m}%.`)
  }
  const over = (next.five.pct ?? 0) >= 100 || (next.week.pct ?? 0) >= 100
  if (wasOver && !over) void notify($, 'Plan usage', "You're back: your limit has reset.")
  wasOver = over
  lastFivePct = next.five.pct
  lastWeekPct = next.week.pct
  await persist($)
}

export async function usageTurnComplete($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  if (e.agentId !== undefined || !(await isOn($, 'planUsage'))) return
  // Hitting the limit teaches the real cap (estimate mode).
  if (LIMIT_TEXT.test(e.answer)) {
    const sv = await loadSaved($)
    const now = await $.clock.now()
    const block = currentBlock(cachedEvents, now)
    if (block && block.tokens > 0) {
      sv.capFive = block.tokens
      void log($, 'plan-usage', `learned 5-hour cap from hitting the limit: ${block.tokens}`)
      wasOver = true
    }
  }
  await refreshUsage($, true)
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export async function renderUsageSection($: EngineInterface, E: Els, surface: string): Promise<RenderElement[]> {
  const { Box, Text } = E
  const Svg = svgOf(E)
  await readTick($)
  const u = await read($, usageAtom)
  const now = await $.clock.now()
  const badge = u.mode === 'live' ? 'LIVE' : u.mode === 'estimate' ? 'Estimate' : 'No data yet'
  const over = (u.five.pct ?? 0) >= 100 ? u.five : (u.week.pct ?? 0) >= 100 ? u.week : null
  const bar = (label: string, w: UsageWindow, reset: string) => {
    const col = usageColor(w.pct)
    const frac = (w.pct ?? 0) / 100
    return [
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={C.text}>{label}</Text>
        <Text color={col}>{w.pct === null ? `${fmtTokens(w.tokens)} tok · cap unknown` : `${w.pct}%`}</Text>
      </Box>,
      Svg && surface !== 'terminal' ? (
        <Svg source={svgBar(frac, col)} alt={`${label} ${w.pct ?? DASH}%`} width={240} height={8} />
      ) : (
        <Text color={col}>{blockBar(frac, 24)}</Text>
      ),
      <Text color={C.muted}>{reset}</Text>,
    ]
  }
  const fiveReset = u.five.resetsAt ? `Resets in ${fmtClock(u.five.resetsAt - now)}` : 'No 5-hour window open'
  const weekReset = u.week.resetsAt
    ? `Resets ${new Date(u.week.resetsAt).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
    : u.mode === 'estimate'
      ? 'Rolling 7 days'
      : DASH
  return [
    <Box flexDirection="row" justifyContent="space-between">
      <Text bold color={C.green}>
        Plan Usage
      </Text>
      <Text color={u.mode === 'live' ? C.green : C.muted}>{badge}</Text>
    </Box>,
    ...(over && over.resetsAt
      ? [
          <Box borderStyle="round" borderColor={C.red} paddingX={1} flexDirection="column">
            <Text color={C.red} bold>
              Limit reached
            </Text>
            <Text color={C.red} bold size="title">
              Back in {fmtClock(over.resetsAt - now)}
            </Text>
          </Box>,
        ]
      : []),
    ...bar('5-hour window', u.five, fiveReset),
    ...bar('Weekly', u.week, weekReset),
    ...(u.mode !== 'live'
      ? [<Text color={C.muted} wrap="wrap">Estimate from this computer's chats; claude.ai and phone use isn't counted.</Text>]
      : []),
  ]
}
