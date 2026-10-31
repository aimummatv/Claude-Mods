// End-to-end: the real hooks, driven through the engine's events, against the test kit.
import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { answerSpawns, BAND, CWD, HOME, kit, PANE, runStep, spawnArgs, stepArgs, T0, turnDone, turnStart } from './testkit'

const SETTINGS = `${HOME}\\.claude\\toolkit\\settings.json`
const MAP = `${CWD}\\PROJECT_MAP.md`
const cmd = (args: string) => ({ command: 'toolkit', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } })
const say = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

async function start($: Engine, on: On) {
  const k = kit(on)
  answerSpawns(on)
  on('prompt.submit', (_$, e) => ({ text: e.text, ...(e.context ? { context: e.context } : {}) }))
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  return k
}

describe('/toolkit and settings', () => {
  test('on/off and set persist to %USERPROFILE%\\.claude\\toolkit\\settings.json and load next session', async ($, on) => {
    const k = await start($, on)
    const r = await $.command.run(cmd('off voice'))
    expect(r.text).toContain('off')
    await $.command.run(cmd('set voiceWordThreshold 60'))
    const saved = JSON.parse(k.files.get(SETTINGS)!)
    expect(saved.features.voice).toBe(false)
    expect(saved.voiceWordThreshold).toBe(60)
    const status = await $.command.run(cmd('status'))
    expect(status.text).toContain('off  Voice Prompt Cleaner')
    // A new session reads the file.
    await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
    expect((await $.command.run(cmd('status'))).text).toContain('off  Voice Prompt Cleaner')
  })
  test('the settings view toggles a feature by press', async ($, on) => {
    const k = await start($, on)
    await $.command.run(cmd('settings'))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'feat-skills' })
    expect(JSON.parse(k.files.get(SETTINGS)!).features.skills).toBe(false)
    await ui.unmount()
  })
})

describe('4. Project map: accept / reject / tweak through one Haiku call', () => {
  const editTurn = async ($: Engine) => {
    await $.turn.start(turnStart(undefined))
    await $.tool.call({ tool: 'Edit', file_path: `${CWD}\\src\\Menu.tsx`, old_string: 'a', new_string: 'b' })
    await $.turn.complete(turnDone(undefined, { answer: 'Removed the Settings button: the menu has 4 buttons now.' }))
  }
  const newMap = '# Project Map: shop\\n## App state by part\\n- Menu: 4 buttons (was 5)\\n## Next steps\\n- Footer\\n## Key data\\n- token ' + ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz0123'].join('-')

  test('approve: the change is written, CLAUDE.md imports the map, a toast names the part, secrets are masked', async ($, on) => {
    const k = await start($, on)
    await editTurn($)
    k.modelReplies.push(`{"decisions":[{"id":"x","action":"write"}],"map":"${newMap}"}`)
    await $.prompt.submit(say('great, now add a footer'))
    await k.clock.advance(10)
    const map = k.files.get(MAP)!
    expect(map).toContain('Menu: 4 buttons (was 5)')
    expect(map).not.toContain('sk-ant-api03')
    expect(k.files.get(`${CWD}\\CLAUDE.md`)).toContain('@PROJECT_MAP.md')
    expect(k.toasts.some(t => t.startsWith('Map updated: Menu'))).toBe(true)
  })
  test('reject: nothing pending is kept and the map is not touched when Haiku cannot answer', async ($, on) => {
    const k = await start($, on)
    await editTurn($)
    await $.prompt.submit(say("no, I don't like it, put it back"))
    await k.clock.advance(10)
    expect(k.files.has(MAP)).toBe(false)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Pending changes: 0/ })).toBeDefined()
    await ui.unmount()
  })
  test('tweak: kept pending with the new version; chit-chat turns add nothing', async ($, on) => {
    const k = await start($, on)
    await editTurn($)
    k.modelReplies.push(`{"decisions":[{"id":"c1","action":"keep","summary":"Menu 4 buttons, darker"}],"map":"# Project Map\\n## Next steps\\n- x"}`)
    // the pending id is c1-<n>; Haiku names unknown ids -> the local read (tweak) keeps it
    await $.prompt.submit(say('make it a bit darker'))
    await k.clock.advance(10)
    await $.turn.start(turnStart(undefined))
    await $.turn.complete(turnDone(undefined, { answer: 'Sure, here is how caching works.' }))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Pending changes: 1/ })).toBeDefined()
    await ui.unmount()
  })
  test('chat meter line shows from 200k with messages left; New chat saves and starts over', async ($, on) => {
    const k = await start($, on)
    k.usage = { ...k.usage, context: { tokens: 150_000, window: 250_000 } }
    await $.prompt.submit(say('one'))
    k.usage = { ...k.usage, context: { tokens: 210_000, window: 250_000 } }
    await $.prompt.submit(say('two'))
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /Chat 210k \/ 250k/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /~0 messages left/ })).toBeDefined()
    await band.unmount()
    k.modelReplies.push('{"decisions":[],"map":"# Project Map\\n## Next steps\\n- go"}')
    const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await pane.press({ key: 'map-new' })
    expect(k.commands).toContain('clear')
    expect(k.files.get(MAP)).toContain('Next steps')
    await pane.press({ key: 'map-folder' })
    expect(k.runs.some(r => r[0] === 'explorer' && r[1] === `/select,${MAP}`)).toBe(true)
    await pane.unmount()
  })
})

