// Shared input type for the tool-call handlers register.tsx calls in order.
// (The engine allows one unmatched hook per event per plugin, so register.tsx owns each shared event.)

export type ToolInput = Readonly<Record<string, unknown>> & { readonly tool: string; readonly agentId?: string }
