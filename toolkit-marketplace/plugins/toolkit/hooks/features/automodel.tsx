// Feature 7: Auto Model. Picks Haiku / Sonnet / Opus per task from free local signals, applies it
// per model request (turn.step), and only switches mid-chat when the prompt cache allows it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement } from 'claude-code'

import type { AutoRecord, AutoState, Tier } from '../../types'
import type { ToolInput } from './bus'
import type { AgentSpawnInput, AgentSpawnResult, ToolCallResult, TurnCompleteInput } from 'claude-code'
import { classifyReply } from './projectmap'
import { getSettings, isOn, log, readJson, saveSettings, writeJson } from './settings'
import { C, fmtTokens, words } from './ui'
import type { Els } from './ui'

export const EMPTY_AUTO: AutoState = {
  tier: null,
  reasons: [],
  files: 0,
  savingPct: null,
  action: null,
  decidedBy: null,
  mainTier: null,
  taskKind: null,
  escalations: 0,
}
export const autoAtom = atom({ plugin: 'toolkit', key: 'auto' } as const, EMPTY_AUTO)

export const TIERS: Tier[] = ['haiku', 'sonnet', 'opus']
export const TIER_LABEL: Record<Tier, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }
/** Relative price per token (Opus = 1), from the published list prices of the 4.5 generation ($1 / $3 / $5 input). */
export const WEIGHT: Record<Tier, number> = { haiku: 0.2, sonnet: 0.6, opus: 1 }

// ---------------------------------------------------------------------------
// Pure logic (tested)
// ---------------------------------------------------------------------------

export type SignalInput = { text: string; files: number; hasImage: boolean; repeatedError: boolean }
export type Signals = { tier: Tier; confident: boolean; reasons: string[]; kind: string }

const PLAN_RE = /\b(plan|planning|architect(?:ure)?|redesign|re-?architect|overhaul|from scratch|design system|migrat(?:e|ion)|strategy|roadmap|refactor (?:the )?(?:whole|entire|all)|build (?:me )?(?:a|an|the) (?:full|complete|new) (?:app|site|store|system)|end[- ]to[- ]end|multi-?step|database schema)\b/i
const SMALL_RE = /\b(typo|rename|small|quick|tiny|one[- ]line|minor|bump|tweak|change the (?:text|colou?r|label|title|wording)|fix the (?:spacing|padding|margin|colou?r|typo)|add a comment|update the (?:text|copy)|swap)\b/i
const ERROR_RE = /(Traceback \(most recent call last\)|\bError:|\bException\b|\bat [\w.$<>]+ \(.+:\d+:\d+\)|\bTypeError\b|\bReferenceError\b|\bSyntaxError\b|stack trace|exit code [1-9])/
const QUESTION_RE = /^\s*(what|why|how|where|which|who|when|is|are|does|do|can|could)\b[^\n]{0,200}\?\s*$/i

export const readSignals = (x: SignalInput): Signals => {
  const n = words(x.text).length
  const reasons: string[] = []
  let score = 0 // <0 small, >0 big
  let kind = 'feature'
  if (PLAN_RE.test(x.text)) {
    score += 3
    reasons.push('planning / architecture words')
    kind = /redesign|design system/i.test(x.text) ? 'design' : 'plan'
  }
  if (SMALL_RE.test(x.text)) {
    score -= 2
    reasons.push('small-fix wording')
    kind = 'fix'
  }
  if (QUESTION_RE.test(x.text) && n < 40) {
    score -= 2
    reasons.push('short question')
    kind = 'question'
  }
  if (ERROR_RE.test(x.text)) {
    score += 1
    reasons.push('error / stack trace')
    kind = 'debug'
  }
  if (x.hasImage) {
    score += 1
    reasons.push('screenshot attached')
  }
  if (x.repeatedError) {
    score += 3
    reasons.push('same error twice')
  }
  if (n > 250) {
    score += 2
    reasons.push(`${n} words`)
  } else if (n < 25 && !PLAN_RE.test(x.text)) {
    score -= 1
    reasons.push('short message')
  }
  if (x.files >= 5) {
    score += 2
    reasons.push(`${x.files} files`)
  } else if (x.files >= 2) {
    score += 1
    reasons.push(`${x.files} files`)
  } else if (x.files === 1) reasons.push('1 file')
  const tier: Tier = score >= 3 ? 'opus' : score <= -2 ? 'haiku' : 'sonnet'
  const confident = score >= 3 || score <= -2 || (score >= 0 && score <= 1 && reasons.length >= 2)
  return { tier, confident, reasons, kind }
}

export const stepUp = (t: Tier): Tier => (t === 'haiku' ? 'sonnet' : 'opus')
export const stepDown = (t: Tier): Tier => (t === 'opus' ? 'sonnet' : 'haiku')

