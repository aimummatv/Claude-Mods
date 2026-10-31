// Feature 4: Project Map + Chat Meter.
// Changes Claude makes are held as PENDING (in memory). The person's next message decides, in the
// same single Haiku call that updates PROJECT_MAP.md: approve/move on -> written, reject -> dropped,
// tweak -> kept pending. Haiku only sees the current map, the last turn and the reply.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, SessionMessage } from 'claude-code'

import type { MapState, MeterState, PendingChange } from '../../types'
import type { ToolInput } from './bus'
import type { AgentSpawnInput, AgentSpawnResult, ToolCallResult, TurnCompleteInput } from 'claude-code'
import { basename, dirname, joinPath, relativeTo } from './paths'
import { redactSecrets } from './redact'
import { getSettings, guard, isOn, log } from './settings'
import { blockBar, C, DASH, fmtAgo, fmtTokens, svgRing, truncate, words, svgOf } from './ui'
import type { Els } from './ui'
import { copyText, launch, reveal } from './windows'

export const MAP_FILE = 'PROJECT_MAP.md'
export const START_MESSAGE = 'Read PROJECT_MAP.md and continue from Next steps.'

export const MAP_SECTIONS = [
  'App state by part',
  'Decisions & my rules',
  'Requests',
  'Errors already solved',
  'Key data',
  'Files to open first',
  'Next steps',
] as const

export const EMPTY_MAP_STATE: MapState = {
  path: null,
  pending: [],
  lastUpdateAt: null,
  lastSections: [],
  isUpdating: false,
  lastError: null,
  words: 0,
}
export const EMPTY_METER: MeterState = { contextTokens: null, window: 250_000, samples: [], newChatStatus: null }

export const mapAtom = atom({ plugin: 'toolkit', key: 'map' } as const, EMPTY_MAP_STATE)
export const meterAtom = atom({ plugin: 'toolkit', key: 'meter' } as const, EMPTY_METER)

// ---------------------------------------------------------------------------
// Pure logic (tested)
// ---------------------------------------------------------------------------

export const emptyMap = (project: string): string =>
  [`# Project Map: ${project}`, '', ...MAP_SECTIONS.flatMap(s => [`## ${s}`, '- —', ''])].join('\n')

export const parseSections = (md: string): Map<string, string> => {
  const out = new Map<string, string>()
  let current: string | null = null
  let buf: string[] = []
  for (const line of md.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m) {
      if (current !== null) out.set(current, buf.join('\n').trim())
      current = m[1]!
      buf = []
    } else if (current !== null) buf.push(line)
  }
  if (current !== null) out.set(current, buf.join('\n').trim())
  return out
}

export const changedSections = (before: string, after: string): string[] => {
  const a = parseSections(before)
  const b = parseSections(after)
  const names: string[] = []
  for (const [name, body] of b) if (a.get(name) !== body) names.push(name)
  return names
}

/** Short names for the toast: the part names under "App state by part" when those changed. */
export const changedParts = (before: string, after: string): string[] => {
  const names = changedSections(before, after)
  const parts: string[] = []
  const partOf = (body: string) =>
    new Set(
      body
        .split(/\r?\n/)
        .map(l => /^\s*[-*]\s*([^:]{1,40}):/.exec(l)?.[1]?.trim())
        .filter((x): x is string => !!x),
    )
  if (names.includes('App state by part')) {
    const was = parseSections(before).get('App state by part') ?? ''
    const now = parseSections(after).get('App state by part') ?? ''
    const wasLines = new Set(was.split(/\r?\n/))
    for (const l of now.split(/\r?\n/)) {
      const p = /^\s*[-*]\s*([^:]{1,40}):/.exec(l)?.[1]?.trim()
      if (p && !wasLines.has(l)) parts.push(p)
    }
    if (parts.length === 0) parts.push(...partOf(now))
  }
  const others = names.filter(n => n !== 'App state by part')
  return [...new Set([...parts, ...others])]
}

