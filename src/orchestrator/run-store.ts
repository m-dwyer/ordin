import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Per-run metadata persistence. Files:
 *
 *   ~/.ordin/runs/<run-id>/
 *     meta.json          — RunMeta (created / updated as phases run)
 *     <phaseId>.jsonl    — transcripts (written by ClaudeCliRuntime)
 *
 * `git log` is the deliverable ledger. `meta.json` is the harness's
 * internal record for `harness retro` and `harness runs`.
 */
export interface RunMeta {
  runId: string;
  workflow: string;
  tier: "S" | "M" | "L";
  task: string;
  slug: string;
  repo: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "halted";
  phases: PhaseMeta[];
}

export interface PhaseMeta {
  phaseId: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed" | "rejected";
  iteration: number;
  runtime: string;
  model: string;
  tokens?: {
    input: number;
    output: number;
    cacheReadInput: number;
    cacheCreationInput: number;
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
