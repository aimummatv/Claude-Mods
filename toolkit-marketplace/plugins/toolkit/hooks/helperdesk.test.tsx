import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import type { AgentRec, AgentsState } from '../types'
import {
  applyStuck,
  badgeKindOf,
  badgeOf,
  bandOf,
  clampPage,
  evaluateStuck,
  isPinned,
  newAgent,
  orderAgents,
  refreshOrder,
  summarize,
  taskBarFromTodos,
  taskPct,
  tokensPerSecond,
  touch,
} from './features/helperdesk'
import { DEFAULT_SETTINGS } from './features/settings'
import { monitorRows } from './features/view'
import { answerSpawns, CWD, kit, PANE, spawnArgs, T0, turnDone, turnStart } from './testkit'

const S = DEFAULT_SETTINGS
const MIN = 60_000

const agent = (id: string, over: Partial<AgentRec> = {}): AgentRec => ({ ...newAgent(id, `Agent ${id}`, 'claude-haiku-5-5', T0), status: 'running', ...over })

describe('type badges come from tool calls', () => {
  test('web search -> Research, design files -> Design, code -> Code, browser -> Browser', () => {
    expect(badgeKindOf('WebSearch', {})).toBe('research')
    expect(badgeKindOf('WebFetch', {})).toBe('research')
    expect(badgeKindOf('Edit', { file_path: 'C:\\shop\\theme.css' })).toBe('design')
    expect(badgeKindOf('Write', { file_path: 'src/Menu.tsx' })).toBe('design')
    expect(badgeKindOf('Edit', { file_path: 'src/api.ts' })).toBe('code')
    expect(badgeKindOf('Bash', { command: 'npm test' })).toBe('code')
    expect(badgeKindOf('mcp__Claude_Browser__navigate', {})).toBe('browser')
    expect(badgeKindOf('Read', { file_path: 'a.ts' })).toBe(null)
    expect(badgeOf({ research: 3, design: 1, code: 0, browser: 0 })).toBe('Research')
    expect(badgeOf({ research: 0, design: 0, code: 0, browser: 0 }, 'Explore')).toBe('Research')
  })
})

describe('stuck detection', () => {
  test('no tool call, step or output for 2 minutes is stuck', () => {
    const r = agent('a', { lastActivityAt: T0 })
    expect(evaluateStuck(r, T0 + 119_000, 2 * MIN).stuck).toBe(false)
    const v = evaluateStuck(r, T0 + 121_000, 2 * MIN)
    expect(v.stuck).toBe(true)
    expect(v.since).toBe(T0 + 2 * MIN)
  })
  test('a running command gets its own timeout first', () => {
    const r = agent('a', { lastActivityAt: T0, command: { startedAt: T0, timeoutMs: 10 * MIN, label: 'npm run build' } })
    expect(evaluateStuck(r, T0 + 9 * MIN, 2 * MIN).stuck).toBe(false)
    const v = evaluateStuck(r, T0 + 10 * MIN + 1, 2 * MIN)
    expect(v.stuck).toBe(true)
    expect(v.reason).toContain('timeout')
  })
  test('being slower than another agent is never stuck', () => {
    const slow = agent('slow', { lastActivityAt: T0 + 100_000, outputTokens: 10, genMs: 10_000 })
    const fast = agent('fast', { lastActivityAt: T0 + 100_000, outputTokens: 5000, genMs: 10_000 })
    expect(evaluateStuck(slow, T0 + 150_000, 2 * MIN).stuck).toBe(false)
    expect(evaluateStuck(fast, T0 + 150_000, 2 * MIN).stuck).toBe(false)
  })
  test('finished agents are never stuck', () => {
    expect(evaluateStuck(agent('a', { status: 'completed' }), T0 + 60 * MIN, 2 * MIN).stuck).toBe(false)
  })
})