export type ReplyKind = 'reject' | 'tweak' | 'approve' | 'moveon'

/** Free, local read of the person's reply to the last change (also used by Auto Model's escalation). */
export const classifyReply = (text: string): ReplyKind => {
  const t = text.toLowerCase()
  if (
    /\b(undo|revert|roll ?back|put it back|go back to|change it back|i don'?t like (it|this|that)|don'?t like it|that'?s wrong|not what i (asked|wanted|meant)|this is wrong|remove (that|this|it)|scrap (that|this|it))\b/.test(t) ||
    /^\s*(no|nope|nah)\b/.test(t)
  )
    return 'reject'
  if (/\b(but|instead|make it|a bit|slightly|tweak|adjust|smaller|bigger|darker|lighter|more|less|change the|move the|rename)\b/.test(t)) return 'tweak'
  if (/\b(yes|yep|great|perfect|good|thanks|thank you|looks good|nice|love it|ship it|works|approved?|ok|okay)\b/.test(t)) return 'approve'
  return 'moveon'
}

export const applyLocalDecision = (pending: readonly PendingChange[], kind: ReplyKind): { write: PendingChange[]; keep: PendingChange[] } => {
  if (kind === 'reject') return { write: [], keep: [] }
  if (kind === 'tweak') return { write: [], keep: [...pending] }
  return { write: [...pending], keep: [] }
}

/** Adds `@PROJECT_MAP.md` to CLAUDE.md without touching the rest; null when it is already there. */
export const withMapImport = (claudeMd: string | null): string | null => {
  if (claudeMd !== null && /(^|\s)@PROJECT_MAP\.md\b/.test(claudeMd)) return null
  const line = `@${MAP_FILE}`
  if (claudeMd === null || claudeMd.trim().length === 0) return `${line}\n`
  return `${claudeMd.replace(/\s*$/, '')}\n\n${line}\n`
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Files the chat touched, most-touched first (handoff's gatherFiles). */
export const gatherFiles = (messages: readonly SessionMessage[], root: string): string[] => {
  const count = new Map<string, number>()
  for (const m of messages) {
    for (const u of m.toolUses ?? []) {
      if (!FILE_TOOLS.has(u.tool)) continue
      const input = (u.input ?? {}) as Record<string, unknown>
      const f = input.file_path ?? input.notebook_path
      if (typeof f !== 'string') continue
      const rel = relativeTo(root, f)
      count.set(rel, (count.get(rel) ?? 0) + (u.tool === 'Read' ? 1 : 2))
    }
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)
}

const LINK_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s<>()"'`\]]+/gi

/** Links that appear in the chat (handoff's gatherLinks); trailing punctuation trimmed. */
export const gatherLinks = (texts: readonly string[]): string[] => {
  const seen = new Set<string>()
  for (const t of texts) for (const m of t.match(LINK_RE) ?? []) seen.add(m.replace(/[.,;:!?]+$/, ''))
  return [...seen]
}

/** Skills and connectors used (handoff's gatherSkills). */
export const gatherSkills = (messages: readonly SessionMessage[]): { skills: string[]; connectors: string[] } => {
  const skills = new Set<string>()
  const connectors = new Set<string>()
  for (const m of messages) {
    for (const u of m.toolUses ?? []) {
      if (u.tool === 'Skill') {
        const s = (u.input as { skill?: unknown } | undefined)?.skill
        if (typeof s === 'string') skills.add(s)
      }
      const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(u.tool)
      if (mcp) connectors.add(mcp[1]!)
    }
  }
  return { skills: [...skills], connectors: [...connectors] }
}

export type MapUpdateInput = {
  map: string
  request: string
  answer: string
  files: string[]
  reply: string | null
  pending: readonly PendingChange[]
  facts: { files: string[]; links: string[]; skills: string[]; connectors: string[] }
  wordCap: number
  finalSave: boolean
}

export const MAP_SYSTEM = 'You maintain a short PROJECT_MAP.md of facts. Reply with JSON only.'

export const mapUpdatePrompt = (x: MapUpdateInput): string => {
  const nearCap = words(x.map).length > x.wordCap * 0.85
  return [
    'Update the project map. Facts only, never copy code. Keep these sections, in order:',
    MAP_SECTIONS.map(s => `## ${s}`).join(' | '),
    '"App state by part" lines look like "- Menu: 4 buttons (was 5)". "Requests" lines end with (done), (in progress) or (not started).',
    `Stay under ${x.wordCap} words.${nearCap ? ' The map is near the cap: tighten it (merge, shorten, drop stale lines).' : ''}`,
    '',
    'PENDING changes (not yet in the map):',
    x.pending.length === 0 ? '(none)' : x.pending.map(p => `[${p.id}] ${p.summary} (files: ${p.files.join(', ') || DASH})`).join('\n'),
    '',
    x.finalSave
      ? 'This is the final save before a new chat: write every pending change into the map, each marked "(not yet confirmed)".'
      : x.reply === null
        ? 'No reply yet: do not write pending changes; refresh the other sections only.'
        : [
            "Decide each pending change from the person's reply:",
            '- they move on or approve -> "write" it into the map',
            '- they reject it ("no", "undo", "I don\'t like it", "put it back") -> "discard" it',
            '- they ask for a tweak -> "keep" it pending, with the new version as "summary"',
          ].join('\n'),
    '',
    'Free facts from the chat:',
    `files: ${x.facts.files.slice(0, 12).join(', ') || DASH}`,
    `links: ${x.facts.links.slice(0, 8).join(' ') || DASH}`,
    `skills: ${x.facts.skills.join(', ') || DASH}; connectors: ${x.facts.connectors.join(', ') || DASH}`,
    '',
    '<current_map>',
    x.map,
    '</current_map>',
    '<last_turn>',
    `Request: ${truncate(x.request, 1200)}`,
    `Claude's answer: ${truncate(x.answer, 2000)}`,
    `Files changed: ${x.files.join(', ') || DASH}`,
    '</last_turn>',
    x.reply === null ? '' : `<reply>\n${truncate(x.reply, 1500)}\n</reply>`,
    '',
    'Reply as JSON: {"decisions": [{"id": "...", "action": "write|discard|keep", "summary": "..."}], "map": "<the whole new map markdown>"}',
  ].join('\n')
}

export type MapReply = { decisions: { id: string; action: 'write' | 'discard' | 'keep'; summary?: string }[]; map: string }

export const parseMapReply = (reply: string): MapReply | null => {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const d = JSON.parse(reply.slice(start, end + 1)) as { decisions?: unknown; map?: unknown }
    if (typeof d.map !== 'string' || !/^#|##\s/m.test(d.map)) return null
    const decisions: MapReply['decisions'] = []
    if (Array.isArray(d.decisions)) {
      for (const x of d.decisions) {
        if (typeof x !== 'object' || x === null) continue
        const o = x as { id?: unknown; action?: unknown; summary?: unknown }
        if (typeof o.id !== 'string') continue
        if (o.action !== 'write' && o.action !== 'discard' && o.action !== 'keep') continue
        decisions.push(typeof o.summary === 'string' ? { id: o.id, action: o.action, summary: o.summary } : { id: o.id, action: o.action })
      }
    }
    return { decisions, map: d.map }
  } catch {
    return null
  }
}

/** Pending after the decisions: kept ones stay (with any new summary); written and discarded ones leave. */
export const remainingPending = (pending: readonly PendingChange[], decisions: MapReply['decisions'], fallback: ReplyKind | null): PendingChange[] => {
  const byId = new Map(decisions.map(d => [d.id, d] as const))
  const out: PendingChange[] = []
  for (const p of pending) {
    const d = byId.get(p.id)
    if (d) {
      if (d.action === 'keep') out.push(d.summary ? { ...p, summary: d.summary } : p)
    } else if (fallback === 'tweak' || fallback === null) out.push(p)
  }
  return out
}

// ---- Chat meter ----
export const meterColor = (tokens: number): string => (tokens < 150_000 ? C.green : tokens < 220_000 ? C.amber : C.red)

/** Average context growth per user message, from the context size sampled at each message. */
export const avgPerMessage = (samples: readonly number[]): number | null => {
  if (samples.length < 2) return null
  const diffs: number[] = []
  for (let i = 1; i < samples.length; i++) {
    const d = samples[i]! - samples[i - 1]!
    if (d > 0) diffs.push(d)
  }
  if (diffs.length === 0) return null
  return diffs.reduce((a, b) => a + b, 0) / diffs.length
}

export const messagesLeft = (tokens: number | null, window: number, avg: number | null): number | null =>
  tokens === null || avg === null || avg <= 0 ? null : Math.max(0, Math.floor((window - tokens) / avg))

// ---------------------------------------------------------------------------
// Session wiring
// ---------------------------------------------------------------------------

let turnFiles = new Set<string>()
let lastRequest = ''
let lastAnswer = ''
let lastTurnFiles: string[] = []
let seq = 0

export async function mapPath($: EngineInterface): Promise<string> {
  return joinPath(await $.session.cwd(), MAP_FILE)
}

async function readMap($: EngineInterface, path: string): Promise<string> {
  try {
    if (await $.fs.exists(path)) return String(await $.fs.read(path))
  } catch {
    // fall through
  }
  return emptyMap(basename(dirname(path)) || 'project')
}

export async function ensureClaudeMd($: EngineInterface): Promise<void> {
  const path = joinPath(await $.session.cwd(), 'CLAUDE.md')
  const old = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : null
  const next = withMapImport(old)
  if (next !== null) await $.fs.write(path, next)
}

async function gatherFacts($: EngineInterface): Promise<MapUpdateInput['facts']> {
  const msgs = await $.session.messages()
  const list = 'deny' in msgs ? [] : (msgs as readonly SessionMessage[])
  const root = await $.session.cwd()
  return {
    files: gatherFiles(list, root),
    links: gatherLinks(list.map(m => m.text ?? '')),
    ...gatherSkills(list),
  }
}

/** The one Haiku call that decides pending changes and rewrites the map. */
export async function runMapUpdate($: EngineInterface, reply: string | null, finalSave = false): Promise<void> {
  const st = await read($, mapAtom)
  if (st.isUpdating) return
  const settings = await getSettings($)
  const path = await mapPath($)
  await update($, mapAtom, m => ({ ...m, isUpdating: true, path, lastError: null }))
  try {
    const before = await readMap($, path)
    const input: MapUpdateInput = {
      map: before,
      request: lastRequest,
      answer: lastAnswer,
      files: lastTurnFiles,
      reply,
      pending: st.pending,
      facts: await gatherFacts($),
      wordCap: settings.mapWordCap,
      finalSave,
    }
    const r = await $.model.complete({
      model: 'haiku',
      system: MAP_SYSTEM,
      prompt: redactSecrets(mapUpdatePrompt(input)),
      maxTokens: 4000,
      timeoutMs: 45_000,
    })
    const parsed = r.isAnswered ? parseMapReply(r.text) : null
    const local = reply === null ? null : classifyReply(reply)
    if (parsed === null) {
      // The map is left as it was; pending follows the local read of the reply.
      const kept = finalSave ? [] : local === null ? st.pending : applyLocalDecision(st.pending, local).keep
      await update($, mapAtom, m => ({
        ...m,
        isUpdating: false,
        pending: kept,
        lastError: r.isAnswered ? 'Haiku reply could not be read' : `Haiku call failed (${r.reason})`,
      }))
      void log($, 'project-map', `update skipped: ${r.isAnswered ? 'unparsable reply' : r.reason}`)
      return
    }
    const after = redactSecrets(parsed.map.trim()) + '\n'
    await $.fs.write(path, after)
    await ensureClaudeMd($)
    const parts = changedParts(before, after)
    const pending = finalSave ? [] : remainingPending(st.pending, parsed.decisions, local)
    const now = await $.clock.now()
    await update($, mapAtom, m => ({
      ...m,
      isUpdating: false,
      pending,
      lastUpdateAt: now,
      lastSections: parts.length > 0 ? parts : m.lastSections,
      words: words(after).length,
    }))
    if (parts.length > 0) $.ui.toast(`Map updated: ${parts.slice(0, 4).join(', ')}`)
    void log($, 'project-map', `updated (${parts.join(', ') || 'no section change'}); pending ${pending.length}`)
  } catch (err) {
    await update($, mapAtom, m => ({ ...m, isUpdating: false, lastError: String(err) }))
    throw err
  }
}

export async function contextTokens($: EngineInterface): Promise<number | null> {
  return (await read($, meterAtom)).contextTokens
}

export async function refreshMeter($: EngineInterface, sample: boolean): Promise<void> {
  const u = await $.session.usage()
  const s = await getSettings($)
  const tokens = u.context.tokens ?? null
  await update($, meterAtom, m => ({
    ...m,
    contextTokens: tokens,
    window: s.meterWindow,
    samples: sample && tokens !== null ? [...m.samples, tokens].slice(-40) : m.samples,
  }))
}

/** Called for each message the person sends (after the voice cleaner let it through). */
export async function onUserMessage($: EngineInterface, text: string): Promise<void> {
  await refreshMeter($, true)
  if (!(await isOn($, 'projectMap'))) return
  lastRequest = text
  const st = await read($, mapAtom)
  if (st.pending.length > 0) $.clock.after(0, () => void guard($, 'project-map', () => runMapUpdate($, text)))
}

export async function newChat($: EngineInterface): Promise<void> {
  await update($, meterAtom, m => ({ ...m, newChatStatus: 'Saving the map…' }))
  await runMapUpdate($, null, true)
  await ensureClaudeMd($)
  try {
    await $.command.run({ command: 'clear' })
    await $.prompt.submit({ text: START_MESSAGE })
    await update($, meterAtom, m => ({ ...EMPTY_METER, window: m.window, newChatStatus: null }))
  } catch (err) {
    void log($, 'project-map', `new chat via /clear failed: ${String(err)}`)
    await update($, meterAtom, m => ({
      ...m,
      newChatStatus: 'Map saved. Start a new chat and paste the start message (Copy start message).',
    }))
  }
}

export async function projectmapToolPost($: EngineInterface, tool: string, input: ToolInput, ran: ToolCallResult): Promise<string[] | void> {
  if (input.agentId !== undefined || ran.deny !== undefined || ran.isError !== undefined) return
  if (!/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) return
  const f = input.file_path ?? input.notebook_path
  if (typeof f !== 'string' || /PROJECT_MAP\.md$|CLAUDE\.md$/i.test(f)) return
  turnFiles.add(relativeTo(await $.session.cwd(), f))
}

export async function projectmapTurnComplete($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  if (e.agentId !== undefined) return
  await refreshMeter($, false)
  if (!(await isOn($, 'projectMap'))) return
  lastAnswer = e.answer
  lastTurnFiles = [...turnFiles]
  turnFiles = new Set()
  if (lastTurnFiles.length === 0) return // questions and chit-chat: nothing pending
  const now = await $.clock.now()
  const change: PendingChange = {
    id: `c${++seq}-${now % 100000}`,
    summary: truncate(e.answer.replace(/\s+/g, ' '), 400),
    files: lastTurnFiles,
    at: now,
  }
  await update($, mapAtom, m => ({ ...m, pending: [...m.pending, change].slice(-8) }))
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export async function renderMeterLine($: EngineInterface, E: Els): Promise<RenderElement | null> {
  if (!(await isOn($, 'projectMap'))) return null
  const m = await read($, meterAtom)
  const s = await getSettings($)
  if (m.contextTokens === null || m.contextTokens < s.meterLineFrom) return null
  const { Box, Text, Button } = E
  const left = messagesLeft(m.contextTokens, s.meterWindow, avgPerMessage(m.samples))
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={meterColor(m.contextTokens)}>◉ Chat {fmtTokens(m.contextTokens)} / {fmtTokens(s.meterWindow)}</Text>
      <Text color={C.muted}>{left === null ? '~— messages left' : `~${left} messages left`}</Text>
      <Button key="meter-new" label="New chat" onPress={() => void guard($, 'project-map', () => newChat($))} />
    </Box>
  )
}

/** Rows the meter section takes (used by the pane's own scroller). */
export async function renderMeterSection($: EngineInterface, E: Els, surface: string): Promise<RenderElement[]> {
  const { Box, Text, Button } = E
  const Svg = svgOf(E)
  const m = await read($, meterAtom)
  const st = await read($, mapAtom)
  const s = await getSettings($)
  const now = await $.clock.now()
  const tokens = m.contextTokens
  const frac = tokens === null ? 0 : tokens / s.meterWindow
  const col = tokens === null ? C.grey : meterColor(tokens)
  const left = messagesLeft(tokens, s.meterWindow, avgPerMessage(m.samples))
  const label = tokens === null ? DASH : `${Math.round(frac * 100)}%`
  const path = st.path ?? (await mapPath($))
  const rows: RenderElement[] = [
    <Text bold color={C.amber}>
      Chat Meter
    </Text>,
    Svg && surface !== 'terminal' ? (
      <Box flexDirection="row" gap={1}>
        <Svg source={svgRing(frac, col, label)} alt={`Chat context ${label}`} width={64} height={64} />
        <Box flexDirection="column">
          <Text color={C.text}>
            {fmtTokens(tokens)} / {fmtTokens(s.meterWindow)} tokens
          </Text>
          <Text color={C.muted}>{left === null ? '~— messages left' : `~${left} messages left`}</Text>
        </Box>
      </Box>
    ) : (
      <Text color={col}>
        {blockBar(frac, 20)} {fmtTokens(tokens)} / {fmtTokens(s.meterWindow)}
      </Text>
    ),
    ...(Svg && surface !== 'terminal'
      ? []
      : [<Text color={C.muted}>{left === null ? '~— messages left' : `~${left} messages left`}</Text>]),
    <Text color={C.muted} wrap="truncate-end">
      Map: {st.isUpdating ? 'updating…' : st.lastUpdateAt === null ? 'not written yet' : `updated ${fmtAgo(now - st.lastUpdateAt)}`}
      {st.lastSections.length > 0 ? ` · ${st.lastSections.slice(0, 3).join(', ')}` : ''}
    </Text>,
    <Text color={st.pending.length ? C.amber : C.muted}>Pending changes: {st.pending.length}</Text>,
    ...(st.lastError ? [<Text color={C.red}>{truncate(st.lastError, 60)}</Text>] : []),
    ...(m.newChatStatus ? [<Text color={C.blue}>{m.newChatStatus}</Text>] : []),
    <Box flexDirection="row" gap={1}>
      <Button key="map-new" variant="primary" label="New chat" onPress={() => void guard($, 'project-map', () => newChat($))} />
      <Button key="map-open" label="Open map" onPress={() => void launch($, path)} />
      <Button key="map-update" label="Update map now" onPress={() => void guard($, 'project-map', () => runMapUpdate($, null))} />
    </Box>,
    <Box flexDirection="row" gap={1}>
      <Button key="map-copy" label="Copy start message" onPress={e => void copyText($, START_MESSAGE, e.surface)} />
      <Button key="map-folder" label="Open folder" onPress={() => void reveal($, path)} />
    </Box>,
  ]
  return rows
}