export const tierOfModel = (model: string | null | undefined): Tier | null => {
  const m = (model ?? '').toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('opus')) return 'opus'
  return null
}

export type SwitchInput = {
  current: Tier | null
  target: Tier
  contextTokens: number | null
  cacheCold: boolean
  chatStart: boolean
  budgetPct: number | null
  escalated: boolean
  taskTokens?: number
}
export type SwitchDecision = { action: 'switch' | 'keep' | 'route'; tier: Tier; reason: string; savingPct: number }

/** Est. cost of one task in Opus-input-token units: stay = cached read; switch = cold write of the context. */
export const switchCosts = (current: Tier, target: Tier, context: number, taskTokens = 8000): { stay: number; move: number } => ({
  stay: WEIGHT[current] * (context * 0.1 + taskTokens),
  move: WEIGHT[target] * (context * 1.25 + taskTokens),
})

export const decideSwitch = (x: SwitchInput): SwitchDecision => {
  let target = x.target
  let budget = ''
  if (!x.escalated && (x.budgetPct ?? 0) >= 80 && target !== 'haiku') {
    target = stepDown(target)
    budget = ' (leaning cheaper: plan usage over 80%)'
  }
  const saving = (t: Tier) => Math.round((1 - WEIGHT[t] / WEIGHT.opus) * 100)
  const cur = x.current
  if (cur === null || x.chatStart) return { action: 'switch', tier: target, reason: `chat start${budget}`, savingPct: saving(target) }
  if (cur === target) return { action: 'keep', tier: cur, reason: `already on ${TIER_LABEL[cur]}${budget}`, savingPct: saving(cur) }
  if (x.escalated) return { action: 'switch', tier: target, reason: 'escalated after a rejection or repeated error', savingPct: saving(target) }
  const ctx = x.contextTokens ?? 0
  if (ctx < 30_000) return { action: 'switch', tier: target, reason: `small chat (${fmtTokens(ctx)})${budget}`, savingPct: saving(target) }
  if (x.cacheCold) return { action: 'switch', tier: target, reason: `cache already cold${budget}`, savingPct: saving(target) }
  const c = switchCosts(cur, target, ctx, x.taskTokens)
  if (c.move < c.stay) return { action: 'switch', tier: target, reason: `saving beats the re-read${budget}`, savingPct: saving(target) }
  if (WEIGHT[target] < WEIGHT[cur]) {
    return { action: 'route', tier: cur, reason: `keeping ${TIER_LABEL[cur]} (warm cache); small job routed to a Haiku subagent`, savingPct: saving(cur) }
  }
  return { action: 'keep', tier: cur, reason: `keeping ${TIER_LABEL[cur]}: re-reading ${fmtTokens(ctx)} costs more`, savingPct: saving(cur) }
}

export const emptyRecord = (now: number): AutoRecord => ({
  byTask: {},
  overrides: 0,
  week: { start: now, tasks: { haiku: 0, sonnet: 0, opus: 0 }, tokens: { haiku: 0, sonnet: 0, opus: 0 } },
})

export const recordOutcome = (r: AutoRecord, kind: string, tier: Tier, accepted: boolean): AutoRecord => {
  const row = r.byTask[kind] ?? { haiku: { accepted: 0, rejected: 0 }, sonnet: { accepted: 0, rejected: 0 }, opus: { accepted: 0, rejected: 0 } }
  const cell = row[tier]
  return {
    ...r,
    byTask: {
      ...r.byTask,
      [kind]: { ...row, [tier]: accepted ? { ...cell, accepted: cell.accepted + 1 } : { ...cell, rejected: cell.rejected + 1 } },
    },
  }
}

/** What the record teaches: a cheaper tier that has been accepted reliably, or a step up where this tier keeps failing. */
export const learnedTier = (r: AutoRecord, kind: string, tier: Tier): Tier => {
  const row = r.byTask[kind]
  if (!row) return tier
  const cell = row[tier]
  if (cell.rejected >= 2 && cell.rejected > cell.accepted) return stepUp(tier)
  if (tier !== 'haiku') {
    const lower = row[stepDown(tier)]
    const n = lower.accepted + lower.rejected
    if (n >= 3 && lower.accepted / n >= 0.8) return stepDown(tier)
  }
  return tier
}

export const rollWeek = (r: AutoRecord, now: number): AutoRecord =>
  now - r.week.start >= 7 * 24 * 3600_000 ? { ...r, week: emptyRecord(now).week } : r

export const weekStats = (r: AutoRecord): { saved: number; pct: Record<Tier, number> } => {
  const total = TIERS.reduce((a, t) => a + r.week.tasks[t], 0)
  const pct = { haiku: 0, sonnet: 0, opus: 0 }
  for (const t of TIERS) pct[t] = total === 0 ? 0 : Math.round((r.week.tasks[t] / total) * 100)
  const saved = Math.round(r.week.tokens.haiku * (1 - WEIGHT.haiku) + r.week.tokens.sonnet * (1 - WEIGHT.sonnet))
  return { saved, pct }
}

