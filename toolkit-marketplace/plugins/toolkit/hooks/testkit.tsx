// Test helper (imported by *.test.tsx only): answers the engine calls Toolkit makes,
// with an in-memory file system, a mocked clock and a Windows environment.
import { mock } from 'claude-code/testing'
import type { AgentInfo, On, SessionUsage, TurnStepResult } from 'claude-code'

export const HOME = 'C:\\Users\\aman'
export const CWD = 'C:\\Users\\aman\\shop'
export const T0 = Date.UTC(2026, 9, 31, 12, 0, 0)

export type Kit = {
  files: Map<string, string>
  runs: string[][]
  notes: string[]
  toasts: string[]
  fills: string[]
  submits: string[]
  agents: AgentInfo[]
  usage: SessionUsage
  modelReplies: string[]
  statuses: (string | undefined)[]
  commands: string[]
  spawnModels: (string | undefined)[]
  classifyAs: string
  askAnswer: string
  tools: { tool: string; input: Record<string, unknown> }[]
  steps: { model: string; agentId?: string }[]
  clock: ReturnType<typeof mock.clock>
}

export function kit(on: On, extra?: (k: Kit) => void): Kit {
  const k: Kit = {
    files: new Map(),
    runs: [],
    notes: [],
    toasts: [],
    fills: [],
    submits: [],
    agents: [],
    usage: { startedAt: T0, context: { tokens: 12_000, window: 200_000, percent: 6 }, rateLimits: [] },
    modelReplies: [],
    statuses: [],
    commands: [],
    spawnModels: [],
    classifyAs: 'normal',
    askAnswer: 'Read all',
    tools: [],
    steps: [],
    clock: mock.clock(on, { now: T0 }),
  }
  mock.env(on, { USERPROFILE: HOME, OS: 'Windows_NT' })
  // On a non-Windows test machine the engine makes C:\ paths relative to the cwd: strip that back off.
  const norm = (p: string) => p.replace(/^.*?(?=[A-Za-z]:[\\/])/, '').replace(/\//g, '\\').toLowerCase()
  const find = (p: string) => [...k.files.keys()].find(f => norm(f) === norm(p))
  on('fs.read', (_$, e) => {
    const f = find(e.path)
    if (f === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: k.files.get(f)! }
  })
  on('fs.write', (_$, e) => {
    k.files.set(find(e.path) ?? e.path.replace(/^.*?(?=[A-Za-z]:[\\/])/, ''), e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: find(e.path) !== undefined || [...k.files.keys()].some(f => norm(f).startsWith(norm(e.path) + '\\')) }))
  on('fs.stat', (_$, e) => {
    const f = find(e.path)
    if (f === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: { kind: 'file' as const, size: k.files.get(f)!.length, mtimeMs: T0, isLink: false } }
  })
  on('fs.list', (_$, e) => {
    const base = norm(e.path) + '\\'
    const names = new Map<string, 'file' | 'dir'>()
    for (const f of k.files.keys()) {
      if (!norm(f).startsWith(base)) continue
      const rest = f.slice(base.length).split(/[\\/]/)
      names.set(rest[0]!, rest.length > 1 ? 'dir' : 'file')
    }
    return {
      value: [...names].map(([name, kind]) => ({ name, kind, size: kind === 'file' ? 10 : 0, mtimeMs: T0, isLink: false })),
    }
  })
  on('ui.open', () => ({ value: { isPlaced: true as const } }))
  on('ui.notify', (_$, e) => {
    k.notes.push(e.text)
    return { value: { isSent: false as const, reason: 'no-channel' as const } }
  })
  on('ui.toast', (_$, e) => {
    k.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_$, e) => {
    k.statuses.push((e as { text?: string }).text)
    return { value: undefined }
  })
  on('command.run', (_$, e) => {
    k.commands.push(e.command)
    return { text: '' }
  })
  on('agent.spawn', (_$, e) => {
    k.spawnModels.push(e.model)
    return { model: e.model ?? 'claude-haiku-5-5', agentId: `agent-${++agentSeq}` }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('process.run', (_$, e) => {
    k.runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.cwd', () => ({ value: CWD }))
  on('session.id', () => ({ value: 'sess1' }))
  on('session.model', () => ({ value: 'claude-sonnet-5-5' }))
  on('session.usage', () => ({ value: k.usage }))
  on('session.messages', () => ({ value: [] }))
  on('agent.list', () => ({ value: k.agents }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('prompt.fill', (_$, e) => {
    k.fills.push(e.text)
    return { isFilled: true }
  })
  on('model.complete', () => {
    const text = k.modelReplies.shift()
    const usage = { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    return { value: text === undefined ? { isAnswered: false as const, reason: 'empty-reply' as const, usage } : { isAnswered: true as const, text, usage } }
  })
  on('model.classify', () => ({ value: k.classifyAs }))
  on('model.fork', () => ({
    value: { isAnswered: true as const, text: 'ok', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 0 } },
  }))
  on('tool.call', (_$, e) => {
    k.tools.push({ tool: String(e.tool), input: e as unknown as Record<string, unknown> })
    if (e.tool === 'AskUserQuestion') {
      const q = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
      return { result: { questions: [], answers: { [q]: k.askAnswer } } }
    }
    return { result: {} }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.step', async function* (_$, e) {
    k.steps.push(e.agentId ? { model: e.model, agentId: e.agentId } : { model: e.model })
    const usage = { input_tokens: 2000, output_tokens: 500, cache_read_input_tokens: 60_000, cache_creation_input_tokens: 1000, model: e.model }
    const result: TurnStepResult = { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage }
    return result
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  extra?.(k)
  return k
}

let agentSeq = 0
/** Kept for older tests: spawns are answered by kit() itself. */
export function answerSpawns(_on: On): void {}

export const PANE = {
  plugin: 'toolkit',
  component: 'Pane',
  requestId: 'toolkit',
  props: {
    title: 'Toolkit',
    isFocused: false,
    bodyColumns: 64,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

export const BAND = {
  plugin: 'toolkit',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const

export const spawnArgs = (description: string, subagentType = 'general-purpose', model?: string) => ({
  tool_use_id: `tu-${description}`,
  prompt: 'go',
  description,
  subagentType,
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-sonnet-5-5',
  background: true,
  fork: false,
  ...(model ? { model } : {}),
})

export const turnStart = (agentId: string | undefined, turnId = `t-${agentId ?? 'main'}`) => ({
  turnId,
  text: '',
  ...(agentId ? { agentId } : {}),
})

export const turnDone = (agentId: string | undefined, over: { durationMs?: number; answer?: string; turnId?: string } = {}) => ({
  turnId: over.turnId ?? `t-${agentId ?? 'main'}`,
  answer: over.answer ?? 'done',
  durationMs: over.durationMs ?? 1000,
  isAborted: false,
  reason: 'answer' as const,
  ...(agentId ? { agentId } : {}),
})

export const stepArgs = (agentId?: string, model = 'claude-sonnet-5-5', index = 0) => ({
  turnId: `t-${agentId ?? 'main'}`,
  index,
  model,
  messageCount: 3,
  ...(agentId ? { agentId } : {}),
})

/** Runs one model step through the hooks, reading the stream to its end. */
export async function runStep($: { turn: { step: (e: ReturnType<typeof stepArgs>) => AsyncGenerator<unknown, unknown> & { result: Promise<unknown> } } }, args: ReturnType<typeof stepArgs>): Promise<unknown> {
  const s = $.turn.step(args)
  for (;;) {
    const r = await s.next()
    if (r.done) return r.value
  }
}
