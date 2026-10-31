import { describe, expect, test } from 'claude-code/testing'

import type { VoiceState } from '../types'
import { composeCleaned, IDLE_VOICE, looksDictated, parseCleanReply, speechSigns, tickVoice, toQuestions } from './features/voice'
import { BAND, kit } from './testkit'

const RAMBLE =
  'okay so um I want to like change the invoice app you know the the header so it shows the logo and um basically ' +
  'the total should be in bold and like I mean also the date format should be day month year and uh you know ' +
  'make the menu have four buttons instead of five because the settings one is kind of useless and stuff'

describe('voice detection', () => {
  test('a long rambling message is detected', () => {
    expect(speechSigns(RAMBLE).fillers).toBeGreaterThan(3)
    expect(looksDictated(RAMBLE, 40)).toBe(true)
  })
  test('short, slash commands, shaped lists and code are left alone', () => {
    expect(looksDictated('um fix the header you know', 40)).toBe(false)
    expect(looksDictated(`/review ${RAMBLE}`, 40)).toBe(false)
    const shaped = `${RAMBLE}\n1. header logo\n2. bold total\n3. date format`
    expect(looksDictated(shaped, 40)).toBe(false)
    expect(looksDictated(`${RAMBLE}\n\`\`\`\ncode\n\`\`\``, 40)).toBe(false)
  })
  test('clean typed prose is not mistaken for speech', () => {
    const typed =
      'Please update the invoice header to show the company logo on the left. Make the total bold. ' +
      'Change the date format to DD/MM/YYYY across the app. Reduce the menu to four buttons by removing Settings, ' +
      'and move the settings link into the profile dropdown. Keep the existing colours and spacing as they are now.'
    expect(looksDictated(typed, 40)).toBe(false)
  })
  test('threshold is respected', () => {
    expect(looksDictated(RAMBLE, 500)).toBe(false)
  })
})

describe('Haiku reply handling', () => {
  test('parses items and at most 2 questions with 2-3 options', () => {
    const reply = `Here: {"items":["1. Show the logo in the invoice header","Bold the total"],
      "questions":[{"q":"Which date format?","options":["DD/MM/YYYY","D MMM YYYY"],"item":2},
                   {"q":"bad","options":["only one"]},
                   {"q":"Remove which button?","options":["Settings","Help","Other"],"item":null},
                   {"q":"third","options":["a","b"]}]}`
    const r = parseCleanReply(reply)!
    expect(r.items).toEqual(['Show the logo in the invoice header', 'Bold the total'])
    expect(r.questions.length).toBe(2)
    expect(r.questions[0]!.item).toBe(2)
    expect(r.questions[1]!.options.length).toBe(3)
  })
  test('unusable replies give null', () => {
    expect(parseCleanReply('no json here')).toBe(null)
    expect(parseCleanReply('{"items": []}')).toBe(null)
  })
})

const review = (over: Partial<VoiceState> = {}): VoiceState => ({
  ...IDLE_VOICE,
  phase: 'review',
  original: RAMBLE,
  items: ['Show the logo', 'Bold the total', 'Four menu buttons'],
  secondsLeft: 10,
  ...over,
})

describe('countdown and questions', () => {
  test('an unanswered question is skipped after 15 s and its point marked unclear', () => {
    let s = review({ questions: toQuestions({ items: ['a', 'b', 'c'], questions: [{ q: 'Which?', options: ['x', 'y'], item: 2 }] }, 15) })
    for (let i = 0; i < 15; i++) s = tickVoice(s).next
    expect(s.questions[0]!.isSkipped).toBe(true)
    expect(s.secondsLeft).toBe(10) // send countdown starts after the questions
    expect(composeCleaned(s)).toContain('2. Bold the total (unclear)')
  })
  test('answers are folded into the text that is sent', () => {
    const s = review({ questions: [{ id: 'q0', text: 'Which date format?', options: ['A', 'B'], point: null, answer: 'DD/MM/YYYY', secondsLeft: 9, isSkipped: false }] })
    const text = composeCleaned(s)
    expect(text).toContain('1. Show the logo')
    expect(text).toContain('Which date format? → DD/MM/YYYY')
  })
  test('the countdown sends at zero, and a pause stops it', () => {
    let s = review({ secondsLeft: 2 })
    let r = tickVoice(s)
    expect(r.send).toBe(false)
    r = tickVoice(r.next)
    expect(r.send).toBe(true)
    s = review({ secondsLeft: 2, isPaused: true })
    expect(tickVoice(s).next.secondsLeft).toBe(2)
  })
})

describe('the voice flow end to end', () => {
  test('a rambling prompt is held, cleaned by Haiku, shown, and sent on "Send now"', async ($, on) => {
    const k = kit(on)
    k.modelReplies.push('{"items":["Show the logo in the invoice header","Bold the total"],"questions":[]}')
    const sent: string[] = []
    on('prompt.submit', (_$, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    const held = await $.prompt.submit({ text: RAMBLE, wait: false, origin: { kind: 'composer' } })
    expect('drop' in held && held.drop).toContain('tidying')
    await k.clock.advance(50)
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Cleaned prompt/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Bold the total/ }))).toBeDefined()
    await ui.press({ key: 'voice-send' })
    expect(sent.at(-1)).toBe('1. Show the logo in the invoice header\n2. Bold the total')
    await ui.unmount()
  })
  test('if Haiku fails, the original is sent and nothing is lost', async ($, on) => {
    const k = kit(on)
    const sent: string[] = []
    on('prompt.submit', (_$, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.prompt.submit({ text: RAMBLE, wait: false, origin: { kind: 'composer' } })
    await k.clock.advance(50)
    expect(sent).toEqual([RAMBLE])
  })
})