describe('pinned, acknowledged and recovered', () => {
  test('stuck pins; acknowledging unpins but does not recover; activity recovers and clears the pin', () => {
    let r = applyStuck(agent('a'), T0 + 3 * MIN, 2 * MIN)
    expect(r.status).toBe('stuck')
    expect(isPinned(r)).toBe(true)
    expect(bandOf(r, S, T0)).toBe(0)
    r = { ...r, acknowledged: true }
    expect(isPinned(r)).toBe(false)
    expect(r.status).toBe('stuck') // acknowledged is not recovered
    expect(bandOf(r, S, T0)).toBe(1)
    r = touch(r, T0 + 4 * MIN, 'Bash ls')
    expect(r.status).toBe('running')
    expect(r.acknowledged).toBe(false)
    expect(r.stuckSince).toBe(null)
    expect(isPinned(r)).toBe(false)
  })
})

describe('priority and stable ordering', () => {
  test('priority: stuck > high consumption > active > waiting > finished', () => {
    expect(bandOf(agent('a', { status: 'stuck' }), S, T0)).toBe(0)
    expect(bandOf(agent('a', { tokens: 200_000 }), S, T0)).toBe(1)
    expect(bandOf(agent('a'), S, T0)).toBe(2)
    expect(bandOf(agent('a', { status: 'waiting' }), S, T0)).toBe(3)
    expect(bandOf(agent('a', { status: 'completed' }), S, T0)).toBe(4)
  })
  test('equal-priority agents keep their order; minor metric changes do not reorder', () => {
    const recs: Record<string, AgentRec> = {}
    for (const id of ['a', 'b', 'c', 'd']) recs[id] = { ...agent(id), band: 2 }
    let st: AgentsState = refreshOrder({ recs, order: ['c', 'a', 'd', 'b'], page: 0, allDoneNotified: false }, S, T0)
    expect(st.order).toEqual(['c', 'a', 'd', 'b'])
    st = refreshOrder({ ...st, recs: { ...st.recs, d: { ...st.recs.d!, tokens: 90_000, outputTokens: 999 } } }, S, T0)
    expect(st.order).toEqual(['c', 'a', 'd', 'b'])
  })
  test('crossing a threshold moves an agent up; a stuck one jumps to the top at once', () => {
    const recs: Record<string, AgentRec> = {}
    for (const id of ['a', 'b', 'c']) recs[id] = { ...agent(id), band: 2 }
    let st = refreshOrder({ recs, order: ['a', 'b', 'c'], page: 0, allDoneNotified: false }, S, T0)
    st = refreshOrder({ ...st, recs: { ...st.recs, c: { ...st.recs.c!, tokens: 160_000 } } }, S, T0)
    expect(st.order).toEqual(['c', 'a', 'b'])
    st = refreshOrder({ ...st, recs: { ...st.recs, b: { ...st.recs.b!, status: 'stuck', stuckSince: T0 } } }, S, T0)
    expect(st.order[0]).toBe('b')
  })
  test('several stuck agents group at the top: hung command first, then longest stuck', () => {
    const recs: Record<string, AgentRec> = {
      x: { ...agent('x'), status: 'stuck', stuckSince: T0 + 5000, band: 0 },
      y: { ...agent('y'), status: 'stuck', stuckSince: T0, band: 0 },
      z: { ...agent('z'), status: 'stuck', stuckSince: T0 + 9000, band: 0, command: { startedAt: T0, timeoutMs: 1000, label: 'x' } },
      w: { ...agent('w'), band: 2 },
    }
    expect(orderAgents(['w', 'x', 'y', 'z'], recs)).toEqual(['z', 'y', 'x', 'w'])
  })
  test('page index is clamped when the list shrinks', () => {
    expect(clampPage(2, 10)).toBe(2)
    expect(clampPage(2, 5)).toBe(1)
    expect(clampPage(5, 0)).toBe(0)
  })
})