describe('3. Keep Warm', () => {
  test('hidden until 2 minutes before cold; notifies once; Keep warm pings by fork and restarts the timer', async ($, on) => {
    const k = await start($, on)
    const transcript = `${HOME}\\.claude\\projects\\C--Users-aman-shop\\sess1.jsonl`
    k.files.set(
      transcript,
      JSON.stringify({ type: 'assistant', timestamp: new Date(T0).toISOString(), message: { usage: { cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 50 } } } }),
    )
    await $.turn.start(turnStart(undefined))
    await runStep($, stepArgs())
    await $.turn.complete(turnDone(undefined))
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ key: 'warm-keep' })).toBe(undefined)
    await k.clock.advance(185_000)
    await band.redraw()
    expect(await band.find({ type: 'Text', text: /Cache goes cold in 1:5\d/ })).toBeDefined()
    expect(k.runs.filter(r => r[0] === 'powershell').length).toBe(1) // Windows toast
    await band.press({ key: 'warm-keep' })
    expect(k.toasts.some(t => t.includes('Cache kept warm'))).toBe(true)
    await band.redraw()
    expect(await band.find({ key: 'warm-keep' })).toBe(undefined)
    // No automatic pinging: another 3 minutes pass and nothing is sent by itself.
    await k.clock.advance(185_000)
    expect(k.toasts.filter(t => t.includes('Cache kept warm')).length).toBe(1)
    await band.unmount()
  })
})

describe('7. Auto Model applies its choice to the main thread', () => {
  test('a small fix at chat start runs on Haiku; the chip says so; a rejection escalates', async ($, on) => {
    const k = await start($, on)
    await $.prompt.submit(say('fix the typo in the header'))
    await runStep($, stepArgs(undefined, 'claude-opus-5-5'))
    expect(k.steps.at(-1)!.model).toBe('haiku')
    expect(k.statuses.some(s => s?.startsWith('Auto: Haiku'))).toBe(true)
    await $.turn.complete({ ...turnDone(undefined), usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' } })
    await $.prompt.submit(say("no, that's wrong, undo it"))
    await runStep($, stepArgs(undefined, 'claude-haiku-5-5'))
    expect(k.steps.at(-1)!.model).toBe('sonnet')
  })
  test('a manual override pins the model', async ($, on) => {
    const k = await start($, on)
    await $.command.run(cmd('model opus'))
    await $.prompt.submit(say('fix the typo'))
    await runStep($, stepArgs())
    expect(k.steps.at(-1)!.model).toBe('opus')
  })
  test('subagents are routed: Research -> Haiku, Design -> Opus; an explicit model is kept', async ($, on) => {
    const k = await start($, on)
    await $.agent.spawn(spawnArgs('research the shopify docs', 'Explore'))
    await $.agent.spawn(spawnArgs('design the landing page'))
    await $.agent.spawn(spawnArgs('design it', 'general-purpose', 'sonnet'))
    expect(k.spawnModels).toEqual(['haiku', 'opus', 'sonnet'])
    expect(k.notes.length).toBe(0)
  })
})

describe('2. Stop and token limit', () => {
  test('Stop asks TaskStop and ends the agent at its next model step', async ($, on) => {
    const k = await start($, on)
    const r = await $.agent.spawn(spawnArgs('code the api'))
    const id = 'agentId' in r ? r.agentId! : ''
    await $.turn.start(turnStart(id))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: `stop-${id}` })
    expect(k.tools.some(t => t.tool === 'TaskStop' && t.input.task_id === id)).toBe(true)
    const before = k.steps.length
    const res = (await runStep($, stepArgs(id))) as { stopReason: string; usage: unknown }
    expect(k.steps.length).toBe(before) // the model was not called
    expect(res.stopReason).toBe('end_turn')
    await ui.unmount()
  })
  test('passing the per-agent token limit auto-stops with a note on the card', async ($, on) => {
    const k = await start($, on)
    await $.command.run(cmd('set agentTokenLimit 5000'))
    const r = await $.agent.spawn(spawnArgs('code the api'))
    const id = 'agentId' in r ? r.agentId! : ''
    await $.turn.start(turnStart(id))
    await runStep($, stepArgs(id)) // 3,500 tokens
    await runStep($, stepArgs(id, 'claude-sonnet-5-5', 1)) // 7,000 > 5,000
    expect(k.tools.some(t => t.tool === 'TaskStop')).toBe(true)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /Auto-stopped: passed the 5\.0k token limit/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /7\.0k tok/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('5. Plan usage', () => {
  test('LIVE data: bars, badge, and the 80% notification', async ($, on) => {
    const k = await start($, on)
    k.usage = { ...k.usage, rateLimits: [{ kind: 'five_hour', percentUsed: 82, resetsAt: new Date(T0 + 3_600_000).toISOString() }, { kind: 'seven_day', percentUsed: 40 }] }
    await $.turn.start(turnStart(undefined))
    await $.turn.complete(turnDone(undefined))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'jump-usage' })
    expect(await ui.find({ type: 'Text', text: /^LIVE$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^82%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Resets in 1:00:00/ })).toBeDefined()
    expect(k.runs.some(r => r[0] === 'powershell')).toBe(true)
    await ui.unmount()
  })
  test('over the limit: a red "Back in" card', async ($, on) => {
    const k = await start($, on)
    k.usage = { ...k.usage, rateLimits: [{ kind: 'five_hour', percentUsed: 100, resetsAt: new Date(T0 + 754_000).toISOString() }] }
    await $.turn.start(turnStart(undefined))
    await $.turn.complete(turnDone(undefined))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'jump-usage' })
    expect(await ui.find({ type: 'Text', text: /Back in 12:34/ })).toBeDefined()
    await ui.unmount()
  })
  test('Estimate mode from local transcripts, labelled, with the claude.ai note', async ($, on) => {
    const k = await start($, on)
    k.files.set(
      `${HOME}\\.claude\\projects\\C--x\\a.jsonl`,
      JSON.stringify({ type: 'assistant', timestamp: new Date(T0 - 60_000).toISOString(), requestId: 'r', message: { id: 'm', usage: { input_tokens: 1200, output_tokens: 300 } } }),
    )
    await $.turn.start(turnStart(undefined))
    await $.turn.complete(turnDone(undefined))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.press({ key: 'jump-usage' })
    expect(await ui.find({ type: 'Text', text: /^Estimate$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\.5k tok · cap unknown/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /isn't counted/ })).toBeDefined()
    await ui.unmount()
  })
})

describe('6. Skill helper', () => {
  test('finds SKILL.md files, hints once per task, and "Use it" fills the prompt box', async ($, on) => {
    const k = kit(on)
    answerSpawns(on)
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    k.files.set(`${HOME}\\.claude\\skills\\ui-ux-pro\\SKILL.md`, '---\nname: ui-ux-pro\ndescription: Design beautiful UI and UX for landing pages\n---\nUse for page design.\n')
    await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
    await k.clock.advance(1600)
    await $.prompt.submit(say('redesign the landing page ui so it looks beautiful'))
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /UI UX Pro can help with this/ })).toBeDefined()
    await band.press({ key: 'skill-hint-use' })
    expect(k.fills.at(-1)).toBe('/ui-ux-pro ')
    await band.redraw()
    expect(await band.find({ type: 'Text', text: /can help with this/ })).toBe(undefined)
    await band.unmount()
  })
})

