// Feature 2: Helper Desk — the purple task bar above the prompt and the subagent monitor
// at the top of the Toolkit pane (fixed height, own paging, stable order, pinned alerts).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement } from 'claude-code'

import type { AgentBadge, AgentRec, AgentsState, AgentStatusKind, TaskBar, ToolkitSettings } from '../../types'
import type { ToolInput } from './bus'
import type { AgentSpawnInput, AgentSpawnResult, ToolCallResult, TurnCompleteInput } from 'claude-code'
import { basename, extname } from './paths'
import { getSettings, isOn, log } from './settings'
import { C, DASH, fmtAgo, fmtDuration, fmtRate, fmtTokens, truncate } from './ui'
import type { Els } from './ui'
import { launch, notify } from './windows'

export const EMPTY_AGENTS: AgentsState = { recs: {}, order: [], page: 0, allDoneNotified: true }
export const agentsAtom = atom({ plugin: 'toolkit', key: 'agents' } as const, EMPTY_AGENTS)
export const tasksAtom = atom({ plugin: 'toolkit', key: 'tasks' } as const, null as TaskBar | null)

// ---------------------------------------------------------------------------
// Pure logic (tested)
// ---------------------------------------------------------------------------

const DESIGN_EXT = new Set(['.html', '.htm', '.css', '.scss', '.sass', '.less', '.tsx', '.jsx', '.svg', '.vue', '.svelte', '.liquid', '.fig', '.sketch', '.xd'])

export type BadgeKind = keyof AgentRec['badgeCounts']

/** What one tool call says about the kind of work an agent does; null when it says nothing. */
export const badgeKindOf = (tool: string, input: Record<string, unknown>): BadgeKind | null => {
  const t = tool.toLowerCase()
  if (/browser|playwright|puppeteer|chrome|computer[-_]?use|screenshot|navigate/.test(t)) return 'browser'
  if (t === 'websearch' || t === 'webfetch' || /search|fetch|research|docs/.test(t)) return 'research'
  if (t === 'edit' || t === 'write' || t === 'multiedit' || t === 'notebookedit') {
    const file = String(input.file_path ?? input.notebook_path ?? '')
    return DESIGN_EXT.has(extname(file)) ? 'design' : 'code'
  }
  if (t === 'bash' || t === 'powershell') return 'code'
  return null
}

export const badgeOf = (counts: AgentRec['badgeCounts'], subagentType = ''): AgentBadge => {
  const order: [BadgeKind, AgentBadge][] = [
    ['browser', 'Browser'],
    ['design', 'Design'],
    ['research', 'Research'],
    ['code', 'Code'],
  ]
  let best: AgentBadge | null = null
  let max = 0
  for (const [k, label] of order) {
    if (counts[k] > max) {
      max = counts[k]
      best = label
    }
  }
  if (best) return best
  if (/explore|research|search/i.test(subagentType)) return 'Research'
  if (/design|ui|ux/i.test(subagentType)) return 'Design'
  return 'General'
}

export type StuckVerdict = { stuck: boolean; reason: string | null; since: number | null }

/**
 * Stuck = no tool call, no model step and no streamed output for `stuckMs`.
 * A running command gets its own timeout first. Speed relative to other agents never counts.
 */
export const evaluateStuck = (rec: AgentRec, now: number, stuckMs: number): StuckVerdict => {
  if (rec.status !== 'running' && rec.status !== 'stuck') return { stuck: false, reason: null, since: null }
  if (rec.command) {
    const over = now - rec.command.startedAt - rec.command.timeoutMs
    if (over < 0) return { stuck: false, reason: null, since: null }
    return {
      stuck: true,
      reason: `Command "${truncate(rec.command.label, 40)}" is past its ${fmtDuration(rec.command.timeoutMs)} timeout`,
      since: rec.command.startedAt + rec.command.timeoutMs,
    }
  }
  const idle = now - rec.lastActivityAt
  if (idle < stuckMs) return { stuck: false, reason: null, since: null }
  return {
    stuck: true,
    reason: `No tool call, model step or output for ${fmtDuration(idle)}`,
    since: rec.lastActivityAt + stuckMs,
  }
}

