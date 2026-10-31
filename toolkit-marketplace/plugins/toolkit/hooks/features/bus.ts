// The engine allows one unmatched hook per event per plugin, so register.tsx owns each shared
// event and calls every feature's handlers in a fixed order, each inside its own guard().
import type { AgentSpawnInput, AgentSpawnResult, EngineInterface, ToolCallResult, TurnCompleteInput } from 'claude-code'

export type ToolInput = Readonly<Record<string, unknown>> & { readonly tool: string; readonly agentId?: string }

export type Handlers = {
  /** Feature name for logs. */
  name: string
  sessionStart?: ($: EngineInterface) => Promise<void>
  turnStart?: ($: EngineInterface, agentId: string | undefined) => Promise<void>
  turnComplete?: ($: EngineInterface, e: TurnCompleteInput) => Promise<void>
  /** Before a tool runs. */
  toolPre?: ($: EngineInterface, tool: string, input: ToolInput) => Promise<void>
  /** After a tool ran; may return short context lines for the model. */
  toolPost?: ($: EngineInterface, tool: string, input: ToolInput, ran: ToolCallResult) => Promise<string[] | void>
  /** Before an agent spawns; may name the model. */
  spawnModel?: ($: EngineInterface, e: AgentSpawnInput) => Promise<string | null>
  spawned?: ($: EngineInterface, e: AgentSpawnInput, r: AgentSpawnResult) => Promise<void>
}