describe('extras', () => {
  test('a turn over 1 minute sends a "done" notification; a short one does not', async ($, on) => {
    const k = await start($, on)
    await $.turn.complete(turnDone(undefined, { durationMs: 20_000 }))
    const before = k.runs.length
    await $.turn.complete(turnDone(undefined, { durationMs: 95_000 }))
    expect(k.runs.length).toBe(before + 1)
    expect(k.runs.at(-1)![0]).toBe('powershell')
  })
  test('a huge file read asks first; "Only the needed part" refuses with guidance', async ($, on) => {
    const k = await start($, on)
    k.files.set(`${CWD}\\data.json`, 'x'.repeat(120_000))
    k.askAnswer = 'Only the needed part'
    const r = await $.tool.call({ tool: 'Read', file_path: `${CWD}\\data.json` })
    expect(r.deny ?? (r as { text?: string }).text ?? '').toContain('only the needed part')
    k.askAnswer = 'Read all'
    const r2 = await $.tool.call({ tool: 'Read', file_path: `${CWD}\\data.json` })
    expect(r2.deny).toBe(undefined)
  })
})

describe('above-prompt band', () => {
  test('shows at most two rows, in priority order', async ($, on) => {
    const k = await start($, on)
    // Task bar + skill-less: a to-do list, plus the meter line from 200k.
    k.usage = { ...k.usage, context: { tokens: 210_000, window: 250_000 } }
    await $.prompt.submit(say('build the invoice page'))
    await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'a', status: 'completed', activeForm: 'A' }, { content: 'b', status: 'in_progress', activeForm: 'Doing b' }] })
    const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect(await band.find({ type: 'Text', text: /Chat 210k/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Tasks 1\/2 · 50%/ })).toBeDefined()
    await band.press({ key: 'tasks-hide' })
    expect(await band.find({ type: 'Text', text: /Tasks 1\/2/ })).toBe(undefined)
    await band.unmount()
  })
  test('the to-do reminder is added once, after 3 tool calls without a list', async ($, on) => {
    await start($, on)
    await $.prompt.submit(say('refactor the api'))
    const ctx: (readonly string[] | undefined)[] = []
    for (let i = 0; i < 5; i++) {
      const r = await $.tool.call({ tool: 'Bash', command: 'ls' })
      ctx.push(r.context)
    }
    expect(ctx.filter(c => c && c.some(x => x.includes('to-do list'))).length).toBe(1)
    expect(ctx[2]?.[0]).toContain('to-do list')
  })
})
