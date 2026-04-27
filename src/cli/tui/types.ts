/**
 * Pure types shared between the TUI controller, the Solid run-app
 * component, and the CLI session factory. No runtime imports here —
 * this file must stay free of OpenTUI / Solid value imports so that
 * cold paths (tests, --help, the doctor command) can reference the
 * types without pulling in the renderer's native bits.
 */
import type { Accessor } from "solid-js";
import type { GateContext, GateDecision } from "../../gates/types";

export interface RunHeader {
  task: string;
  slug: string;
  tier: string;
}

export interface PhaseRow {
  id: string;
  status: "pending" | "running" | "gate" | "done" | "failed";
  model?: string;
  iteration: number;
  activity?: string;
  durationMs?: number;
  tokensOut?: number;
}

export interface GateState {
  ctx: GateContext;
}

export interface ControllerState {
  phases: () => readonly PhaseRow[];
  gate: Accessor<GateState | null>;
  hint: Accessor<string>;
  decideGate: (decision: GateDecision) => void;
}