export const isFinished = (s: AgentStatusKind): boolean => s === 'completed' || s === 'failed' || s === 'stopped'

export const isNearTimeout = (rec: AgentRec, now: number): boolean =>
  rec.command !== null && now - rec.command.startedAt >= rec.command.timeoutMs * 0.8

/** Priority band: 0 pinned stuck > 1 high consumption (or acknowledged stuck) > 2 active > 3 waiting > 4 finished. */
export const bandOf = (rec: AgentRec, s: Pick<ToolkitSettings, 'agentTokenWarn'>, now: number): number => {
  if (rec.status === 'stuck') return rec.acknowledged ? 1 : 0
  if (isFinished(rec.status)) return 4
  if (rec.status === 'waiting') return 3
  if ((rec.tokens ?? 0) >= s.agentTokenWarn || isNearTimeout(rec, now)) return 1
  return 2
}

export const isPinned = (rec: AgentRec): boolean => rec.status === 'stuck' && !rec.acknowledged

/**
 * Stable order: agents sort by band; within a band they keep their previous order, so a
 * minor metric change never reorders. Pinned stuck agents sort by severity, then time stuck.
 */
export const orderAgents = (prev: readonly string[], recs: Record<string, AgentRec>): string[] => {
  const ids = Object.keys(recs)
  const pos = new Map(prev.map((id, i) => [id, i] as const))
  const severity = (r: AgentRec) => (r.command !== null ? 1 : 0) // a hung command over an idle agent
  return ids.sort((a, b) => {
    const ra = recs[a]!
    const rb = recs[b]!
    if (ra.band !== rb.band) return ra.band - rb.band
    if (ra.band === 0) {
      const sv = severity(rb) - severity(ra)
      if (sv !== 0) return sv
      const sa = ra.stuckSince ?? Infinity
      const sb = rb.stuckSince ?? Infinity
      if (sa !== sb) return sa - sb
    }
    const pa = pos.get(a)
    const pb = pos.get(b)
    if (pa !== undefined && pb !== undefined) return pa - pb
    if (pa !== undefined) return -1
    if (pb !== undefined) return 1
    return ra.startedAt - rb.startedAt
  })
}

/** Re-bands every agent; the order changes only when some band changed or agents came or went. */
export const refreshOrder = (st: AgentsState, s: Pick<ToolkitSettings, 'agentTokenWarn'>, now: number): AgentsState => {
  let changed = false
  const recs: Record<string, AgentRec> = {}
  for (const [id, r] of Object.entries(st.recs)) {
    const band = bandOf(r, s, now)
    if (band !== r.band) changed = true
    recs[id] = band === r.band ? r : { ...r, band }
  }
  const sameMembers = st.order.length === Object.keys(recs).length && st.order.every(id => id in recs)
  if (!changed && sameMembers) return st.recs === recs ? st : { ...st, recs }
  return { ...st, recs, order: orderAgents(st.order, recs) }
}

/** Applies the stuck verdict: marks stuck, or recovers (status back to running, pin and acknowledgement cleared). */
export const applyStuck = (rec: AgentRec, now: number, stuckMs: number): AgentRec => {
  const v = evaluateStuck(rec, now, stuckMs)
  if (v.stuck && rec.status === 'running') {
    return { ...rec, status: 'stuck', stuckSince: v.since ?? now, stuckReason: v.reason, acknowledged: false }
  }
  if (v.stuck && rec.status === 'stuck') return rec.stuckReason === v.reason ? rec : { ...rec, stuckReason: v.reason }
  if (!v.stuck && rec.status === 'stuck') return recovered(rec)
  return rec
}

export const recovered = (rec: AgentRec): AgentRec =>
  rec.status === 'stuck' ? { ...rec, status: 'running', stuckSince: null, stuckReason: null, acknowledged: false } : rec

