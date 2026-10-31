// Toolkit's state contract: every value the mod keeps in `$.state`.
// Value types live here so the hooks module and its tests import one shape.

export type FeatureKey =
  | 'voice'
  | 'helperDesk'
  | 'keepWarm'
  | 'projectMap'
  | 'planUsage'
  | 'skills'
  | 'autoModel'
  | 'doneNotify'
  | 'bigRead'

export type Tier = 'haiku' | 'sonnet' | 'opus'

export type ToolkitSettings = {
  features: Record<FeatureKey, boolean>
  voiceWordThreshold: number
  voiceCountdownSec: number
  voiceQuestionSec: number
  agentTokenWarn: number
  agentTokenCritical: number
  agentTokenLimit: number
  stuckMinutes: number
  keepWarmLeadSec: number
  mapWordCap: number
  meterWindow: number
  meterLineFrom: number
  bigReadTokens: number
  bigReadLines: number
  doneNotifySec: number
  modelOverride: Tier | 'auto'
}

// ---- 1. Voice prompt cleaner ----
export type VoiceQuestion = {
  id: string
  text: string
  options: string[]
  point: number | null
  answer: string | null
  secondsLeft: number
  isSkipped: boolean
}

export type VoiceState = {
  phase: 'idle' | 'cleaning' | 'review'
  original: string
  items: string[]
  unclear: number[]
  questions: VoiceQuestion[]
  secondsLeft: number
  isPaused: boolean
  error: string | null
}

// ---- 2. Helper Desk ----
export type TaskBar = {
  title: string
  done: number
  total: number
  current: string
  signature: string
  hiddenSignature: string | null
}

export type AgentStatusKind = 'waiting' | 'running' | 'stuck' | 'completed' | 'failed' | 'stopped'
export type AgentBadge = 'Research' | 'Design' | 'Code' | 'Browser' | 'General'

export type AgentCommand = { startedAt: number; timeoutMs: number; label: string }

export type AgentRec = {
  id: string
  name: string
  badge: AgentBadge
  badgeCounts: { research: number; design: number; code: number; browser: number }
  status: AgentStatusKind
  model: string | null
  tokens: number | null
  outputTokens: number
  genMs: number
  startedAt: number
  endedAt: number | null
  lastActivityAt: number
  lastActivity: string
  command: AgentCommand | null
  stuckSince: number | null
  stuckReason: string | null
  acknowledged: boolean
  mainFile: string | null
  note: string | null
  stopRequested: boolean
  band: number
}

export type AgentsState = {
  recs: Record<string, AgentRec>
  order: string[]
  page: number
  allDoneNotified: boolean
}

// ---- 3. Keep warm ----
export type WarmState = {
  ttlSec: number | null
  ttlSource: 'transcript' | 'assumed' | null
  lastAt: number | null
  cachedTokens: number | null
  dismissedFor: number | null
  notifiedFor: number | null
  transcriptPath: string | null
  lastPing: number | null
}

// ---- 4. Project map + chat meter ----
export type PendingChange = {
  id: string
  summary: string
  files: string[]
  at: number
}

export type MapState = {
  path: string | null
  pending: PendingChange[]
  lastUpdateAt: number | null
  lastSections: string[]
  isUpdating: boolean
  lastError: string | null
  words: number
}

export type MeterState = {
  contextTokens: number | null
  window: number
  samples: number[]
  newChatStatus: string | null
}

// ---- 5. Plan usage ----
export type UsageWindow = {
  pct: number | null
  resetsAt: number | null
  tokens: number | null
}

export type UsageState = {
  mode: 'live' | 'estimate' | 'none'
  five: UsageWindow
  week: UsageWindow
  checkedAt: number | null
}

// ---- 6. Skills ----
export type SkillInfo = {
  name: string
  command: string
  description: string
  howTo: string
  source: string
  path: string | null
}

export type SkillsState = {
  all: SkillInfo[]
  suggested: { name: string; score: number }[]
  selected: string | null
  query: string
  hint: string | null
  hintTask: number
  dismissedTask: number
  task: number
}

// ---- 7. Auto model ----
export type AutoState = {
  tier: Tier | null
  reasons: string[]
  files: number
  savingPct: number | null
  action: 'switch' | 'keep' | 'route' | null
  decidedBy: 'rules' | 'haiku' | 'override' | 'escalate' | null
  mainTier: Tier | null
  taskKind: string | null
  escalations: number
}

export type AutoRecord = {
  byTask: Record<string, Record<Tier, { accepted: number; rejected: number }>>
  overrides: number
  week: { start: number; tasks: Record<Tier, number>; tokens: Record<Tier, number> }
}

// ---- Pane view ----
export type ViewState = {
  lowerOffset: number
  showSettings: boolean
}

declare module 'claude-code' {
  interface PluginState {
    toolkit: {
      settings: ToolkitSettings
      voice: VoiceState
      tasks: TaskBar | null
      agents: AgentsState
      warm: WarmState
      map: MapState
      meter: MeterState
      usage: UsageState
      skills: SkillsState
      auto: AutoState
      view: ViewState
      tick: number
    }
  }
}
