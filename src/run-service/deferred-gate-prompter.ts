import type { GateContext, GateDecision, GatePrompter } from "../gates/types";

/**
 * Prompter that pauses on `prompt()` and only resolves when an external
 * caller decides the gate via `resolve(runId, phaseId, decision)`. Used
 * by RunService to bridge the synchronous gate-loop in the engine with
 * the asynchronous, request/response shape of HTTP/MCP clients.
 */
export interface PendingGate {
  readonly runId: string;
  readonly phaseId: string;
  readonly cwd: string;
  readonly artefacts: readonly { readonly label: string; readonly path: string }[];
  readonly summary?: string;
}

interface PendingEntry {
  readonly ctx: GateContext;
  readonly resolve: (decision: GateDecision) => void;
  readonly reject: (err: Error) => void;
}

export class DeferredGatePrompter implements GatePrompter {
  private readonly pending = new Map<string, Map<string, PendingEntry>>();

  prompt(ctx: GateContext): Promise<GateDecision> {
    return new Promise<GateDecision>((resolve, reject) => {
      const phases = this.pending.get(ctx.runId) ?? new Map<string, PendingEntry>();
      phases.set(ctx.phaseId, { ctx, resolve, reject });
      this.pending.set(ctx.runId, phases);
    });
  }

  resolve(runId: string, phaseId: string, decision: GateDecision): boolean {
    const phases = this.pending.get(runId);
    const entry = phases?.get(phaseId);
    if (!entry || !phases) return false;
    phases.delete(phaseId);
    if (phases.size === 0) this.pending.delete(runId);
    entry.resolve(decision);
    return true;
  }

  rejectRun(runId: string, reason: string): void {
    const phases = this.pending.get(runId);
    if (!phases) return;
    for (const entry of phases.values()) entry.reject(new Error(reason));
    this.pending.delete(runId);
  }

  listFor(runId: string): readonly PendingGate[] {
    const phases = this.pending.get(runId);
    if (!phases) return [];
    return Array.from(phases.values()).map(({ ctx }) => ({
      runId: ctx.runId,
      phaseId: ctx.phaseId,
      cwd: ctx.cwd,
      artefacts: ctx.artefacts,
      ...(ctx.summary !== undefined ? { summary: ctx.summary } : {}),
    }));
  }
}
