import type { Phase } from "../domain/workflow";
import type { RunEvent } from "./events";
import type { PhaseMeta, RunMeta, RunStore } from "./run-store";

export interface PhaseRecorderContext {
  readonly runId: string;
  readonly meta: RunMeta;
  readonly runStore: RunStore;
  readonly emit: (event: RunEvent) => void;
}

export class PhaseRecorder {
  constructor(private readonly ctx: PhaseRecorderContext) {}

  async recordRunResult(phaseMeta: PhaseMeta): Promise<void> {
    this.ctx.meta.phases.push(phaseMeta);
    await this.write();
  }

  async write(): Promise<void> {
    await this.ctx.runStore.writeMeta(this.ctx.meta);
  }

  async recordPreRuntimeFailure(phase: Phase, iteration: number, error: string): Promise<void> {
    const now = new Date().toISOString();
    this.ctx.meta.phases.push({
      phaseId: phase.id,
      iteration,
      startedAt: now,
      completedAt: now,
      status: "failed",
      error,
    });
    await this.write();
    this.emitFailure(phase, iteration, error);
  }

  async recordPostRuntimeFailure(
    phase: Phase,
    phaseMeta: PhaseMeta,
    iteration: number,
    error: string,
  ): Promise<void> {
    phaseMeta.status = "failed";
    phaseMeta.error = error;
    await this.write();
    this.emitFailure(phase, iteration, error);
  }

  private emitFailure(phase: Phase, iteration: number, error: string): void {
    this.ctx.emit({
      type: "phase.failed",
      runId: this.ctx.runId,
      phaseId: phase.id,
      iteration,
      error,
    });
  }
}
