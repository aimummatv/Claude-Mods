// The Toolkit pane (fixed monitor on top, own scroller below), the band above the prompt
// (at most two rows, by priority), and the /toolkit command.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, On, RenderElement } from 'claude-code'

import type { FeatureKey, Tier, ToolkitSettings, ViewState } from '../../types'
import { renderAutoSection, setOverride } from './automodel'
import { renderMonitor, renderTaskBar } from './helperdesk'
import { renderWarmBand } from './keepwarm'
import { renderMeterLine, renderMeterSection } from './projectmap'
import { DEFAULT_SETTINGS, FEATURES, getSettings, guard, saveSettings } from './settings'
import { renderSkillHint, renderSkillsSection } from './skills'
import { C } from './ui'
import type { Els } from './ui'
import { renderUsageSection } from './usage'
import { renderVoiceBand } from './voice'

export const PANE_ID = 'toolkit'
export const EMPTY_VIEW: ViewState = { lowerOffset: 0, showSettings: false }
export const viewAtom = atom({ plugin: 'toolkit', key: 'view' } as const, EMPTY_VIEW)

// ---------------------------------------------------------------------------
// Pure layout maths (tested)
// ---------------------------------------------------------------------------

/** The monitor's fixed height: ~30% of the pane, never fewer rows than 3 compact cards need. */
export const monitorRows = (bodyRows: number): number => Math.max(11, Math.min(18, Math.round(bodyRows * 0.3)))

export const lowerRows = (bodyRows: number): number => Math.max(6, bodyRows - monitorRows(bodyRows) - 2)

/** First element shown in the lower area, kept in range. */
export const clampOffset = (offset: number, count: number): number => Math.max(0, Math.min(offset, Math.max(0, count - 1)))

/** Picks what the band above the prompt shows: the first two that have something, in priority order. */
export const pickBand = <T,>(candidates: readonly (T | null)[], max = 2): T[] => candidates.filter((c): c is T => c !== null).slice(0, max)

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

type NumKey = Exclude<keyof ToolkitSettings, 'features' | 'modelOverride'>
export const TUNABLE: { key: NumKey; label: string; step: number; min: number }[] = [
  { key: 'voiceWordThreshold', label: 'Voice: word threshold', step: 5, min: 10 },
  { key: 'voiceCountdownSec', label: 'Voice: countdown (s)', step: 1, min: 3 },
  { key: 'agentTokenLimit', label: 'Agent token limit', step: 50_000, min: 50_000 },
  { key: 'stuckMinutes', label: 'Stuck after (min)', step: 1, min: 1 },
  { key: 'mapWordCap', label: 'Map word cap', step: 250, min: 500 },
  { key: 'doneNotifySec', label: 'Done notification after (s)', step: 30, min: 30 },
]

export const featureByName = (name: string): FeatureKey | null => {
  const n = name.toLowerCase().replace(/[^a-z]/g, '')
  const alias: Record<string, FeatureKey> = {
    voice: 'voice',
    cleaner: 'voice',
    helperdesk: 'helperDesk',
    helper: 'helperDesk',
    agents: 'helperDesk',
    keepwarm: 'keepWarm',
    warm: 'keepWarm',
    cache: 'keepWarm',
    projectmap: 'projectMap',
    map: 'projectMap',
    meter: 'projectMap',
    planusage: 'planUsage',
    usage: 'planUsage',
    skills: 'skills',
    skill: 'skills',
    automodel: 'autoModel',
    auto: 'autoModel',
    model: 'autoModel',
    done: 'doneNotify',
    donenotify: 'doneNotify',
    bigread: 'bigRead',
    read: 'bigRead',
  }
  return alias[n] ?? null
}

export const HELP = [
  '/toolkit                 open the Toolkit pane',
  '/toolkit settings        open the pane on its settings',
  '/toolkit on <feature>    turn a feature on (voice, helper, warm, map, usage, skills, auto, done, bigread)',
  '/toolkit off <feature>   turn a feature off',
  '/toolkit model <haiku|sonnet|opus|auto>   pin a model or go back to Auto',
  '/toolkit set <setting> <number>           e.g. /toolkit set voiceWordThreshold 50',
  '/toolkit status          what is on',
  '/toolkit reset           restore default settings',
].join('\n')

