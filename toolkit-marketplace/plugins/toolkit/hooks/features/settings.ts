// Settings, the files Toolkit keeps under %USERPROFILE%\.claude\toolkit, and capped logs.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { FeatureKey, ToolkitSettings } from '../../types'
import { joinPath, resolveHome, toolkitDir } from './paths'
import { redactSecrets } from './redact'

export const FEATURES: { key: FeatureKey; label: string; hint: string }[] = [
  { key: 'voice', label: 'Voice Prompt Cleaner', hint: 'Tidies long spoken prompts' },
  { key: 'helperDesk', label: 'Helper Desk', hint: 'Task bar + subagent monitor' },
  { key: 'keepWarm', label: 'Keep Warm', hint: 'One-click cache ping before it goes cold' },
  { key: 'projectMap', label: 'Project Map + Chat Meter', hint: 'PROJECT_MAP.md and context gauge' },
  { key: 'planUsage', label: 'Plan Usage Meter', hint: '5-hour and weekly limits' },
  { key: 'skills', label: 'Skill Helper', hint: 'Suggests installed skills' },
  { key: 'autoModel', label: 'Auto Model', hint: 'Haiku / Sonnet / Opus per task' },
  { key: 'doneNotify', label: 'Done notification', hint: 'Notify when a long turn ends' },
  { key: 'bigRead', label: 'Big-read warning', hint: 'Ask before reading huge files' },
]

export const DEFAULT_SETTINGS: ToolkitSettings = {
  features: {
    voice: true,
    helperDesk: true,
    keepWarm: true,
    projectMap: true,
    planUsage: true,
    skills: true,
    autoModel: true,
    doneNotify: true,
    bigRead: true,
  },
  voiceWordThreshold: 40,
  voiceCountdownSec: 10,
  voiceQuestionSec: 15,
  agentTokenWarn: 150_000,
  agentTokenCritical: 300_000,
  agentTokenLimit: 400_000,
  stuckMinutes: 2,
  keepWarmLeadSec: 120,
  mapWordCap: 1500,
  meterWindow: 250_000,
  meterLineFrom: 200_000,
  bigReadTokens: 20_000,
  bigReadLines: 2000,
  doneNotifySec: 60,
  modelOverride: 'auto',
}

/** Merges whatever was stored over the defaults, keeping only known keys of the right type. */
export const mergeSettings = (stored: unknown): ToolkitSettings => {
  const out: ToolkitSettings = { ...DEFAULT_SETTINGS, features: { ...DEFAULT_SETTINGS.features } }
  if (typeof stored !== 'object' || stored === null) return out
  const s = stored as Record<string, unknown>
  const feats = s.features
  if (typeof feats === 'object' && feats !== null) {
    for (const f of FEATURES) {
      const v = (feats as Record<string, unknown>)[f.key]
      if (typeof v === 'boolean') out.features[f.key] = v
    }
  }
  const numKeys = [
    'voiceWordThreshold',
    'voiceCountdownSec',
    'voiceQuestionSec',
    'agentTokenWarn',
    'agentTokenCritical',
    'agentTokenLimit',
    'stuckMinutes',
    'keepWarmLeadSec',
    'mapWordCap',
    'meterWindow',
    'meterLineFrom',
    'bigReadTokens',
    'bigReadLines',
    'doneNotifySec',
  ] as const
  for (const k of numKeys) {
    const v = s[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v
  }
  const o = s.modelOverride
  if (o === 'auto' || o === 'haiku' || o === 'sonnet' || o === 'opus') out.modelOverride = o
  return out
}

export const settingsAtom = atom({ plugin: 'toolkit', key: 'settings' } as const, DEFAULT_SETTINGS)

// ---- Where files go ----
let homeCache: string | null = null

export async function homeDir($: EngineInterface): Promise<string> {
  if (homeCache !== null) return homeCache
  const home = resolveHome({
    USERPROFILE: await $.env.get('USERPROFILE'),
    HOME: await $.env.get('HOME'),
    HOMEDRIVE: await $.env.get('HOMEDRIVE'),
    HOMEPATH: await $.env.get('HOMEPATH'),
  })
  homeCache = home ?? '.'
  return homeCache
}

export async function toolkitPath($: EngineInterface, ...parts: string[]): Promise<string> {
  return joinPath(toolkitDir(await homeDir($)), ...parts)
}

export async function readJson($: EngineInterface, file: string): Promise<unknown> {
  try {
    const path = await toolkitPath($, file)
    if (!(await $.fs.exists(path))) return undefined
    return JSON.parse(String(await $.fs.read(path)))
  } catch {
    return undefined
  }
}

/** Writes JSON under the toolkit folder; secrets are masked first. */
export async function writeJson($: EngineInterface, file: string, value: unknown): Promise<void> {
  const path = await toolkitPath($, file)
  await $.fs.write(path, redactSecrets(JSON.stringify(value, null, 2)))
}

export async function loadSettings($: EngineInterface): Promise<ToolkitSettings> {
  const s = mergeSettings(await readJson($, 'settings.json'))
  await update($, settingsAtom, () => s)
  return s
}

export function getSettings($: EngineInterface): Promise<ToolkitSettings> {
  return read($, settingsAtom)
}

export async function saveSettings($: EngineInterface, fn: (s: ToolkitSettings) => ToolkitSettings): Promise<ToolkitSettings> {
  let next: ToolkitSettings = DEFAULT_SETTINGS
  await update($, settingsAtom, s => {
    next = fn(mergeSettings(s))
    return next
  })
  await writeJson($, 'settings.json', next)
  return next
}

export async function isOn($: EngineInterface, key: FeatureKey): Promise<boolean> {
  return (await getSettings($)).features[key]
}

// ---- Logs: one file per feature, last 200 lines kept ----
export const LOG_LIMIT = 200

export const capLines = (text: string, limit = LOG_LIMIT): string => {
  const lines = text.split(/\r?\n/).filter(l => l.length > 0)
  return lines.slice(-limit).join('\n') + '\n'
}

export async function log($: EngineInterface, feature: string, line: string): Promise<void> {
  try {
    const path = await toolkitPath($, 'logs', `${feature}.log`)
    const old = (await $.fs.exists(path)) ? String(await $.fs.read(path)) : ''
    const stamp = new Date(await $.clock.now()).toISOString()
    await $.fs.write(path, capLines(`${old}${stamp} ${redactSecrets(line).replace(/\r?\n/g, ' ')}`))
  } catch {
    // Logging must never break a feature.
  }
}

/** Runs one feature's work; a failure is logged and swallowed so other features and the chat go on. */
export async function guard<T>($: EngineInterface, feature: string, work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch (err) {
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    void log($, feature, `error: ${msg}`)
    return undefined
  }
}