/** Any sign of life: a tool call, a step, a streamed chunk. Recovers a stuck agent. */
export const touch = (rec: AgentRec, now: number, activity?: string): AgentRec => {
  const base = recovered(rec)
  return {
    ...base,
    status: base.status === 'waiting' ? 'running' : base.status,
    lastActivityAt: now,
    lastActivity: activity ?? base.lastActivity,
  }
}

export const tokensPerSecond = (rec: Pick<AgentRec, 'outputTokens' | 'genMs'>): number | null =>
  rec.genMs >= 500 && rec.outputTokens > 0 ? rec.outputTokens / (rec.genMs / 1000) : null

export type Summary = {
  total: number
  active: number
  stuck: number
  top: { model: string; tokens: number } | null
  fastest: { model: string; rate: number } | null
  totalTokens: number | null
}

export const summarize = (st: AgentsState): Summary => {
  const recs = Object.values(st.recs)
  let top: Summary['top'] = null
  let fastest: Summary['fastest'] = null
  let total: number | null = null
  for (const r of recs) {
    if (r.tokens !== null) {
      total = (total ?? 0) + r.tokens
      if (top === null || r.tokens > top.tokens) top = { model: r.model ?? DASH, tokens: r.tokens }
    }
    const rate = tokensPerSecond(r)
    if (rate !== null && (fastest === null || rate > fastest.rate)) fastest = { model: r.model ?? DASH, rate }
  }
  return {
    total: recs.length,
    active: recs.filter(r => r.status === 'running' || r.status === 'stuck').length,
    stuck: recs.filter(r => r.status === 'stuck').length,
    top,
    fastest,
    totalTokens: total,
  }
}

export const statusColor = (rec: AgentRec, s: Pick<ToolkitSettings, 'agentTokenWarn' | 'agentTokenCritical'>, now: number): string => {
  if (rec.status === 'stuck' || rec.status === 'failed') return C.red
  if ((rec.tokens ?? 0) >= s.agentTokenCritical) return C.red
  if ((rec.tokens ?? 0) >= s.agentTokenWarn || isNearTimeout(rec, now)) return C.orange
  if (rec.status === 'running' || rec.status === 'completed') return C.green
  if (rec.status === 'stopped') return C.blue
  return C.grey
}

export const newAgent = (id: string, name: string, model: string | null, now: number, subagentType = ''): AgentRec => ({
  id,
  name: name || 'Subagent',
  badge: badgeOf({ research: 0, design: 0, code: 0, browser: 0 }, subagentType),
  badgeCounts: { research: 0, design: 0, code: 0, browser: 0 },
  status: 'waiting',
  model,
  tokens: null,
  outputTokens: 0,
  genMs: 0,
  startedAt: now,
  endedAt: null,
  lastActivityAt: now,
  lastActivity: 'Starting',
  command: null,
  stuckSince: null,
  stuckReason: null,
  acknowledged: false,
  mainFile: null,
  note: null,
  stopRequested: false,
  band: 3,
})

export const PAGE_SIZE = 4

export const clampPage = (page: number, count: number, size = PAGE_SIZE): number =>
  Math.max(0, Math.min(page, Math.max(0, Math.ceil(count / size) - 1)))

// ---- Task bar ----
export type Todo = { content: string; status: string; activeForm?: string }

export const taskBarFromTodos = (todos: readonly Todo[], title: string, hidden: string | null): TaskBar | null => {
  if (todos.length === 0) return null
  const done = todos.filter(t => t.status === 'completed').length
  const now = todos.find(t => t.status === 'in_progress')
  const next = todos.find(t => t.status === 'pending')
  const signature = todos.map(t => t.content).join('\u0001')
  return {
    title,
    done,
    total: todos.length,
    current: now ? now.activeForm || now.content : done === todos.length ? 'All done' : next?.content ?? DASH,
    signature,
    hiddenSignature: hidden,
  }
}

export const taskPct = (t: TaskBar): number => (t.total === 0 ? 0 : Math.round((t.done / t.total) * 100))