/** Subagents: Research -> Haiku, Code -> Sonnet, Design -> Opus. */
export const tierForAgent = (subagentType: string, description: string): Tier | null => {
  const t = `${subagentType} ${description}`.toLowerCase()
  if (/design|ui\b|ux\b|layout|landing|visual|style/.test(t)) return 'opus'
  if (/explore|research|search|find|look up|investigate|docs/.test(t)) return 'haiku'
  if (/code|implement|fix|build|test|refactor|general-purpose/.test(t)) return 'sonnet'
  return null
}

export const errorSignature = (text: string): string =>
  (text.split(/\r?\n/).find(l => /error|exception|failed/i.test(l)) ?? text.split(/\r?\n/)[0] ?? '')
    .replace(/\d+/g, '#')
    .replace(/(['"]).*?\1/g, '"…"')
    .trim()
    .slice(0, 160)

// ---------------------------------------------------------------------------
// Session wiring
// ---------------------------------------------------------------------------

let record: AutoRecord | null = null
let turnFiles = new Set<string>()
let lastErrors: string[] = []
let repeatedError = false
let turnIndex = 0
let applyTier: Tier | null = null
let lastTaskTier: Tier | null = null
let lastTaskKind: string | null = null

async function loadRecord($: EngineInterface): Promise<AutoRecord> {
  if (record) return record
  const raw = (await readJson($, 'automodel.json')) as AutoRecord | undefined
  const now = await $.clock.now()
  record = raw && typeof raw === 'object' && raw.week && raw.byTask ? raw : emptyRecord(now)
  record = rollWeek(record, now)
  return record
}

async function saveRecord($: EngineInterface): Promise<void> {
  if (record) await writeJson($, 'automodel.json', record)
}

export const chipText = (a: AutoState, override: Tier | 'auto'): string | undefined => {
  if (override !== 'auto') return `Model: ${TIER_LABEL[override]} (manual)`
  if (a.tier === null) return undefined
  const files = a.files > 0 ? ` · ${a.files} file${a.files === 1 ? '' : 's'}` : ''
  const saving = a.savingPct ? ` · −${a.savingPct}%` : ''
  return `Auto: ${TIER_LABEL[a.tier]}${files}${saving}`
}

export type AutoContext = {
  text: string
  hasImage: boolean
  contextTokens: number | null
  cacheCold: boolean
  budgetPct: number | null
}

/** Decides the model for the message the person just sent; returns a short routing note for the model, if any. */
export async function onUserMessageAuto($: EngineInterface, x: AutoContext): Promise<string | null> {
  const settings = await getSettings($)
  const r = await loadRecord($)
  // Learn from the reply to the previous task.
  const reply = classifyReply(x.text)
  let escalated = false
  if (lastTaskTier && lastTaskKind) {
    record = recordOutcome(r, lastTaskKind, lastTaskTier, reply !== 'reject')
    if (reply === 'reject') escalated = true
  }
  if (repeatedError) escalated = true
  turnIndex++

  if (!settings.features.autoModel) {
    applyTier = null
    $.ui.status(undefined)
    return null
  }
  if (settings.modelOverride !== 'auto') {
    applyTier = settings.modelOverride
    await update($, autoAtom, (a): AutoState => ({ ...a, tier: settings.modelOverride as Tier, action: 'switch', decidedBy: 'override', reasons: ['your choice'] }))
    $.ui.status(chipText(await read($, autoAtom), settings.modelOverride))
    return null
  }

  const sig = readSignals({ text: x.text, files: turnFiles.size, hasImage: x.hasImage, repeatedError })
  let target = sig.tier
  let decidedBy: AutoState['decidedBy'] = 'rules'
  if (!sig.confident) {
    try {
      const label = await $.model.classify(x.text.slice(0, 2000), ['small', 'normal', 'big'], { model: 'haiku' })
      if (label) {
        target = label === 'small' ? 'haiku' : label === 'big' ? 'opus' : 'sonnet'
        decidedBy = 'haiku'
      }
    } catch {
      // rules stand
    }
  }
  target = learnedTier(record ?? r, sig.kind, target)
  const prev = await read($, autoAtom)
  if (escalated) {
    target = stepUp(prev.mainTier ?? target)
    decidedBy = 'escalate'
  }
  const current = prev.mainTier ?? tierOfModel(await $.session.model())
  const d = decideSwitch({
    current,
    target,
    contextTokens: x.contextTokens,
    cacheCold: x.cacheCold,
    chatStart: turnIndex === 1,
    budgetPct: x.budgetPct,
    escalated,
  })
  applyTier = d.action === 'switch' ? d.tier : null
  lastTaskTier = d.tier
  lastTaskKind = sig.kind
  repeatedError = false
  lastErrors = []
  record = rollWeek(record ?? r, await $.clock.now())
  record.week.tasks[d.tier] += 1
  await saveRecord($)
  const next: AutoState = {
    tier: d.tier,
    reasons: [...sig.reasons, d.reason],
    files: turnFiles.size,
    savingPct: d.savingPct,
    action: d.action,
    decidedBy,
    mainTier: d.tier,
    taskKind: sig.kind,
    escalations: prev.escalations + (escalated ? 1 : 0),
  }
  await update($, autoAtom, () => next)
  $.ui.status(chipText(next, 'auto'))
  void log($, 'auto-model', `${d.action} ${d.tier} (${decidedBy}): ${next.reasons.join('; ')}`)
  turnFiles = new Set()
  return d.action === 'route' ? 'Toolkit: this is a small job. Do it in one subagent with model "haiku" to save tokens.' : null
}

/** The main thread's model for this request, or null to leave it. */
export const mainStepModel = (): Tier | null => applyTier

export async function setOverride($: EngineInterface, t: Tier | 'auto'): Promise<void> {
  await saveSettings($, s => ({ ...s, modelOverride: t }))
  const r = await loadRecord($)
  if (t !== 'auto') {
    record = { ...r, overrides: r.overrides + 1 }
    const kind = (await read($, autoAtom)).taskKind
    if (kind) record = recordOutcome(record, kind, t, true)
    await saveRecord($)
    applyTier = t
  }
  $.ui.status(chipText(await read($, autoAtom), t))
}

export async function automodelSpawnModel($: EngineInterface, e: AgentSpawnInput): Promise<string | null> {
  if (e.model || !(await isOn($, 'autoModel'))) return null
  return tierForAgent(e.subagentType, e.description)
}

export async function automodelToolPost(_$: EngineInterface, _tool: string, input: ToolInput, ran: ToolCallResult): Promise<string[] | void> {
  if (input.agentId !== undefined) return
  if (typeof input.file_path === 'string') turnFiles.add(input.file_path)
  if (ran.isError === true && typeof ran.text === 'string') {
    const sig = errorSignature(ran.text)
    if (sig && lastErrors.includes(sig)) repeatedError = true
    lastErrors = [...lastErrors, sig].slice(-6)
  }
}

export async function automodelTurnComplete($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  if (e.agentId !== undefined || !e.usage) return
  const u = e.usage
  const t = tierOfModel(u.model)
  if (!t) return
  const r = await loadRecord($)
  r.week.tokens[t] += u.input_tokens + u.output_tokens + u.cache_creation_input_tokens
  await update($, autoAtom, a => ({ ...a, mainTier: t }))
  await saveRecord($)
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

export async function renderAutoSection($: EngineInterface, E: Els): Promise<RenderElement[]> {
  const { Box, Text, Button } = E
  const a = await read($, autoAtom)
  const s = await getSettings($)
  const r = await loadRecord($)
  const stats = weekStats(r)
  const on = s.features.autoModel
  const active = s.modelOverride === 'auto' ? a.tier : s.modelOverride
  return [
    <Box flexDirection="row" justifyContent="space-between">
      <Text bold color={C.pink}>
        Auto Model
      </Text>
      <Button
        key="auto-toggle"
        label={on ? 'ON' : 'OFF'}
        variant={on ? 'primary' : 'secondary'}
        onPress={() => void saveSettings($, x => ({ ...x, features: { ...x.features, autoModel: !x.features.autoModel } }))}
      />
    </Box>,
    <Text color={C.text}>
      In use: {active ? TIER_LABEL[active] : '—'}
      {s.modelOverride !== 'auto' ? ' (manual)' : a.action ? ` · ${a.action}` : ''}
    </Text>,
    <Text color={C.muted} wrap="wrap">
      {a.reasons.length ? a.reasons.slice(0, 4).join(' · ') : 'Decides on your next message.'}
    </Text>,
    <Box flexDirection="row" gap={1}>
      {TIERS.map(t => (
        <Button
          key={`auto-${t}`}
          label={`${active === t ? '● ' : ''}${TIER_LABEL[t]}`}
          variant={active === t ? 'primary' : 'secondary'}
          onPress={() => void setOverride($, t)}
        />
      ))}
      <Button key="auto-auto" label={s.modelOverride === 'auto' ? '● Auto' : 'Auto'} onPress={() => void setOverride($, 'auto')} />
    </Box>,
    <Text color={C.muted}>
      This week: ~{fmtTokens(stats.saved)} Opus-equivalent tokens saved · Haiku {stats.pct.haiku}% · Sonnet {stats.pct.sonnet}% · Opus{' '}
      {stats.pct.opus}%
    </Text>,
  ]
}
