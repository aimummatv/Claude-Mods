// Toolkit: one mod, seven features. This file wires them; each feature lives in hooks/features/.
// Every feature's work runs inside guard(): one feature failing never breaks the others or the chat.
import type { EngineInterface, Register, TurnStepResult } from 'claude-code'

import { automodelSpawnModel, automodelToolPost, automodelTurnComplete, mainStepModel, onUserMessageAuto } from './features/automodel'
import type { ToolInput } from './features/bus'
import { extrasTurnComplete, registerExtras } from './features/extras'
import {
  helperTick,
  helperdeskSpawned,
  helperdeskToolPost,
  helperdeskToolPre,
  helperdeskTurnComplete,
  helperdeskTurnStart,
  onAgentStepEnd,
  onAgentStepStart,
  setPlanTitle,
  touchAgent,
} from './features/helperdesk'
import { bumpTick, coldInMs, keepwarmTurnComplete, keepwarmTurnStart, onMainStep, refreshTtl, registerKeepWarm, warmTick } from './features/keepwarm'
import { contextTokens, onUserMessage, projectmapToolPost, projectmapTurnComplete } from './features/projectmap'
import { getSettings, guard, isOn, loadSettings } from './features/settings'
import { onUserMessageSkills, skillsSessionStart, skillsToolPre } from './features/skills'
import { fiveHourPct, refreshUsage, usageTurnComplete } from './features/usage'
import { registerView } from './features/view'
import { registerVoice, VOICE_DROP, voiceHold, voiceTick } from './features/voice'

const isPersonsMessage = (origin: { kind: string; name?: string }): boolean =>
  origin.kind === 'composer' || origin.kind === 'bridge' || (origin.kind === 'plugin' && origin.name === 'toolkit')

const withTimeout = <T,>($: EngineInterface, p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>(resolve => void $.clock.after(ms, () => resolve(fallback)))])

const startTimers = ($: EngineInterface): void => {
  let n = 0
  $.clock.every(1000, () => {
    n++
    void guard($, 'voice', () => voiceTick($))
    void guard($, 'keep-warm', () => warmTick($))
    void guard($, 'clock', () => bumpTick($))
    if (n % 2 === 0) void guard($, 'helper-desk', () => helperTick($))
    if (n % 60 === 5) void guard($, 'plan-usage', () => refreshUsage($))
  })
}

export const register: Register = on => {
  // Hooks a single feature owns (each wraps its own work in guard()).
  registerVoice(on)
  registerKeepWarm(on)
  registerExtras(on)
  registerView(on)

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await guard($, 'skills', () => skillsSessionStart($))
    await guard($, 'start', async () => {
      await loadSettings($)
      await $.command.register({
        name: 'toolkit',
        description: 'Toolkit: open the pane, turn features on/off (/toolkit help)',
        argumentHint: '[on|off <feature> | model <tier> | set <key> <n> | status | help]',
      })
      startTimers($)
      $.clock.after(3000, () => {
        void guard($, 'plan-usage', () => refreshUsage($, true))
        void guard($, 'keep-warm', () => refreshTtl($))
      })
    })
    return r
  })

  on('turn.start', async ($, e, next) => {
    await guard($, 'helper-desk', () => helperdeskTurnStart($, e.agentId))
    await guard($, 'keep-warm', () => keepwarmTurnStart($, e.agentId))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await guard($, 'helper-desk', () => helperdeskTurnComplete($, e))
    await guard($, 'keep-warm', () => keepwarmTurnComplete($, e))
    await guard($, 'project-map', () => projectmapTurnComplete($, e))
    await guard($, 'plan-usage', () => usageTurnComplete($, e))
    await guard($, 'auto-model', () => automodelTurnComplete($, e))
    await guard($, 'extras', () => extrasTurnComplete($, e))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as ToolInput
    const tool = String(e.tool)
    await guard($, 'helper-desk', () => helperdeskToolPre($, tool, input))
    await guard($, 'skills', () => skillsToolPre($, tool, input))
    const ran = await next(e)
    const extra: string[] = []
    const lines = await guard($, 'helper-desk', () => helperdeskToolPost($, tool, input, ran))
    if (Array.isArray(lines)) extra.push(...lines)
    await guard($, 'project-map', () => projectmapToolPost($, tool, input, ran))
    await guard($, 'auto-model', () => automodelToolPost($, tool, input, ran))
    if (extra.length > 0 && ran.deny === undefined && ran.isError === undefined) {
      return { ...ran, context: [...(ran.context ?? []), ...extra] }
    }
    return ran
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const model = (await guard($, 'auto-model', () => automodelSpawnModel($, e))) ?? null
    const r = await next(model ? { ...e, model } : e)
    await guard($, 'helper-desk', () => helperdeskSpawned($, e, r))
    return r
  }).catch(($, e, next) => next(e))

  // One prompt hook so the order is fixed: the voice cleaner may hold the message first;
  // everything else sees only messages that really go to Claude.
  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta === true) return next(e)
    if ((await guard($, 'voice', () => voiceHold($, e))) === true) return { drop: VOICE_DROP }
    if (!isPersonsMessage(e.origin as { kind: string; name?: string })) return next(e)
    setPlanTitle(e.text)
    await guard($, 'project-map', () => onUserMessage($, e.text))
    await guard($, 'skills', () => onUserMessageSkills($, e.text))
    const note = await guard($, 'auto-model', async () => {
      const left = await coldInMs($)
      return withTimeout(
        $,
        onUserMessageAuto($, {
          text: e.text,
          hasImage: (e.attachments ?? []).length > 0,
          contextTokens: await contextTokens($),
          cacheCold: left !== null && left <= 0,
          budgetPct: await fiveHourPct($),
        }),
        6000,
        null,
      )
    })
    return typeof note === 'string' ? next({ ...e, context: [...(e.context ?? []), note] }) : next(e)
  }).catch(($, e, next) => next(e))

  // One model-step hook: Auto Model picks the main thread's model; Helper Desk times
  // subagent steps (tokens/s from real usage and streaming time) and stops agents it was asked to.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const id = e.agentId
      const go = (await guard($, 'helper-desk', () => onAgentStepStart($, id))) ?? true
      if (!go) {
        // Stopped: no request is made; the step ends the agent's turn.
        yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
        const stopped: TurnStepResult = { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
        return stopped
      }
      const stream = next(e)
      let first: number | null = null
      for await (const chunk of stream) {
        if (first === null) first = await $.clock.now()
        void guard($, 'helper-desk', () => touchAgent($, id))
        yield chunk
      }
      const result = await stream.result
      const end = await $.clock.now()
      await guard($, 'helper-desk', () => onAgentStepEnd($, id, result.usage, first === null ? 0 : end - first))
      return result
    }
    const model = (await guard($, 'auto-model', async () => ((await isOn($, 'autoModel')) || (await getSettings($)).modelOverride !== 'auto' ? mainStepModel() : null))) ?? null
    const stream = next(model ? { ...e, model } : e)
    for await (const chunk of stream) yield chunk
    const result = await stream.result
    await guard($, 'keep-warm', () =>
      onMainStep($, result.usage ? result.usage.input_tokens + result.usage.cache_read_input_tokens + result.usage.cache_creation_input_tokens : null),
    )
    return result
  })
}
