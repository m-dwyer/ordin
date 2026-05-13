import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Per-run metadata persistence. Files:
 *
 *   ~/.ordin/runs/<run-id>/
 *     meta.json          — RunMeta (created / updated as phases run)
 *     <phaseId>.jsonl    — per-phase runtime transcript (events + protocol frames)
 *
 * `git log` is the deliverable ledger. `meta.json` is the harness's
 * internal record for `harness retro` and `harness runs`.
 */
export interface RunMeta {
  runId: string;
  workflow: string;
  /** Bundle that produced this run; the hash pins the exact loaded content. */
  bundle: { name: string; version: string; hash: string };
  tier: "S" | "M" | "L";
  task: string;
  slug: string;
  repo: string;
  sandboxMode?: "passthrough" | "broker" | "srt";
  phaseSlicing?: {
    onlyPhases?: string[];
    startAt?: string;
  };
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "halted";
  phases: PhaseMeta[];
  /**
   * Marker written before a phase invocation begins and cleared once
   * the phase produces a terminal `PhaseMeta` (success / fail / reject).
   * If the parent process dies mid-phase, this is the only on-disk
   * record of which phase was in flight — the resume planner (Step 2.4+
   * follow-up) reads this to know where to re-enter. Null between phases
   * and once the run terminates.
   */
  inFlight: InFlightPhase | null;
  /**
   * Phase id the engine currently considers active. Distinct from
   * `inFlight` (which only spans the invocation window): `currentPhaseId`
   * spans the whole transaction, including preflight + postflight + gate.
   * Reserved for the resume planner; written null today.
   */
  currentPhaseId: string | null;
  /**
   * Gate request awaiting an out-of-band decision when the engine
   * yields. Reserved for the resume planner (Step 2.5 flips gates to
   * an event-and-resume contract); written null today.
   */
  pendingGate: PendingGateMarker | null;
}

export interface InFlightPhase {
  phaseId: string;
  iteration: number;
  startedAt: string;
}

export interface PendingGateMarker {
  phaseId: string;
  gateKind: string;
  requestedAt: string;
}

export interface PhaseMeta {
  phaseId: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "rejected";
  iteration: number;
  /** Filled once the phase reaches the runtime. Absent when a phase
   * fails before invocation (e.g. missing input artefacts). */
  runtime?: string;
  model?: string;
  tokens?: {
    input: number;
    output: number;
    cacheReadInput: number;
    cacheCreationInput: number;
    totalInput: number;
  };
  durationMs?: number;
  exitCode?: number;
  gateDecision?: "approved" | "rejected" | "auto";
  gateNote?: string;
  transcriptPath?: string;
  error?: string;
}

export class RunStore {
  constructor(private readonly baseDir: string) {}

  runDir(runId: string): string {
    return join(this.baseDir, runId);
  }

  async ensureRunDir(runId: string): Promise<string> {
    const dir = this.runDir(runId);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async writeMeta(meta: RunMeta): Promise<void> {
    await this.ensureRunDir(meta.runId);
    await writeFile(
      join(this.runDir(meta.runId), "meta.json"),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf8",
    );
  }

  async readMeta(runId: string): Promise<RunMeta> {
    const raw = await readFile(join(this.runDir(runId), "meta.json"), "utf8");
    return JSON.parse(raw) as RunMeta;
  }

  async listRuns(): Promise<RunMeta[]> {
    let entries: string[];
    try {
      entries = await readdir(this.baseDir);
    } catch {
      return [];
    }
    const metas: RunMeta[] = [];
    for (const id of entries) {
      try {
        metas.push(await this.readMeta(id));
      } catch {
        // Skip runs without meta.json (e.g. partial writes).
      }
    }
    metas.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return metas;
  }
}

export function generateRunId(slug: string, now: Date = new Date()): string {
  const ts = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  return `${ts}_${slug}`;
}

/**
 * Fields the caller picks out of its context to seed a new RunMeta.
 * Initial-state defaults (status, phases, resume markers, startedAt)
 * are filled in by `createInitialRunMeta` — adding a new reserved
 * field on RunMeta only requires touching the factory.
 */
export interface InitialRunMetaInput {
  readonly runId: string;
  readonly workflow: string;
  readonly bundle: { readonly name: string; readonly version: string; readonly hash: string };
  readonly tier: "S" | "M" | "L";
  readonly task: string;
  readonly slug: string;
  readonly repo: string;
  readonly sandboxMode?: "passthrough" | "broker" | "srt";
  readonly onlyPhases?: readonly string[];
  readonly startAt?: string;
}

/** Construct a fresh RunMeta in the "running" initial state. */
export function createInitialRunMeta(input: InitialRunMetaInput): RunMeta {
  return {
    runId: input.runId,
    workflow: input.workflow,
    bundle: { ...input.bundle },
    tier: input.tier,
    task: input.task,
    slug: input.slug,
    repo: input.repo,
    ...(input.sandboxMode ? { sandboxMode: input.sandboxMode } : {}),
    ...(input.onlyPhases || input.startAt
      ? {
          phaseSlicing: {
            ...(input.onlyPhases ? { onlyPhases: [...input.onlyPhases] } : {}),
            ...(input.startAt ? { startAt: input.startAt } : {}),
          },
        }
      : {}),
    startedAt: new Date().toISOString(),
    status: "running",
    phases: [],
    inFlight: null,
    currentPhaseId: null,
    pendingGate: null,
  };
}
