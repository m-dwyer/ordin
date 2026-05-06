import type { Skill } from "../../domain/skill";

/**
 * Tool dispatch surface, per ADR-016 / ADR-018. Runtimes emit a
 * `ToolIntent` and receive a `ToolResult`; the broker enforces ACL,
 * (later) the pattern scanner, and audit-chain bookkeeping.
 *
 * Two implementations:
 *   - `InProcessBrokerClient` (Phase A): default `--sandbox passthrough`.
 *     Direct method calls into `BrokerDispatch`. Trust boundary is
 *     logical (code discipline, no kernel separation).
 *   - `HttpBrokerClient` (Phase B): worker is a separate process,
 *     dispatch travels over localhost HTTP through the broker.
 *
 * The interface is identical for both; tests pin behaviour via a shared
 * contract test (Phase B) so audit envelopes never diverge by transport.
 */

export interface ToolIntent {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly runId: string;
  readonly phaseId: string;
  /** Workspace cwd for the executing phase. Path normalization is
   *  resolved relative to this. */
  readonly cwd: string;
  /** Per-phase ACL list. The broker rejects tools not present here. */
  readonly allowedTools: readonly string[];
  /** Skills available to the phase; consumed only by the `Skill` tool. */
  readonly skills: readonly Skill[];
}

export type ToolErrorKind = "denied" | "unknown_tool" | "input" | "executor";

export interface ToolError {
  readonly kind: ToolErrorKind;
  readonly message: string;
}

export type ToolResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly error: ToolError };

export interface BrokerClient {
  dispatchTool(intent: ToolIntent): Promise<ToolResult>;
}