// ---------------------------------------------------------------------------
// Session wiring
// ---------------------------------------------------------------------------

// Task tools: TaskCreate/TaskUpdate ids -> todo rows (module memory, rebuilt as tasks change).
const taskList = new Map<string, Todo>()
let planTitle = 'Plan'
let mainToolCalls = 0
let usedTodoThisTask = false
let remindedThisTask = false
const lastWrite = new Map<string, number>()

export const setPlanTitle = (prompt: string): void => {
  const first = prompt.trim().split(/\r?\n/)[0] ?? ''
  planTitle = truncate(first.replace(/^\d+\.\s*/, ''), 48) || 'Plan'
  mainToolCalls = 0
  usedTodoThisTask = false
  remindedThisTask = false
}

async function setTasks($: EngineInterface, todos: Todo[]): Promise<void> {
  await update($, tasksAtom, prev => taskBarFromTodos(todos, planTitle, prev?.hiddenSignature ?? null))
}

export async function updateAgent(
  $: EngineInterface,
  id: string,
  fn: (r: AgentRec) => AgentRec,
): Promise<void> {
  const s = await getSettings($)
  const now = await $.clock.now()
  await update($, agentsAtom, st => {
    const r = st.recs[id]
    if (!r) return st
    return refreshOrder({ ...st, recs: { ...st.recs, [id]: fn(r) } }, s, now)
  })
}

/** Writes a sign of life at most every 3 s per agent (stream chunks come fast). */
export async function touchAgent($: EngineInterface, id: string, activity?: string, force = false): Promise<void> {
  const now = await $.clock.now()
  const last = lastWrite.get(id) ?? 0
  if (!force && activity === undefined && now - last < 3000) return
  lastWrite.set(id, now)
  await updateAgent($, id, r => touch(r, now, activity))
}

export const describeCall = (tool: string, input: Record<string, unknown>): string => {
  const pick = input.command ?? input.file_path ?? input.pattern ?? input.query ?? input.url ?? input.description ?? ''
  const arg = typeof pick === 'string' ? (tool === 'Bash' ? pick : basename(pick) || pick) : ''
  return truncate(arg ? `${tool} ${arg}` : tool, 60)
}

export async function requestStop($: EngineInterface, id: string, note: string): Promise<void> {
  await updateAgent($, id, r => (isFinished(r.status) ? r : { ...r, stopRequested: true, note }))
  void log($, 'helper-desk', `stop requested for ${id}: ${note}`)
  try {
    // C2: TaskStop accepts agent ids; the turn.step guard also ends it at its next model step.
    await $.tool.call({ tool: 'TaskStop', task_id: id })
  } catch {
    // The step guard still ends it.
  }
}

export async function stopAll($: EngineInterface): Promise<void> {
  const st = await read($, agentsAtom)
  for (const r of Object.values(st.recs)) if (!isFinished(r.status)) await requestStop($, r.id, 'Stopped from Helper Desk')
}

export async function acknowledge($: EngineInterface, id: string): Promise<void> {
  await updateAgent($, id, r => (r.status === 'stuck' ? { ...r, acknowledged: true } : r))
}

