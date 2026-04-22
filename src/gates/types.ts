/**
 * Gate contract. Gates run at phase boundaries; they decide whether to
 * proceed, iterate, or halt based on the artefacts just produced.
 *
 * Stage 1 uses ClackGate for human review; FileGate and AutoGate exist
 * as signposts for CI/auto workflows.
 */
export interface Gate {
  readonly kind: string;
  request(ctx: GateContext): Promise<GateDecision>;
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
