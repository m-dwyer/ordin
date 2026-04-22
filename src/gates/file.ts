import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Gate, GateContext, GateDecision } from "./types";

/**
 * Waits for a marker file. If `<cwd>/.ordin/gates/<phaseId>.approved`
 * appears the gate approves; `.rejected` rejects (with file contents as
 * reason). Polls at a steady interval.
 *
 * Trigger for use: async or cross-machine gate flows. Not a Stage 1 default;
 * kept small so the signpost is clear for later wiring.
 */
export interface FileGateConfig {
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export class FileGate implements Gate {
  readonly kind = "file";
  private readonly pollIntervalMs: number;
  private readonly timeoutMs?: number;

  constructor(config: FileGateConfig = {}) {
    this.pollIntervalMs = config.pollIntervalMs ?? 5_000;
    this.timeoutMs = config.timeoutMs;
  }

  async request(ctx: GateContext): Promise<GateDecision> {
    const dir = join(ctx.cwd, ".ordin", "gates");
    const approvedAt = join(dir, `${ctx.phaseId}.approved`);
    const rejectedAt = join(dir, `${ctx.phaseId}.rejected`);
    const deadline = this.timeoutMs ? Date.now() + this.timeoutMs : undefined;

    while (true) {
      if (await exists(approvedAt)) {
        const note = (await safeRead(approvedAt)).trim();
        return note ? { status: "approved", note } : { status: "approved" };
      }
      if (await exists(rejectedAt)) {
        const reason = (await safeRead(rejectedAt)).trim() || "rejected by marker file";
        return { status: "rejected", reason };
      }
      if (deadline && Date.now() > deadline) {
        return { status: "rejected", reason: "FileGate timed out waiting for marker" };
      }
      await sleep(this.pollIntervalMs);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function safeRead(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
