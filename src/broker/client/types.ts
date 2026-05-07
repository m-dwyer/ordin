import type { Skill } from "../../domain/skill";

/**
 * Tool dispatch surface, per ADR-016 / ADR-018. The broker is policy +
 * audit only; the worker holds the executors and runs them inside its
 * own trust domain (kernel-sandboxed under `--sandbox srt`).
 *
 * Each tool call is two legs:
 *
 *   1. `requestApproval(intent)` — broker checks ACL, runs the
 *      pattern scanner (ADR-012, when it lands), and writes the
 *      `broker.tool.dispatch` audit envelope. Returns approved or a
 *      typed deny.
 *   2. `recordResult(intent, result)` — worker reports the outcome
 *      after executing locally; broker writes the
 *      `broker.tool.result` audit envelope.
 *
 * Two transport implementations:
 *   - `InProcessBrokerClient` — direct method calls into
 *     `BrokerDispatch`. Used by `--sandbox passthrough` (no kernel
 *     sandbox; the scanner is the primary defense).
 *   - `HttpBrokerClient` — localhost HTTP through the broker's `tools`
 *     internal service. Used by `--sandbox srt`; the agent (worker
 *     subprocess) executes inside the kernel sandbox.
 *
 * The contract test pins audit envelopes identical across transports.
 */

export interface ToolIntent {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  readonly runId: string;
  readonly phaseId: string;
  /** Workspace cwd for the executing phase. Path normalization is
   *  resolved relative to this. */
  readonly cwd: string;
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

/**
 * Approval response from the broker. `ok: true` means the worker may
 * execute; `ok: false` means the broker rejected the intent (ACL,
 * scanner) and the worker must surface the error without running
 * anything.
 */
export type ApprovalResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ToolError };

/**
 * Worker-reported outcome the broker writes into the audit chain.
 * Mirrors `ToolResult` plus the duration the worker observed.
 */
export interface RecordedResult {
  readonly result: ToolResult;
  readonly durationMs: number;
}

export interface BrokerClient {
  requestApproval(intent: ToolIntent): Promise<ApprovalResult>;
  recordResult(intent: ToolIntent, recorded: RecordedResult): Promise<void>;
}
