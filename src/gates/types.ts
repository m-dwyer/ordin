/**
 * Gate contract. Gates run at phase boundaries; they decide whether to
 * proceed, iterate, or halt based on the artefacts just produced.
 *
 * Gates are pure business logic — no UI imports here. `HumanGate`
 * delegates to a `GatePrompter` the caller injects; CLI / web / Slack /
 * HTTP clients each ship their own prompter implementation.
 */
export interface Gate {
  readonly kind: string;
  request(ctx: GateContext): Promise<GateDecision>;
}

/**
 * Collects a decision from a human reviewer. Client-interface layers
 * (CLI, HTTP, Slack …) implement this to present the gate however their
 * transport calls for.
 */
export interface GatePrompter {
  prompt(ctx: GateContext): Promise<GateDecision>;
}

export interface GateContext {
  readonly runId: string;
  readonly phaseId: string;
  readonly cwd: string;
  /** Artefacts the phase declared as outputs (paths relative to cwd). */
  readonly artefacts: readonly GateArtefact[];
  /**
   * Short, human-readable summary of what happened (token usage, duration,
   * tool counts). Shown before the prompt so the reviewer doesn't have to
   * hunt for the numbers.
   */
  readonly summary?: string;
}

export interface GateArtefact {
  readonly label: string;
  readonly path: string;
}

export type GateDecision =
  | { readonly status: "approved"; readonly note?: string }
  | { readonly status: "rejected"; readonly reason: string };