export async function runCommand($: EngineInterface, args: string): Promise<string> {
  const [verb = '', ...rest] = args.trim().split(/\s+/).filter(Boolean)
  const v = verb.toLowerCase()
  if (v === '' || v === 'open' || v === 'settings') {
    if (v === 'settings') await update($, viewAtom, x => ({ ...x, showSettings: true }))
    const r = await $.ui.open({ id: PANE_ID, title: 'Toolkit' })
    return r.isPlaced ? 'Toolkit pane open.' : `Toolkit pane is waiting for room (${r.reason ?? 'not placed'}).`
  }
  if (v === 'help') return HELP
  if (v === 'on' || v === 'off') {
    const f = featureByName(rest.join(' '))
    if (!f) return `Unknown feature. ${HELP}`
    await saveSettings($, s => ({ ...s, features: { ...s.features, [f]: v === 'on' } }))
    return `${FEATURES.find(x => x.key === f)?.label ?? f} is ${v}.`
  }
  if (v === 'model') {
    const t = (rest[0] ?? '').toLowerCase()
    if (t !== 'auto' && t !== 'haiku' && t !== 'sonnet' && t !== 'opus') return 'Use: /toolkit model haiku|sonnet|opus|auto'
    await setOverride($, t as Tier | 'auto')
    return t === 'auto' ? 'Auto Model decides again.' : `Model pinned to ${t}.`
  }
  if (v === 'set') {
    const key = TUNABLE.find(t => t.key.toLowerCase() === (rest[0] ?? '').toLowerCase())?.key ?? (rest[0] as NumKey | undefined)
    const n = Number(rest[1])
    if (!key || !(key in DEFAULT_SETTINGS) || key === ('features' as string) || !Number.isFinite(n) || n <= 0) {
      return `Use: /toolkit set <setting> <number>. Settings: ${Object.keys(DEFAULT_SETTINGS).filter(k => k !== 'features' && k !== 'modelOverride').join(', ')}`
    }
    await saveSettings($, s => ({ ...s, [key]: n }))
    return `${key} = ${n}`
  }
  if (v === 'status') {
    const s = await getSettings($)
    return FEATURES.map(f => `${s.features[f.key] ? 'on ' : 'off'}  ${f.label}`).join('\n') + `\nmodel: ${s.modelOverride}`
  }
  if (v === 'reset') {
    await saveSettings($, () => DEFAULT_SETTINGS)
    return 'Toolkit settings reset to defaults.'
  }
  return HELP
}

