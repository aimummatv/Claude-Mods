import { describe, expect, test } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'

import type { PendingChange, WarmState } from '../types'
import {
  decideSwitch,
  emptyRecord,
  errorSignature,
  learnedTier,
  readSignals,
  recordOutcome,
  stepUp,
  switchCosts,
  tierForAgent,
  tierOfModel,
  weekStats,
} from './features/automodel'
import { countLines, estimateTokens, isBigRead, partOnlyDenial } from './features/extras'
import { detectTtl, EMPTY_WARM, isWarnWindow, msToCold, pingVsCold } from './features/keepwarm'
import {
  applyLocalDecision,
  avgPerMessage,
  changedParts,
  changedSections,
  classifyReply,
  emptyMap,
  gatherFiles,
  gatherLinks,
  gatherSkills,
  mapUpdatePrompt,
  messagesLeft,
  meterColor,
  parseMapReply,
  parseSections,
  remainingPending,
  withMapImport,
} from './features/projectmap'
import { filterSkills, howToOf, isStrong, matchSkills, parseFrontmatter, prettyName, tokenize } from './features/skills'
import { crossed, currentBlock, dedupe, FIVE_H, learnCap, parseUsageLines, pctOf, usageColor, weekTokens } from './features/usage'
import { C } from './features/ui'
import { clampOffset, featureByName, lowerRows, monitorRows, pickBand } from './features/view'
import { T0 } from './testkit'

// ---------------------------------------------------------------------------
describe('3. Keep Warm: ttl.py in TypeScript', () => {
  const line = (o: object) => JSON.stringify(o)
  test('1-hour cache writes mean a 1-hour TTL', () => {
    const jsonl = [
      line({ type: 'user', message: { role: 'user' } }),
      line({ type: 'assistant', timestamp: '2026-10-31T12:00:00Z', message: { usage: { input_tokens: 5, cache_read_input_tokens: 40000, cache_creation_input_tokens: 2000, cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 } } } }),
    ].join('\n')
    const r = detectTtl(jsonl)
    expect(r.ttlSec).toBe(3600)
    expect(r.lastAt).toBe(Date.parse('2026-10-31T12:00:00Z'))
    expect(r.cachedTokens).toBe(42005)
  })
  test('5-minute writes mean 5 minutes; read-only lines look further back; sidechains are skipped', () => {
    const jsonl = [
      line({ type: 'assistant', timestamp: '2026-10-31T11:00:00Z', message: { usage: { cache_creation_input_tokens: 900, cache_creation: { ephemeral_5m_input_tokens: 900 } } } }),
      line({ type: 'assistant', isSidechain: true, timestamp: '2026-10-31T11:30:00Z', message: { usage: { cache_creation: { ephemeral_1h_input_tokens: 5 } } } }),
      line({ type: 'assistant', timestamp: '2026-10-31T11:05:00Z', message: { usage: { cache_read_input_tokens: 30000 } } }),
      'not json {"usage"',
    ].join('\n')
    const r = detectTtl(jsonl)
    expect(r.ttlSec).toBe(300)
    expect(r.lastAt).toBe(Date.parse('2026-10-31T11:05:00Z'))
  })
  test('unknown when there is no usage', () => {
    expect(detectTtl('').ttlSec).toBe(null)
  })
  test('the bar shows only in the last 2 minutes, and not after "Let it go"', () => {
    const w: WarmState = { ...EMPTY_WARM, ttlSec: 300, lastAt: T0, cachedTokens: 100_000 }
    expect(isWarnWindow(w, T0 + 100_000, 120)).toBe(false)
    expect(isWarnWindow(w, T0 + 190_000, 120)).toBe(true)
    expect(msToCold(w, T0 + 192_000)).toBe(108_000)
    expect(isWarnWindow(w, T0 + 301_000, 120)).toBe(false)
    expect(isWarnWindow({ ...w, dismissedFor: T0 }, T0 + 190_000, 120)).toBe(false)
  })
  test('a ping costs a tenth of the cached read; a cold re-read costs a cache write', () => {
    const c5 = pingVsCold(100_000, 300)
    expect(c5.ping).toBe(10_020)
    expect(c5.cold).toBe(125_000)
    expect(pingVsCold(100_000, 3600).cold).toBe(200_000)
  })
})

