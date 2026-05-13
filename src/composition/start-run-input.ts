import type { GateResolver } from "../gates/dispatch";
import type { RunEvent } from "../orchestrator/events";

export interface StartRunInput {
  readonly task: string;
  readonly slug: string;
  readonly projectName?: string;
  readonly repoPath?: string;
  readonly tier?: "S" | "M" | "L";
  readonly onEvent?: (event: RunEvent) => void;
  /**
   * Resolves a `Gate` for the workflow's gate kinds. CLI passes a
   * resolver wrapping an OpenTUI prompter; eval/CI callers pass a
   * resolver wrapping `AutoApprovePrompter`. When omitted, the harness
   * uses the session's deferred prompter so out-of-band callers (HTTP,
   * MCP) can resolve gates via `RunSession.resolveGate`.
   */
  readonly gateResolver?: GateResolver;
  /** Begin at this phase; earlier phases are skipped. */
  readonly startAt?: string;
  /** Run only these phases (in workflow order). Overrides startAt. */
  readonly onlyPhases?: readonly string[];
  readonly abortSignal?: AbortSignal;
}
