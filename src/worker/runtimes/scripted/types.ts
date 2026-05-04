/**
 * Type-only module — broken out from `index.ts` to avoid a circular
 * import with `loader.ts` (the runtime imports the loader; the loader
 * needs the plan type).
 */

export interface ScriptedToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface ScriptedStep {
  readonly text?: string;
  readonly thinking?: boolean;
  readonly tool?: ScriptedToolCall;
}

/** Sequence of scripted steps for a single phase. */
export interface ScriptedPhase {
  readonly steps: readonly ScriptedStep[];
}

/** A scripted-runtime plan: per-phase scripts keyed by `Phase.id`. */
export type ScriptedPlan = ReadonlyMap<string, ScriptedPhase>;
