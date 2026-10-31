// Feature 1: Voice Prompt Cleaner.
// A long dictated prompt is held (dropped), Haiku turns it into a short numbered list,
// and the list is sent after a countdown unless the person edits or sends the original.
// The raw transcript is kept only in session memory, never written to disk.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import type { VoiceQuestion, VoiceState } from '../../types'
import { getSettings, guard, isOn, log } from './settings'
import { C, inputOf, svgOf, SVG_NS, words } from './ui'
import type { Els } from './ui'

export const IDLE_VOICE: VoiceState = {
  phase: 'idle',
  original: '',
  items: [],
  unclear: [],
  questions: [],
  secondsLeft: 0,
  isPaused: false,
  error: null,
}

export const voiceAtom = atom({ plugin: 'toolkit', key: 'voice' } as const, IDLE_VOICE)

// ---- Detection (free, local) ----
const FILLERS = [
  /\bu+m+\b/gi,
  /\bu+h+\b/gi,
  /\berm+\b/gi,
  /\bhmm+\b/gi,
  /\byou know\b/gi,
  /\bi mean\b/gi,
  /\bkind of\b/gi,
  /\bsort of\b/gi,
  /\bbasically\b/gi,
  /\bactually\b/gi,
  /\bliterally\b/gi,
  /\bso yeah\b/gi,
  /\bor something\b/gi,
  /\band stuff\b/gi,
  /\bokay so\b/gi,
  /\bright so\b/gi,
  /\blike,/gi,
  /\b(?:was|is|it's|just|and) like\b/gi,
]

export type SpeechSigns = { words: number; fillers: number; repeats: number; newlines: number; listLines: number }

export const speechSigns = (text: string): SpeechSigns => {
  const ws = words(text)
  let fillers = 0
  for (const re of FILLERS) fillers += (text.match(re) ?? []).length
  let repeats = 0
  for (let i = 1; i < ws.length; i++) {
    const a = (ws[i - 1] ?? '').toLowerCase().replace(/[^a-z']/g, '')
    const b = (ws[i] ?? '').toLowerCase().replace(/[^a-z']/g, '')
    if (a.length > 0 && a === b) repeats++
  }
  const lines = text.split(/\r?\n/)
  const listLines = lines.filter(l => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l)).length
  return { words: ws.length, fillers, repeats, newlines: lines.length - 1, listLines }
}

/** True for a long message that reads as dictated speech and is not already shaped. */
export const looksDictated = (text: string, threshold: number): boolean => {
  const t = text.trim()
  if (t.startsWith('/')) return false
  const s = speechSigns(t)
  if (s.words < threshold) return false
  if (s.listLines >= 2) return false // already shaped
  if (/```/.test(t)) return false // code paste
  const fewBreaks = s.newlines <= Math.max(1, Math.floor(s.words / 80))
  const score = s.fillers + s.repeats * 2 + (fewBreaks ? 1 : 0)
  return fewBreaks && score >= 3
}

// ---- The Haiku call ----
export const CLEAN_SYSTEM =
  'You turn a dictated, rambling request into a short numbered list of what the person wants. Reply with JSON only.'

export const cleanPrompt = (transcript: string): string =>
  [
    'Rewrite the request below as a short numbered list of what the person wants.',
    'Rules: keep every fact, name, number, file, path and link exactly. Add nothing new. Drop filler and repeats. Plain short English. At most 12 items.',
    'Then look for real gaps or contradictions only. Ask 0 to 2 questions, each with 2 or 3 short options. Most requests need 0 questions.',
    'Reply as JSON: {"items": ["..."], "questions": [{"q": "...", "options": ["...", "..."], "item": 1}]}',
    '"item" is the 1-based list item the question is about, or null.',
    '',
    '<request>',
    transcript,
    '</request>',
  ].join('\n')

export type CleanResult = { items: string[]; questions: { q: string; options: string[]; item: number | null }[] }

export const parseCleanReply = (reply: string): CleanResult | null => {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data: unknown
  try {
    data = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) return null
  const d = data as { items?: unknown; questions?: unknown }
  if (!Array.isArray(d.items)) return null
  const items = d.items
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map(x => x.trim().replace(/^\d+[.)]\s*/, ''))
    .slice(0, 12)
  if (items.length === 0) return null
  const questions: CleanResult['questions'] = []
  if (Array.isArray(d.questions)) {
    for (const q of d.questions) {
      if (typeof q !== 'object' || q === null) continue
      const qq = q as { q?: unknown; options?: unknown; item?: unknown }
      if (typeof qq.q !== 'string' || !Array.isArray(qq.options)) continue
      const options = qq.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0).slice(0, 3)
      if (options.length < 2) continue
      const item = typeof qq.item === 'number' && qq.item >= 1 && qq.item <= items.length ? qq.item : null
      questions.push({ q: qq.q.trim(), options, item })
      if (questions.length === 2) break
    }
  }
  return { items, questions }
}

/** The text that is sent: the list, answers folded in, skipped points marked unclear. */
export const composeCleaned = (state: Pick<VoiceState, 'items' | 'questions' | 'unclear'>): string => {
  const unclear = new Set(state.unclear)
  for (const q of state.questions) if (q.isSkipped && q.point !== null) unclear.add(q.point)
  const lines = state.items.map((item, i) => `${i + 1}. ${item}${unclear.has(i + 1) ? ' (unclear)' : ''}`)
  const answered = state.questions.filter(q => q.answer !== null)
  const skipped = state.questions.filter(q => q.isSkipped && q.point === null)
  if (answered.length > 0 || skipped.length > 0) lines.push('')
  for (const q of answered) lines.push(`- ${q.text} → ${q.answer}`)
  for (const q of skipped) lines.push(`- ${q.text} → unclear`)
  return lines.join('\n')
}

export const toQuestions = (r: CleanResult, seconds: number): VoiceQuestion[] =>
  r.questions.map((q, i) => ({
    id: `q${i}`,
    text: q.q,
    options: q.options,
    point: q.item,
    answer: null,
    secondsLeft: seconds,
    isSkipped: false,
  }))

/** One second of the countdowns: questions first (15 s each), then the send countdown. */
export const tickVoice = (s: VoiceState): { next: VoiceState; send: boolean } => {
  if (s.phase !== 'review' || s.isPaused) return { next: s, send: false }
  const open = s.questions.find(q => q.answer === null && !q.isSkipped)
  if (open) {
    const questions = s.questions.map(q =>
      q.id === open.id
        ? { ...q, secondsLeft: q.secondsLeft - 1, isSkipped: q.secondsLeft - 1 <= 0 }
        : q,
    )
    return { next: { ...s, questions }, send: false }
  }
  const left = s.secondsLeft - 1
  return { next: { ...s, secondsLeft: Math.max(0, left) }, send: left <= 0 }
}

// ---- Sending ----
async function submitText($: EngineInterface, text: string): Promise<void> {
  try {
    const r = await $.prompt.submit({ text })
    if ('drop' in r && r.drop !== undefined) throw new Error(String(r.drop))
  } catch {
    // C1 fallback: put the text in the box for the person to send.
    await $.prompt.fill({ text, mode: 'replace' })
    $.ui.toast('Toolkit: the cleaned prompt is in the box. Press Enter to send.')
  }
}

export async function sendCleaned($: EngineInterface): Promise<void> {
  const s = await read($, voiceAtom)
  if (s.phase !== 'review') return
  await update($, voiceAtom, () => IDLE_VOICE)
  await submitText($, composeCleaned(s))
}

export async function sendOriginal($: EngineInterface): Promise<void> {
  const s = await read($, voiceAtom)
  if (s.phase === 'idle') return
  await update($, voiceAtom, () => IDLE_VOICE)
  await submitText($, s.original)
}

export async function editCleaned($: EngineInterface): Promise<void> {
  const s = await read($, voiceAtom)
  if (s.phase !== 'review') return
  await update($, voiceAtom, () => IDLE_VOICE)
  await $.prompt.fill({ text: composeCleaned(s), mode: 'replace' })
}

export async function answerQuestion($: EngineInterface, id: string, answer: string): Promise<void> {
  const a = answer.trim()
  if (a.length === 0) return
  await update($, voiceAtom, s => ({
    ...s,
    questions: s.questions.map(q => (q.id === id ? { ...q, answer: a, isSkipped: false } : q)),
  }))
}

export async function voiceTick($: EngineInterface): Promise<void> {
  const s = await read($, voiceAtom)
  if (s.phase !== 'review' || s.isPaused) return
  const { next, send } = tickVoice(s)
  await update($, voiceAtom, () => next)
  if (send) await sendCleaned($)
}

async function runCleaner($: EngineInterface, original: string): Promise<void> {
  const settings = await getSettings($)
  const r = await $.model.complete({
    model: 'haiku',
    system: CLEAN_SYSTEM,
    prompt: cleanPrompt(original),
    maxTokens: 1200,
    timeoutMs: 25_000,
  })
  const parsed = r.isAnswered ? parseCleanReply(r.text) : null
  if (parsed === null) {
    void log($, 'voice', `cleaner gave no usable reply (${r.isAnswered ? 'unparsable' : r.reason}); sent original`)
    await update($, voiceAtom, () => IDLE_VOICE)
    $.ui.toast('Toolkit: could not tidy that message, so it was sent as spoken.')
    await submitText($, original)
    return
  }
  void log($, 'voice', `cleaned ${words(original).length} words into ${parsed.items.length} items, ${parsed.questions.length} questions`)
  await update($, voiceAtom, s =>
    s.phase !== 'cleaning'
      ? s
      : {
          ...s,
          phase: 'review' as const,
          items: parsed.items,
          questions: toQuestions(parsed, settings.voiceQuestionSec),
          secondsLeft: settings.voiceCountdownSec,
          isPaused: false,
        },
  )
}

// ---- Hooks ----
/** True when the message should be held for cleaning; starts the Haiku call in the background. */
export async function voiceHold(
  $: EngineInterface,
  e: { text: string; command?: unknown; isMeta?: true; origin: { kind: string } },
): Promise<boolean> {
  if (e.command !== undefined || e.isMeta === true) return false
  const kind = e.origin.kind
  if (kind !== 'composer' && kind !== 'bridge') return false
  if (!(await isOn($, 'voice'))) return false
  const s = await getSettings($)
  if (!looksDictated(e.text, s.voiceWordThreshold)) return false
  if ((await read($, voiceAtom)).phase !== 'idle') return false
  await update($, voiceAtom, () => ({ ...IDLE_VOICE, phase: 'cleaning', original: e.text }))
  $.clock.after(0, () => void guard($, 'voice', () => runCleaner($, e.text)))
  return true
}

export const VOICE_DROP = 'Toolkit is tidying your dictated message. It will be sent in a few seconds.'

export const registerVoice = (on: On): void => {
  // Any keypress in the prompt box stops the countdown.
  on('prompt.change', async ($, e, next) => {
    await guard($, 'voice', async () => {
      const s = await read($, voiceAtom)
      if (s.phase === 'review' && !s.isPaused) await update($, voiceAtom, v => ({ ...v, isPaused: true }))
    })
    return next(e)
  })
}

// ---- Drawing (band above the prompt) ----
const ring = (left: number, total: number): string => {
  const r = 9
  const circ = 2 * Math.PI * r
  const f = total > 0 ? Math.max(0, Math.min(1, left / total)) : 0
  return (
    `<svg xmlns="${SVG_NS}" width="24" height="24" viewBox="0 0 24 24">` +
    `<circle cx="12" cy="12" r="${r}" fill="none" stroke="${C.borderSoft}" stroke-width="3"/>` +
    `<circle cx="12" cy="12" r="${r}" fill="none" stroke="${C.purple}" stroke-width="3" stroke-linecap="round" ` +
    `stroke-dasharray="${(f * circ).toFixed(2)} ${circ.toFixed(2)}" transform="rotate(-90 12 12)"/></svg>`
  )
}

export async function renderVoiceBand(
  $: EngineInterface,
  E: Els,
  surface: string,
): Promise<RenderElement | null> {
  const s = await read($, voiceAtom)
  if (s.phase === 'idle') return null
  const { Box, Text, Button } = E
  if (s.phase === 'cleaning') {
    return (
      <Box flexDirection="row" gap={1}>
        <Text color={C.purpleSoft}>◌</Text>
        <Text color={C.muted}>Tidying your dictated message with Haiku…</Text>
        <Button key="voice-original" label="Send original" onPress={() => void sendOriginal($)} />
      </Box>
    )
  }
  const settings = await getSettings($)
  const open = s.questions.find(q => q.answer === null && !q.isSkipped)
  const status = s.isPaused
    ? 'Paused'
    : open
      ? `Question: ${open.secondsLeft}s`
      : `Sending in ${s.secondsLeft}s`
  const Svg = svgOf(E)
  const Input = inputOf(E)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={C.purpleDeep} paddingX={1}>
      <Box flexDirection="row" gap={1}>
        {Svg && surface !== 'terminal' && !s.isPaused && !open ? (
          <Svg source={ring(s.secondsLeft, settings.voiceCountdownSec)} alt={`${s.secondsLeft} seconds left`} width={24} height={24} />
        ) : (
          <Text color={C.purpleSoft}>{s.isPaused ? '⏸' : '◔'}</Text>
        )}
        <Text bold color={C.text}>Cleaned prompt</Text>
        <Text color={C.muted}>{status}</Text>
      </Box>
      {s.items.map((item, i) => (
        <Text color={C.text} wrap="wrap">
          {i + 1}. {item}
          {s.unclear.includes(i + 1) || s.questions.some(q => q.isSkipped && q.point === i + 1) ? ' (unclear)' : ''}
        </Text>
      ))}
      {open ? (
        <Box flexDirection="column">
          <Text color={C.purpleSoft}>? {open.text}</Text>
          <Box flexDirection="row" gap={1}>
            {open.options.map((opt, i) => (
              <Button key={`voice-${open.id}-${i}`} label={opt} onPress={() => void answerQuestion($, open.id, opt)} />
            ))}
          </Box>
          {Input ? (
            <Input
              key={`voice-own-${open.id}`}
              placeholder="Or type your own answer, then Enter"
              onSubmit={v => void answerQuestion($, open.id, v)}
            />
          ) : null}
        </Box>
      ) : null}
      <Box flexDirection="row" gap={1}>
        <Button key="voice-send" variant="primary" label="Send now" onPress={() => void sendCleaned($)} />
        <Button key="voice-edit" label="Edit" onPress={() => void editCleaned($)} />
        <Button key="voice-original" label="Send original" onPress={() => void sendOriginal($)} />
      </Box>
    </Box>
  )
}
