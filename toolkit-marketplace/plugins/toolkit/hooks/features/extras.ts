// Extras: the "done" notification for long turns, and the big-read warning.
import type { EngineInterface, On } from 'claude-code'

import type { ToolInput } from './bus'
import type { AgentSpawnInput, AgentSpawnResult, ToolCallResult, TurnCompleteInput } from 'claude-code'
import { basename } from './paths'
import { getSettings, guard, isOn, log } from './settings'
import { fmtDuration, fmtTokens } from './ui'
import { notify } from './windows'

/** About 4 characters per token. */
export const estimateTokens = (bytes: number): number => Math.round(bytes / 4)

export const countLines = (text: string): number => (text.length === 0 ? 0 : text.split(/\r?\n/).length)

export const isBigRead = (tokens: number, lines: number | null, s: { bigReadTokens: number; bigReadLines: number }): boolean =>
  tokens > s.bigReadTokens || (lines !== null && lines >= s.bigReadLines)

export const PART_ONLY = 'Only the needed part'
export const READ_ALL = 'Read all'

export const partOnlyDenial = (file: string): string =>
  `The person chose to read only the needed part of ${basename(file)}. Use Grep to find the relevant lines, then Read with offset and limit.`

async function sizeOf($: EngineInterface, file: string): Promise<{ tokens: number; lines: number | null } | null> {
  try {
    const st = await $.fs.stat(file)
    if (st.kind !== 'file') return null
    let lines: number | null = null
    if (st.size > 40_000 && st.size <= 4 * 1024 * 1024) lines = countLines(String(await $.fs.read(file)))
    return { tokens: estimateTokens(st.size), lines }
  } catch {
    return null
  }
}

export async function extrasTurnComplete($: EngineInterface, e: TurnCompleteInput): Promise<void> {
  if (e.agentId !== undefined || e.isAborted) return
  const s = await getSettings($)
  if (s.features.doneNotify && e.durationMs > s.doneNotifySec * 1000) {
    void notify($, 'Claude finished', `Done after ${fmtDuration(e.durationMs)}.`)
  }
}

export const registerExtras = (on: On): void => {
  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const ask = await guard($, 'big-read', async () => {
      const input = e as unknown as Record<string, unknown>
      if (input.agentId !== undefined || input.offset !== undefined || input.limit !== undefined) return null
      if (!(await isOn($, 'bigRead'))) return null
      const file = String(input.file_path ?? '')
      if (!file || /\.(png|jpe?g|gif|webp|pdf|ipynb)$/i.test(file)) return null
      const size = await sizeOf($, file)
      if (!size || !isBigRead(size.tokens, size.lines, await getSettings($))) return null
      const answer = await $.ui.ask(
        `${basename(file)} is about ${fmtTokens(size.tokens)} tokens${size.lines !== null ? ` (${size.lines} lines)` : ''}. Read it all?`,
        { options: [READ_ALL, PART_ONLY], header: 'Big read' },
      )
      void log($, 'big-read', `${basename(file)}: ${answer}`)
      return answer === PART_ONLY ? partOnlyDenial(file) : null
    })
    return typeof ask === 'string' ? { deny: ask } : next(e)
  }).catch(($, e, next) => next(e))
}