describe('metrics are honest', () => {
  test('tokens per second needs real streaming time', () => {
    expect(tokensPerSecond({ outputTokens: 500, genMs: 10_000 })).toBe(50)
    expect(tokensPerSecond({ outputTokens: 500, genMs: 0 })).toBe(null)
    expect(tokensPerSecond({ outputTokens: 0, genMs: 5000 })).toBe(null)
  })
  test('summary uses only known numbers', () => {
    const st: AgentsState = {
      recs: { a: agent('a', { tokens: 1000, model: 'haiku' }), b: agent('b', { tokens: null }) },
      order: ['a', 'b'],
      page: 0,
      allDoneNotified: false,
    }
    const s = summarize(st)
    expect(s.totalTokens).toBe(1000)
    expect(s.top).toEqual({ model: 'haiku', tokens: 1000 })
    expect(s.fastest).toBe(null)
  })
})

describe('task bar', () => {
  test('progress and the current step come from the to-do list', () => {
    const t = taskBarFromTodos(
      [
        { content: 'Read invoice code', status: 'completed', activeForm: 'Reading' },
        { content: 'Add logo', status: 'in_progress', activeForm: 'Adding the logo' },
        { content: 'Bold total', status: 'pending' },
      ],
      'Invoice header',
      null,
    )!
    expect(t.done).toBe(1)
    expect(t.total).toBe(3)
    expect(taskPct(t)).toBe(33)
    expect(t.current).toBe('Adding the logo')
    expect(taskBarFromTodos([], 'x', null)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Simulated agent runs, driving the real hooks
// ---------------------------------------------------------------------------

async function start($: Engine, on: On) {
  const k = kit(on)
  answerSpawns(on)
  await $.session.start({ cwd: CWD, surface: 'desktop', isInteractive: true })
  return k
}

async function spawn($: Engine, n: number, description = 'Research docs', subagentType = 'Explore'): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) {
    const r = await $.agent.spawn(spawnArgs(`${description} ${i + 1}`, subagentType))
    if ('agentId' in r && r.agentId) ids.push(r.agentId)
  }
  return ids
}

const cards = async (ui: { findAll: (q: { type?: string; key?: string }) => Promise<{ key: string | undefined }[]> }) =>
  (await ui.findAll({ type: 'Box' })).map(b => b.key).filter((k): k is string => typeof k === 'string' && k.startsWith('agent-'))

const monitorBox = async (ui: { findAll: (q: { type?: string }) => Promise<{ props: Record<string, unknown> }[]> }) =>
  (await ui.findAll({ type: 'Box' })).find(b => b.props.height !== undefined && b.props.overflow === 'hidden')

for (const n of [1, 2, 4, 10]) {
  test(`simulated run with ${n} agent(s): start, work, finish, all-done notification`, async ($, on) => {
    const k = await start($, on)
    const ids = await spawn($, n)
    expect(ids.length).toBe(n)
    for (const id of ids) {
      await $.turn.start(turnStart(id))
      await $.tool.call({ tool: 'WebSearch', query: 'shopify theme docs', mode: 'standard', agentId: id })
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect((await cards(ui)).length).toBe(Math.min(n, 4))
    expect(await ui.find({ type: 'Text', text: new RegExp(`Helper Desk · ${n} subagent`) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\[Research\]/ })).toBeDefined()
    for (const id of ids) await $.turn.complete(turnDone(id))
    await k.clock.advance(2100)
    expect(k.notes.some(t => t.includes(`All ${n} subagents finished`)) || k.runs.some(r => r[0] === 'powershell')).toBe(true)
    await ui.unmount()
  })
}

// ---------------------------------------------------------------------------
// Agent monitor acceptance tests
// ---------------------------------------------------------------------------

describe('agent monitor acceptance', () => {
  test('1, 2, 10: the monitor is a fixed, bounded block that agent count never changes; the chat scroll is separate', async ($, on) => {
    await start($, on)
    const heights: unknown[] = []
    for (const add of [0, 1, 3, 6]) {
      await spawn($, add)
      const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
      heights.push((await monitorBox(ui))?.props.height)
      await ui.unmount()
    }
    expect(new Set(heights).size).toBe(1)
    expect(heights[0]).toBe(monitorRows(40))
  })

  test('3, 4: 3-4 agents visible; the rest are reachable by paging', async ($, on) => {
    await start($, on)
    await spawn($, 10)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const first = await cards(ui)
    expect(first.length).toBeGreaterThanOrEqual(3)
    expect(first.length).toBeLessThanOrEqual(4)
    expect(await ui.find({ key: 'agents-next' })).toBeDefined()
    await ui.press({ key: 'agents-next' })
    const second = await cards(ui)
    expect(second.some(id => first.includes(id))).toBe(false)
    await ui.unmount()
  })

  test('5, 13: status and metrics update live; missing metrics show a dash', async ($, on) => {
    await start($, on)
    const [id] = await spawn($, 1)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /— tok · —/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Waiting/ })).toBeDefined()
    await $.turn.start(turnStart(id!))
    await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: id! })
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: /Running/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Bash npm test/ })).toBeDefined()
    await ui.unmount()
  })

  test('6, 7, 8: a stuck agent gets critical priority and stays pinned until acknowledged; acknowledged is not recovered', async ($, on) => {
    const k = await start($, on)
    const ids = await spawn($, 3)
    for (const id of ids) await $.turn.start(turnStart(id))
    // Keep the first two busy; the third goes quiet.
    for (let s = 0; s < 13; s++) {
      await k.clock.advance(10_000)
      await $.tool.call({ tool: 'Read', file_path: 'a.ts', agentId: ids[0]! })
      await $.tool.call({ tool: 'Read', file_path: 'b.ts', agentId: ids[1]! })
    }
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const order = await cards(ui)
    expect(order[0]).toBe(`agent-${ids[2]}`)
    expect(await ui.find({ type: 'Text', text: /Stuck/ })).toBeDefined()
    expect(await ui.find({ key: `ack-${ids[2]}` })).toBeDefined()
    // Still pinned after more time passes.
    await k.clock.advance(30_000)
    await ui.redraw()
    expect((await cards(ui))[0]).toBe(`agent-${ids[2]}`)
    await ui.press({ key: `ack-${ids[2]}` })
    expect(await ui.find({ key: `ack-${ids[2]}` })).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /┆/ })).toBeDefined() // acknowledged look
    expect(await ui.find({ type: 'Text', text: /Stuck/ })).toBeDefined() // not recovered
    await ui.unmount()
  })

  test('7: a stuck agent that recovers loses its pin automatically', async ($, on) => {
    const k = await start($, on)
    const [id] = await spawn($, 1)
    await $.turn.start(turnStart(id!))
    await k.clock.advance(125_000)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ key: `ack-${id}` })).toBeDefined()
    await $.tool.call({ tool: 'Bash', command: 'ls', agentId: id! })
    await ui.redraw()
    expect(await ui.find({ key: `ack-${id}` })).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /Running/ })).toBeDefined()
    await ui.unmount()
  })

  test('9, 11: minor metric changes do not reorder, and the page you scrolled to survives updates', async ($, on) => {
    await start($, on)
    const ids = await spawn($, 9)
    for (const id of ids) await $.turn.start(turnStart(id))
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    const before = await cards(ui)
    await ui.press({ key: 'agents-next' })
    const page2 = await cards(ui)
    for (const id of ids) await $.tool.call({ tool: 'Read', file_path: 'x.ts', agentId: id })
    await ui.redraw()
    expect(await cards(ui)).toEqual(page2)
    await ui.press({ key: 'agents-prev' })
    expect(await cards(ui)).toEqual(before)
    await ui.unmount()
  })

  test('10, 12: adding or removing agents shifts nothing else, and the layout follows a resize', async ($, on) => {
    await start($, on)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const boxes = async () => (await ui.findAll({ type: 'Box' })).filter(b => b.props.height !== undefined).map(b => b.props.height)
    const empty = await boxes()
    await spawn($, 5)
    await ui.redraw()
    expect(await boxes()).toEqual(empty)
    await ui.redraw({ ...PANE.props, scroll: { offset: 0, bodyRows: 60 }, bodyColumns: 40 })
    const big = await boxes()
    expect(big[0]).toBe(monitorRows(60))
    expect(big[0]).toBeLessThan(60)
    await ui.unmount()
  })
})