// ---------------------------------------------------------------------------
describe('4. Project Map: accepted changes only', () => {
  const pending: PendingChange[] = [
    { id: 'c1', summary: 'Menu now has 4 buttons', files: ['src/Menu.tsx'], at: T0 },
    { id: 'c2', summary: 'Invoice total in bold', files: ['src/Invoice.tsx'], at: T0 },
  ]
  test('the reply is read locally: reject, tweak, approve, move on', () => {
    expect(classifyReply('no, undo that')).toBe('reject')
    expect(classifyReply("I don't like it, put it back")).toBe('reject')
    expect(classifyReply('nope')).toBe('reject')
    expect(classifyReply('make it a bit darker')).toBe('tweak')
    expect(classifyReply('perfect, thanks')).toBe('approve')
    expect(classifyReply('now add a footer with the address')).toBe('moveon')
  })
  test('approve/move on writes, reject discards, tweak keeps pending', () => {
    expect(applyLocalDecision(pending, 'approve').write.length).toBe(2)
    expect(applyLocalDecision(pending, 'moveon').keep.length).toBe(0)
    expect(applyLocalDecision(pending, 'reject')).toEqual({ write: [], keep: [] })
    expect(applyLocalDecision(pending, 'tweak').keep.length).toBe(2)
  })
  test("Haiku's decisions: write and discard leave pending, keep stays with the new version", () => {
    const left = remainingPending(
      pending,
      [
        { id: 'c1', action: 'write' },
        { id: 'c2', action: 'keep', summary: 'Invoice total in bold, larger font' },
      ],
      'tweak',
    )
    expect(left).toEqual([{ ...pending[1]!, summary: 'Invoice total in bold, larger font' }])
    expect(remainingPending(pending, [{ id: 'c1', action: 'discard' }], 'reject')).toEqual([])
    expect(remainingPending(pending, [], 'approve')).toEqual([])
  })
  test('the update prompt holds only the map, the last turn and the reply', () => {
    const p = mapUpdatePrompt({
      map: emptyMap('shop'),
      request: 'make the menu 4 buttons',
      answer: 'Done: removed Settings',
      files: ['src/Menu.tsx'],
      reply: 'great, next the footer',
      pending,
      facts: { files: ['src/Menu.tsx'], links: [], skills: [], connectors: [] },
      wordCap: 1500,
      finalSave: false,
    })
    expect(p).toContain('<current_map>')
    expect(p).toContain('<last_turn>')
    expect(p).toContain('<reply>')
    expect(p).toContain('[c1] Menu now has 4 buttons')
    expect(p).not.toContain('tighten')
    const big = mapUpdatePrompt({ ...{ map: 'word '.repeat(1400), request: '', answer: '', files: [], reply: null, pending: [], facts: { files: [], links: [], skills: [], connectors: [] } }, wordCap: 1500, finalSave: true })
    expect(big).toContain('tighten')
    expect(big).toContain('(not yet confirmed)')
  })
  test('map sections parse; changed parts are named for the toast', () => {
    const before = emptyMap('shop')
    const after = before.replace('## App state by part\n- —', '## App state by part\n- Menu: 4 buttons (was 5)\n- Invoice form: total in bold')
    expect(parseSections(before).size).toBe(7)
    expect(changedSections(before, after)).toEqual(['App state by part'])
    expect(changedParts(before, after)).toEqual(['Menu', 'Invoice form'])
  })
  test('Haiku map replies are validated', () => {
    const r = parseMapReply('{"decisions":[{"id":"c1","action":"write"},{"id":"x","action":"bogus"}],"map":"# Project Map\\n## Next steps\\n- footer"}')!
    expect(r.decisions).toEqual([{ id: 'c1', action: 'write' }])
    expect(parseMapReply('{"map": "no headings"}')).toBe(null)
    expect(parseMapReply('nothing')).toBe(null)
  })
  test('CLAUDE.md gets @PROJECT_MAP.md once, without touching the rest', () => {
    expect(withMapImport(null)).toBe('@PROJECT_MAP.md\n')
    expect(withMapImport('# Rules\nUse tabs.\n')).toBe('# Rules\nUse tabs.\n\n@PROJECT_MAP.md\n')
    expect(withMapImport('# Rules\n@PROJECT_MAP.md\n')).toBe(null)
  })
  test('files, links, skills and connectors are gathered for free', () => {
    const msgs: SessionMessage[] = [
      { role: 'assistant', text: 'See claude://code/new?q=hi. and file://C:/x', toolUses: [
        { id: '1', tool: 'Read', input: { file_path: 'C:\\shop\\src\\Menu.tsx' } },
        { id: '2', tool: 'Edit', input: { file_path: 'C:\\shop\\src\\Menu.tsx' } },
        { id: '3', tool: 'Write', input: { file_path: 'C:\\shop\\src\\Invoice.tsx' } },
        { id: '4', tool: 'Skill', input: { skill: 'frontend-design' } },
        { id: '5', tool: 'mcp__Shopify__get-product', input: {} },
      ] },
    ] as unknown as SessionMessage[]
    expect(gatherFiles(msgs, 'C:\\shop')).toEqual(['src\\Menu.tsx', 'src\\Invoice.tsx'])
    expect(gatherLinks(msgs.map(m => m.text))).toEqual(['claude://code/new?q=hi', 'file://C:/x'])
    expect(gatherSkills(msgs)).toEqual({ skills: ['frontend-design'], connectors: ['Shopify'] })
  })
  test('chat meter maths', () => {
    expect(meterColor(100_000)).toBe(C.green)
    expect(meterColor(200_000)).toBe(C.amber)
    expect(meterColor(230_000)).toBe(C.red)
    expect(avgPerMessage([10_000, 20_000, 40_000])).toBe(15_000)
    expect(avgPerMessage([10_000])).toBe(null)
    expect(messagesLeft(220_000, 250_000, 15_000)).toBe(2)
    expect(messagesLeft(null, 250_000, 15_000)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
describe('5. Plan usage estimate maths', () => {
  const H = 3600_000
  const row = (at: number, tokens: number, id: string) =>
    JSON.stringify({ type: 'assistant', timestamp: new Date(at).toISOString(), requestId: id, message: { id, usage: { input_tokens: tokens, output_tokens: 0 } } })
  test('lines parse, cache reads are not counted, one row per message', () => {
    const jsonl = [row(T0, 100, 'm1'), row(T0, 100, 'm1'), JSON.stringify({ type: 'assistant', timestamp: new Date(T0).toISOString(), message: { id: 'm2', usage: { cache_read_input_tokens: 9999, output_tokens: 5 } } })].join('\n')
    const ev = dedupe(parseUsageLines(jsonl))
    expect(ev.length).toBe(2)
    expect(ev.reduce((a, e) => a + e.tokens, 0)).toBe(105)
  })
  test('the 5-hour block starts at the first message (to the hour) and ends 5 h later', () => {
    const ev = [
      { at: T0 - 10 * H, tokens: 50 },
      { at: T0 - 2 * H + 15 * 60_000, tokens: 100 },
      { at: T0 - H, tokens: 200 },
    ]
    const b = currentBlock(ev, T0)!
    expect(b.start).toBe(T0 - 2 * H)
    expect(b.end).toBe(T0 - 2 * H + FIVE_H)
    expect(b.tokens).toBe(300)
    expect(currentBlock(ev, T0 + 4 * H)).toBe(null)
    expect(weekTokens(ev, T0)).toBe(350)
  })
  test('percent needs a learned cap; a cap is learned from a live reading', () => {
    expect(pctOf(500, null)).toBe(null)
    expect(pctOf(500, 1000)).toBe(50)
    expect(learnCap(400_000, 40)).toBe(1_000_000)
    expect(learnCap(10, 2)).toBe(null)
  })
  test('notifications fire when 80% and 95% are crossed, once', () => {
    expect(crossed(70, 82)).toEqual([80])
    expect(crossed(82, 96)).toEqual([95])
    expect(crossed(70, 96)).toEqual([80, 95])
    expect(crossed(85, 86)).toEqual([])
    expect(crossed(null, null)).toEqual([])
  })
  test('colours: green, amber from 70%, red from 90%', () => {
    expect(usageColor(50)).toBe(C.green)
    expect(usageColor(75)).toBe(C.amber)
    expect(usageColor(92)).toBe(C.red)
    expect(usageColor(null)).toBe(C.grey)
  })
})

// ---------------------------------------------------------------------------
describe('6. Skill matching', () => {
  const skills = [
    { name: 'ui-ux-pro', command: '/ui-ux-pro', description: 'Design beautiful UI and UX for web pages, landing pages and components', howTo: '', source: 'user', path: null },
    { name: 'pdf', command: '/pdf', description: 'Read, merge and split PDF files', howTo: '', source: 'plugin', path: null },
    { name: 'shopify-theme', command: '/shopify-theme', description: 'Edit Shopify theme liquid sections and store pages', howTo: '', source: 'plugin', path: null },
  ]
  test('frontmatter, block scalars and how-to lines', () => {
    const md = '---\nname: ui-ux-pro\ndescription: >\n  Design beautiful UI\n  for the web\n---\n# UI UX Pro\n\nUse it when styling pages.\nRun /ui-ux-pro first.\n'
    const fm = parseFrontmatter(md)
    expect(fm.name).toBe('ui-ux-pro')
    expect(fm.description).toBe('Design beautiful UI for the web')
    expect(howToOf(fm.body)).toBe('Use it when styling pages. Run /ui-ux-pro first.')
    expect(parseFrontmatter('no frontmatter').name).toBe(null)
  })
  test('matches by the words of the message and the files being edited', () => {
    const m = matchSkills('redesign the landing page UI so it looks beautiful', [], skills)
    expect(m[0]!.name).toBe('ui-ux-pro')
    expect(isStrong(m[0])).toBe(true)
    expect(matchSkills('fix the theme section', ['sections/header.liquid'], skills)[0]!.name).toBe('shopify-theme')
    expect(matchSkills('what time is it', [], skills)).toEqual([])
  })
  test('search, names and tokens', () => {
    expect(filterSkills(skills, 'pdf').map(s => s.name)).toEqual(['pdf'])
    expect(prettyName('design:ui-ux-pro')).toBe('UI UX Pro')
    expect(tokenize('The pages, and UI!')).toEqual(['page', 'ui'])
    expect(tokenize('designing boxes stories styled')).toEqual(['design', 'box', 'story', 'styl'])
  })
})

// ---------------------------------------------------------------------------
describe('7. Auto Model decisions', () => {
  test('small fixes -> Haiku, normal -> Sonnet, planning/architecture -> Opus', () => {
    expect(readSignals({ text: 'fix the typo in the header', files: 1, hasImage: false, repeatedError: false }).tier).toBe('haiku')
    expect(readSignals({ text: 'add a discount field to the invoice form and save it with the invoice, then show it in the totals', files: 2, hasImage: false, repeatedError: false }).tier).toBe('sonnet')
    const big = readSignals({ text: 'plan the architecture for a full redesign of the store from scratch', files: 0, hasImage: false, repeatedError: false })
    expect(big.tier).toBe('opus')
    expect(big.kind).toBe('design')
    expect(readSignals({ text: 'it fails again', files: 1, hasImage: false, repeatedError: true }).reasons).toContain('same error twice')
  })
  test('cache-aware: free at chat start; mid-chat only when small, cold, or cheaper than the re-read', () => {
    const base = { current: 'opus' as const, target: 'haiku' as const, cacheCold: false, chatStart: false, budgetPct: null, escalated: false }
    expect(decideSwitch({ ...base, current: null, contextTokens: 0 }).action).toBe('switch')
    expect(decideSwitch({ ...base, chatStart: true, contextTokens: 150_000 }).action).toBe('switch')
    expect(decideSwitch({ ...base, contextTokens: 20_000 }).action).toBe('switch')
    expect(decideSwitch({ ...base, contextTokens: 150_000, cacheCold: true }).action).toBe('switch')
    // Warm 150k context on Opus: re-reading on Haiku costs more than staying, so route to a Haiku subagent.
    const c = switchCosts('opus', 'haiku', 150_000)
    expect(c.move).toBeGreaterThan(c.stay)
    const d = decideSwitch({ ...base, contextTokens: 150_000 })
    expect(d.action).toBe('route')
    expect(d.tier).toBe('opus')
    // Upgrading for quality with a warm cache keeps the model unless escalated.
    expect(decideSwitch({ ...base, current: 'sonnet', target: 'opus', contextTokens: 150_000 }).action).toBe('keep')
    expect(decideSwitch({ ...base, current: 'sonnet', target: 'opus', contextTokens: 150_000, escalated: true }).action).toBe('switch')
  })
  test('budget-aware: over 80% of the 5-hour window leans one step cheaper', () => {
    const d = decideSwitch({ current: null, target: 'opus', contextTokens: 0, cacheCold: false, chatStart: true, budgetPct: 85, escalated: false })
    expect(d.tier).toBe('sonnet')
    expect(d.reason).toContain('80%')
  })
  test('escalation goes up one level', () => {
    expect(stepUp('haiku')).toBe('sonnet')
    expect(stepUp('sonnet')).toBe('opus')
    expect(stepUp('opus')).toBe('opus')
  })
  test('learning: reliable cheaper tiers are preferred; failing tiers step up', () => {
    let r = emptyRecord(T0)
    for (let i = 0; i < 4; i++) r = recordOutcome(r, 'fix', 'haiku', true)
    expect(learnedTier(r, 'fix', 'sonnet')).toBe('haiku')
    r = recordOutcome(recordOutcome(r, 'feature', 'haiku', false), 'feature', 'haiku', false)
    expect(learnedTier(r, 'feature', 'haiku')).toBe('sonnet')
    expect(learnedTier(r, 'unknown', 'sonnet')).toBe('sonnet')
  })
  test('weekly stats', () => {
    const r = emptyRecord(T0)
    r.week.tasks = { haiku: 2, sonnet: 1, opus: 1 }
    r.week.tokens = { haiku: 10_000, sonnet: 10_000, opus: 5000 }
    const s = weekStats(r)
    expect(s.pct).toEqual({ haiku: 50, sonnet: 25, opus: 25 })
    expect(s.saved).toBe(12_000)
  })
  test('subagent routing: Research -> Haiku, Code -> Sonnet, Design -> Opus', () => {
    expect(tierForAgent('Explore', 'find the docs')).toBe('haiku')
    expect(tierForAgent('general-purpose', 'implement the API fix')).toBe('sonnet')
    expect(tierForAgent('general-purpose', 'design the landing page layout')).toBe('opus')
    expect(tierOfModel('claude-opus-5-5')).toBe('opus')
    expect(tierOfModel('something')).toBe(null)
  })
  test('the same error twice has the same signature', () => {
    expect(errorSignature('TypeError: x is undefined at line 12')).toBe(errorSignature('TypeError: x is undefined at line 99'))
  })
})

// ---------------------------------------------------------------------------
describe('extras and layout', () => {
  test('big-read rule', () => {
    const s = { bigReadTokens: 20_000, bigReadLines: 2000 }
    expect(estimateTokens(100_000)).toBe(25_000)
    expect(isBigRead(25_000, null, s)).toBe(true)
    expect(isBigRead(5000, 2500, s)).toBe(true)
    expect(isBigRead(5000, 100, s)).toBe(false)
    expect(countLines('a\nb\r\nc')).toBe(3)
    expect(partOnlyDenial('C:\\shop\\big.json')).toContain('big.json')
  })
  test('the monitor takes ~30% of the pane, bounded, and the lower area the rest', () => {
    expect(monitorRows(40)).toBe(12)
    expect(monitorRows(20)).toBe(11)
    expect(monitorRows(100)).toBe(18)
    expect(lowerRows(40)).toBe(26)
    expect(clampOffset(50, 10)).toBe(9)
  })
  test('the band shows at most two rows, by priority', () => {
    expect(pickBand(['voice', null, 'warm', 'meter', 'tasks'])).toEqual(['voice', 'warm'])
    expect(pickBand([null, null, null, 'tasks', 'hint'])).toEqual(['tasks', 'hint'])
  })
  test('feature names for /toolkit on|off', () => {
    expect(featureByName('Voice')).toBe('voice')
    expect(featureByName('helper desk')).toBe('helperDesk')
    expect(featureByName('auto')).toBe('autoModel')
    expect(featureByName('nope')).toBe(null)
  })
})
