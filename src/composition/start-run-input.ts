import type { Phase } from "../domain/workflow";
import type { Gate } from "../gates/types";
import type { RunEvent } from "../orchestrator/events";

export interface StartRunInput {
  readonly task: string;
  readonly slug: string;
  readonly projectName?: string;
  readonly repoPath?: string;
  readonly tier?: "S" | "M" | "L";
  readonly onEvent?: (event: RunEvent) => void;
  /**
   * Resolve a `Gate` for the given workflow gate kind. CLI passes a
   * clack-backed `HumanGate`; eval/CI callers pass `() => new AutoGate()`.
   * When omitted, the harness uses the session's deferred prompter so
   * out-of-band callers (HTTP, MCP) can resolve gates via
   * `RunSession.resolveGate`.
   */
  readonly gateForKind?: (kind: Phase["gate"]) => Gate;
  /** Begin at this phase; earlier phases are skipped. */
  readonly startAt?: string;
  /** Run only these phases (in workflow order). Overrides startAt. */
  readonly onlyPhases?: readonly string[];
  readonly abortSignal?: AbortSignal;
}