async function renderSettings($: EngineInterface, E: Els): Promise<RenderElement[]> {
  const { Box, Text, Button } = E
  const s = await getSettings($)
  const rows: RenderElement[] = [
    <Box flexDirection="row" justifyContent="space-between">
      <Text bold color={C.purpleSoft}>
        Settings
      </Text>
      <Button key="settings-close" label="Done" onPress={() => void update($, viewAtom, x => ({ ...x, showSettings: false }))} />
    </Box>,
  ]
  for (const f of FEATURES) {
    const on = s.features[f.key]
    rows.push(
      <Button
        key={`feat-${f.key}`}
        plain
        onPress={() => void saveSettings($, x => ({ ...x, features: { ...x.features, [f.key]: !x.features[f.key] } }))}
      >
        <Text color={on ? C.green : C.grey}>{on ? '● on ' : '○ off'}</Text> {f.label} <Text dimColor>{f.hint}</Text>
      </Button>,
    )
  }
  for (const t of TUNABLE) {
    rows.push(
      <Box flexDirection="row" gap={1}>
        <Button key={`dec-${t.key}`} label="−" onPress={() => void saveSettings($, x => ({ ...x, [t.key]: Math.max(t.min, x[t.key] - t.step) }))} />
        <Button key={`inc-${t.key}`} label="+" onPress={() => void saveSettings($, x => ({ ...x, [t.key]: x[t.key] + t.step }))} />
        <Text color={C.text}>
          {t.label}: {s[t.key].toLocaleString()}
        </Text>
      </Box>,
    )
  }
  rows.push(<Text color={C.muted}>Settings are saved in %USERPROFILE%\.claude\toolkit\settings.json</Text>)
  return rows
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export const registerView = (on: On): void => {
  on('command.run', { command: 'toolkit' }, async ($, e) => {
    const text = await guard($, 'view', () => runCommand($, e.args))
    return { text: text ?? 'Toolkit: that command failed; see %USERPROFILE%\\.claude\\toolkit\\logs\\view.log' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const E = $.ui.resolve(e)
    const { Box, Text, Button } = E
    const bodyRows = e.props.scroll.bodyRows || e.viewport?.rows || 36
    const columns = e.props.bodyColumns || 60
    const top = monitorRows(bodyRows)
    const low = lowerRows(bodyRows)
    const s = await getSettings($)
    const view = await read($, viewAtom)
    const surface = e.surface

    const monitor = s.features.helperDesk
      ? await renderMonitor($, E, top, columns)
      : (
          <Box height={top} overflow="hidden">
            <Text color={C.grey}>Helper Desk is off (/toolkit on helper).</Text>
          </Box>
        )

    const sections: { key: string; label: string; rows: RenderElement[] }[] = []
    if (view.showSettings) sections.push({ key: 'settings', label: '⚙', rows: await renderSettings($, E) })
    if (s.features.projectMap) sections.push({ key: 'meter', label: 'Meter', rows: await renderMeterSection($, E, surface) })
    if (s.features.skills) sections.push({ key: 'skills', label: 'Skills', rows: await renderSkillsSection($, E) })
    if (s.features.planUsage) sections.push({ key: 'usage', label: 'Usage', rows: await renderUsageSection($, E, surface) })
    sections.push({ key: 'auto', label: 'Auto', rows: await renderAutoSection($, E) })

    const flat: RenderElement[] = []
    const starts: Record<string, number> = {}
    for (const sec of sections) {
      starts[sec.key] = flat.length
      flat.push(...sec.rows, <Text> </Text>)
    }
    const offset = clampOffset(view.lowerOffset, flat.length)
    const go = (n: number) => update($, viewAtom, x => ({ ...x, lowerOffset: clampOffset(n, flat.length) }))

    return (
      <Box flexDirection="column">
        {monitor}
        <Box flexDirection="row" gap={1}>
          <Button key="low-up" plain label="▲" onPress={() => void go(offset - 3)} />
          <Button key="low-down" plain label="▼" onPress={() => void go(offset + 3)} />
          {sections.map(sec => (
            <Button key={`jump-${sec.key}`} plain label={sec.label} onPress={() => void go(starts[sec.key] ?? 0)} />
          ))}
          {!view.showSettings ? (
            <Button key="open-settings" plain label="⚙" onPress={() => void update($, viewAtom, x => ({ ...x, showSettings: true, lowerOffset: 0 }))} />
          ) : null}
        </Box>
        <Box flexDirection="column" height={low} overflow="hidden">
          {flat.slice(offset)}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const E = $.ui.resolve(e)
    const s = await getSettings($)
    const cols = e.props.bodyColumns || 80
    const safe = async (f: () => Promise<RenderElement | null>) => (await guard($, 'band', f)) ?? null
    const rows = pickBand([
      s.features.voice ? await safe(() => renderVoiceBand($, E, e.surface)) : null,
      await safe(() => renderWarmBand($, E, e.props.isWorking)),
      await safe(() => renderMeterLine($, E)),
      s.features.helperDesk ? await safe(() => renderTaskBar($, E, cols)) : null,
      await safe(() => renderSkillHint($, E)),
    ])
    if (rows.length === 0) return next(e)
    const { Box } = E
    return <Box flexDirection="column">{rows}</Box>
  })
}