/** Every 2 s: stuck detection, reconcile with the engine's agent list, the all-done notification. */
export async function helperTick($: EngineInterface): Promise<void> {
  const st0 = await read($, agentsAtom)
  if (Object.keys(st0.recs).length === 0) return
  const s = await getSettings($)
  const now = await $.clock.now()
  let listed: Map<string, string> | null = null
  try {
    listed = new Map((await $.agent.list()).map(a => [a.id, a.status] as const))
  } catch {
    listed = null
  }
  const stuckMs = s.stuckMinutes * 60_000
  let finishedNow = false
  await update($, agentsAtom, st => {
    const recs: Record<string, AgentRec> = {}
    for (const [id, r0] of Object.entries(st.recs)) {
      let r = r0
      const engine = listed?.get(id)
      if (!isFinished(r.status) && engine !== undefined) {
        if (engine === 'completed') r = { ...r, status: 'completed', endedAt: now, command: null }
        else if (engine === 'failed') r = { ...r, status: 'failed', endedAt: now, command: null }
        else if (engine === 'killed') r = { ...r, status: 'stopped', endedAt: now, command: null, note: r.note ?? 'Stopped' }
      }
      if (!isFinished(r.status)) r = applyStuck(r, now, stuckMs)
      recs[id] = r
    }
    const next = refreshOrder({ ...st, recs }, s, now)
    const all = Object.values(next.recs)
    if (!next.allDoneNotified && all.length > 0 && all.every(r => isFinished(r.status))) {
      finishedNow = true
      return { ...next, allDoneNotified: true }
    }
    return next
  })
  if (finishedNow) {
    const all = Object.values((await read($, agentsAtom)).recs)
    const failed = all.filter(r => r.status === 'failed').length
    void notify($, 'Helper Desk', `All ${all.length} subagents finished${failed ? ` (${failed} failed)` : ''}.`)
  }
}

export async function helperdeskSpawned($: EngineInterface, e: AgentSpawnInput, r: AgentSpawnResult): Promise<void> {
  if (!(await isOn($, 'helperDesk'))) return
  if (!('agentId' in r) || typeof r.agentId !== 'string') return
  const now = await $.clock.now()
  const rec = newAgent(r.agentId, e.description || e.subagentType, r.model ?? e.model ?? null, now, e.subagentType)
  const s = await getSettings($)
  await update($, agentsAtom, st => refreshOrder({ ...st, allDoneNotified: false, recs: { ...st.recs, [rec.id]: rec } }, s, now))
  // The pane opens itself when subagents start.
  void $.ui.open({ id: 'toolkit', title: 'Toolkit' })
}

export async function helperdeskTurnStart($: EngineInterface, agentId: string | undefined): Promise<void> {
  if (agentId !== undefined) await touchAgent($, agentId, 'Thinking', true)
}

export async function helperdeskToolPre($: EngineInterface, tool: string, input: ToolInput): Promise<void> {
  if (!(await isOn($, 'helperDesk'))) return
  const agentId = input.agentId
  if (agentId !== undefined) {
    const now = await $.clock.now()
    const kind = badgeKindOf(tool, input)
    await updateAgent($, agentId, r0 => {
      const r = touch(r0, now, describeCall(tool, input))
      const counts = kind ? { ...r.badgeCounts, [kind]: r.badgeCounts[kind] + 1 } : r.badgeCounts
      const isCmd = tool === 'Bash' || tool === 'PowerShell'
      const timeout = typeof input.timeout === 'number' ? input.timeout : 120_000
      const file = typeof input.file_path === 'string' && /^(Write|Edit|MultiEdit)$/.test(tool) ? input.file_path : null
      return {
        ...r,
        badgeCounts: counts,
        badge: badgeOf(counts),
        command: isCmd ? { startedAt: now, timeoutMs: timeout, label: String(input.command ?? tool) } : r.command,
        mainFile: tool === 'Write' && file ? file : r.mainFile ?? file,
      }
    })
    return
  }
  mainToolCalls++
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    usedTodoThisTask = true
    await setTasks($, input.todos as Todo[])
  }
}

