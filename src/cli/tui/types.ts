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
  workflow?: string;
  project?: string;
  repoPath?: string;
  runId?: string;
}

export type PhaseStatus = "pending" | "running" | "gate" | "done" | "failed";

export interface PhaseRow {
  id: string;
  status: PhaseStatus;
  model?: string;
  iteration: number;
  activity?: string;
  startedAt?: number;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  error?: string;
}

export interface GateState {
  ctx: GateContext;
}

export type FeedRowKind = "tool" | "result" | "note" | "error" | "edit";

export interface EditDiff {
  filePath: string;
  diff: string;
  filetype?: string;
  truncated: boolean;
}

export interface FeedRow {
  readonly id: number;
  readonly kind: FeedRowKind;
  readonly tool?: string;
  readonly detail?: string;
  readonly extra?: string;
  readonly edit?: EditDiff;
}

export interface PhaseSection {
  readonly key: string;
  readonly phaseId: string;
  status: PhaseStatus;
  model?: string;
  iteration: number;
  rows: FeedRow[];
  startedAt?: number;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  error?: string;
  gate?: GateState;
}

export interface ControllerState {
  header: Accessor<RunHeader | null>;
  phases: () => readonly PhaseRow[];
  sections: () => readonly PhaseSection[];
  gate: Accessor<GateState | null>;
  hint: Accessor<string>;
  decideGate: (decision: GateDecision) => void;
}
