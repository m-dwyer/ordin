import type { ArtefactPointer, Feedback } from "../domain/composer";
import type { Phase } from "../domain/workflow";
import type { InvokeResult } from "../runtimes/types";
import type { EngineRunInput } from "./engine";
import type { RunEvent } from "./events";
import { summariseInvocation } from "./phase-runner";
import type { PhaseMeta } from "./run-store";

export interface GateCoordinatorContext {
  readonly runId: string;
  readonly input: EngineRunInput;
  readonly emit: (event: RunEvent) => void;
}

export interface GatePhaseDecision {
  readonly approved: boolean;
  readonly feedback?: Feedback;
  readonly outcome?: "halted";
}

export class GateCoordinator {
  constructor(private readonly ctx: GateCoordinatorContext) {}

  async decide(
    phase: Phase,
    phaseMeta: PhaseMeta,
    invokeResult: InvokeResult,
    outputs: readonly ArtefactPointer[],
  ): Promise<GatePhaseDecision> {
    this.ctx.emit({ type: "gate.requested", runId: this.ctx.runId, phaseId: phase.id });
    const decision = await this.ctx.input.onGateRequested({
      runId: this.ctx.runId,
      phaseId: phase.id,
      gateKind: phase.gate,
      cwd: this.ctx.input.workspaceRoot,
      artefacts: outputs,
      summary: summariseInvocation(invokeResult),
    });

    if (decision.status === "approved") {
      phaseMeta.status = "completed";
      phaseMeta.gateDecision = phase.gate === "auto" ? "auto" : "approved";
      if (decision.note) phaseMeta.gateNote = decision.note;
      this.ctx.emit({
        type: "gate.decided",
        runId: this.ctx.runId,
        phaseId: phase.id,
        decision: phaseMeta.gateDecision,
        ...(decision.note ? { note: decision.note } : {}),
      });
      this.ctx.emit({
        type: "phase.completed",
        runId: this.ctx.runId,
        phaseId: phase.id,
        iteration: phaseMeta.iteration,
        tokens: invokeResult.tokens,
        durationMs: invokeResult.durationMs,
      });
      return { approved: true };
    }

    phaseMeta.status = "rejected";
    phaseMeta.gateDecision = "rejected";
    phaseMeta.gateNote = decision.reason;
    this.ctx.emit({
      type: "gate.decided",
      runId: this.ctx.runId,
      phaseId: phase.id,
      decision: "rejected",
      reason: decision.reason,
    });

    if (!phase.on_reject) {
      return { approved: false, outcome: "halted" };
    }

    return {
      approved: false,
      feedback: {
        fromPhase: phase.id,
        decision: "rejected",
        ...(decision.reason ? { reason: decision.reason } : {}),
      },
    };
  }
}