export async function helperdeskToolPost($: EngineInterface, tool: string, input: ToolInput, ran: ToolCallResult): Promise<string[] | void> {
  if (!(await isOn($, 'helperDesk'))) return
  const agentId = input.agentId
  if (agentId !== undefined) {
    await updateAgent($, agentId, r => ({ ...r, command: null }))
    await touchAgent($, agentId, undefined, true)
    return
  }
  if (tool === 'TaskCreate' && ran.deny === undefined) {
    usedTodoThisTask = true
    const id = /#?(\d+)/.exec(ran.text ?? '')?.[1] ?? String(taskList.size + 1)
    taskList.set(id, { content: String(input.subject ?? 'Task'), status: 'pending', activeForm: String(input.activeForm ?? '') })
    await setTasks($, [...taskList.values()])
  } else if (tool === 'TaskUpdate' && ran.deny === undefined) {
    usedTodoThisTask = true
    const id = String(input.taskId ?? '')
    const t = taskList.get(id)
    if (t) {
      if (input.status === 'deleted') taskList.delete(id)
      else
        taskList.set(id, {
          ...t,
          status: typeof input.status === 'string' ? input.status : t.status,
          content: typeof input.subject === 'string' ? input.subject : t.content,
        })
      await setTasks($, [...taskList.values()])
    }
  }
  // One short reminder per task, only once it has 3+ tool calls and no to-do list.
  if (mainToolCalls >= 3 && !usedTodoThisTask && !remindedThisTask) {
    remindedThisTask = true
    return ['Toolkit: this task has several steps. Keep a short to-do list (TodoWrite) and update it as you go.']
  }
}

export async function helperdeskTurnComplete($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  if (e.agentId === undefined) return
  const id = e.agentId
  const now = await $.clock.now()
  await updateAgent($, id, r => ({
    ...r,
    status: r.stopRequested || e.isAborted ? 'stopped' : 'reason' in e && e.reason === 'refusal' ? 'failed' : 'completed',
    endedAt: now,
    command: null,
    stuckSince: null,
    lastActivity: r.stopRequested ? r.lastActivity : 'Finished',
  }))
}

/** Called around each subagent model step by the central turn.step hook. */
export async function onAgentStepStart($: EngineInterface, agentId: string): Promise<boolean> {
  const st = await read($, agentsAtom)
  const r = st.recs[agentId]
  if (r?.stopRequested) return false
  await touchAgent($, agentId, 'Model step', true)
  return true
}

export async function onAgentStepEnd(
  $: EngineInterface,
  agentId: string,
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; model: string } | null,
  genMs: number,
): Promise<void> {
  const s = await getSettings($)
  const now = await $.clock.now()
  let overLimit = false
  await updateAgent($, agentId, r0 => {
    const r = touch(r0, now)
    if (!usage) return r
    const added = usage.input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
    const tokens = (r.tokens ?? 0) + added
    overLimit = tokens > s.agentTokenLimit && !r.stopRequested
    return {
      ...r,
      model: usage.model || r.model,
      tokens,
      outputTokens: r.outputTokens + usage.output_tokens,
      genMs: r.genMs + Math.max(0, genMs),
    }
  })
  if (overLimit) await requestStop($, agentId, `Auto-stopped: passed the ${fmtTokens(s.agentTokenLimit)} token limit`)
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export async function renderTaskBar($: EngineInterface, E: Els, columns: number): Promise<RenderElement | null> {
  const t = await read($, tasksAtom)
  if (t === null || t.signature === t.hiddenSignature) return null
  const { Box, Text, Button } = E
  const pct = taskPct(t)
  const barW = Math.max(8, Math.min(30, columns - 40))
  const filled = Math.round((pct / 100) * barW)
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={C.purpleSoft} bold>
        {truncate(t.title, 28)}
      </Text>
      <Text color={C.purple}>{'█'.repeat(filled)}</Text>
      <Text color={C.borderSoft}>{'░'.repeat(barW - filled)}</Text>
      <Text color={C.text}>
        Tasks {t.done}/{t.total} · {pct}%
      </Text>
      <Text color={C.muted} wrap="truncate-end">
        Now: {truncate(t.current, 40)}
      </Text>
      <Button key="tasks-hide" plain label="✕" onPress={() => void update($, tasksAtom, x => (x ? { ...x, hiddenSignature: x.signature } : x))} />
    </Box>
  )
}

/** The monitor: a fixed, bounded block of `rows` rows. Never grows with the agent count. */
export async function renderMonitor($: EngineInterface, E: Els, rows: number, columns: number): Promise<RenderElement> {
  const { Box, Text, Button } = E
  const st = await read($, agentsAtom)
  const s = await getSettings($)
  const now = await $.clock.now()
  const sum = summarize(st)
  const perPage = Math.max(3, Math.min(PAGE_SIZE, Math.floor((rows - 3) / 2)))
  const page = clampPage(st.page, st.order.length, perPage)
  const shown = st.order.slice(page * perPage, page * perPage + perPage).map(id => st.recs[id]!).filter(Boolean)
  const before = page * perPage
  const after = Math.max(0, st.order.length - before - shown.length)
  const narrow = columns < 56

  const card = (r: AgentRec): RenderElement => {
    const col = statusColor(r, s, now)
    const pinned = isPinned(r)
    const ack = r.status === 'stuck' && r.acknowledged
    const dur = (r.endedAt ?? now) - r.startedAt
    const label =
      r.status === 'stuck'
        ? `Stuck ${fmtDuration(now - (r.stuckSince ?? now))}`
        : r.status[0]!.toUpperCase() + r.status.slice(1)
    const line2 = pinned || ack
      ? `${r.stuckReason ?? 'No progress'}`
      : `${fmtTokens(r.tokens)} tok · ${fmtRate(tokensPerSecond(r))} · ${fmtDuration(dur)} · ${truncate(r.lastActivity, 28)} ${fmtAgo(now - r.lastActivityAt)}`
    return (
      <Box key={`agent-${r.id}`} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={ack ? C.grey : col}>{ack ? '┆' : pinned ? '▲' : '●'}</Text>
          <Text color={ack ? C.muted : C.text} bold={pinned} wrap="truncate-end">
            {truncate(r.name, narrow ? 18 : 30)}
          </Text>
          <Text color={C.purpleSoft}>[{r.badge}]</Text>
          <Text color={col}>{label}</Text>
          {!narrow ? <Text color={C.muted}>{r.model ?? DASH}</Text> : null}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text color={C.muted} dimColor={ack} wrap="truncate-end">
            {r.note ? `${r.note} · ` : ''}
            {line2}
          </Text>
          {pinned ? <Button key={`ack-${r.id}`} label="Acknowledge" onPress={() => void acknowledge($, r.id)} /> : null}
          {!isFinished(r.status) ? (
            <Button key={`stop-${r.id}`} label="Stop" onPress={() => void requestStop($, r.id, 'Stopped by you')} />
          ) : null}
          {isFinished(r.status) && r.mainFile ? (
            <Button key={`open-${r.id}`} label="Open result" onPress={() => void launch($, r.mainFile!)} />
          ) : null}
        </Box>
      </Box>
    )
  }

  const setPage = (p: number) =>
    update($, agentsAtom, x => ({ ...x, page: clampPage(p, x.order.length, perPage) }))

  return (
    <Box flexDirection="column" height={rows} overflow="hidden">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={C.text}>
          Helper Desk · {sum.total} subagent{sum.total === 1 ? '' : 's'}
        </Text>
        {sum.active > 0 ? <Button key="stop-all" label="Stop all" onPress={() => void stopAll($)} /> : <Text> </Text>}
      </Box>
      <Text color={C.muted} wrap="truncate-end">
        Active {sum.active} · <Text color={sum.stuck ? C.red : C.muted}>Stuck {sum.stuck}</Text> · Top{' '}
        {sum.top ? `${sum.top.model} ${fmtTokens(sum.top.tokens)}` : DASH} · Fastest{' '}
        {sum.fastest ? `${sum.fastest.model} ${fmtRate(sum.fastest.rate)}` : DASH} · Total {fmtTokens(sum.totalTokens)}
      </Text>
      {shown.length === 0 ? <Text color={C.grey}>No subagents yet.</Text> : null}
      {shown.map(card)}
      {st.order.length > perPage ? (
        <Box flexDirection="row" gap={1}>
          {before > 0 ? <Button key="agents-prev" label={`▲ ${before} above`} onPress={() => void setPage(page - 1)} /> : null}
          {after > 0 ? <Button key="agents-next" label={`+${after} more ▼`} onPress={() => void setPage(page + 1)} /> : null}
        </Box>
      ) : null}
    </Box>
  )
}
