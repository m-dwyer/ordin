import { isKnownToolName, knownToolNames } from "../domain/tool-authority";
import { ToolPolicy } from "../domain/tool-policy";
import type {
  ApprovalResult,
  BrokerClient,
  RecordedResult,
  ToolError,
  ToolIntent,
} from "./client/types";

/**
 * Policy + audit for tool dispatch (ADR-016). The broker is a gate,
 * not an executor: it grants or denies an intent, then later records
 * the worker-reported outcome. Tool executors live worker-side
 * (`src/worker/tools/*`), so under `--sandbox srt` the kernel sandbox
 * confines what actually runs.
 *
 * Per-(runId, phaseId) ACLs are registered by the harness before the
 * worker begins a phase and released after. The intent the worker
 * sends carries no ACL hint — a compromised runtime cannot widen its
 * own permissions because the authoritative list lives parent-side.
 *
 * Pipeline (Phase B-bis; pattern scanner inserted in Phase C):
 *
 *   `requestApproval(intent)`:
 *     1. ACL — tool name must appear in the registered phase ACL.
 *        Unknown tool names also reject here. An unregistered phase
 *        rejects every intent (loud failure for harness wiring bugs).
 *     2. Audit — append `broker.tool.dispatch` envelope (intent +
 *        decision). Scanner-deny will land in this same envelope once
 *        Phase C ships.
 *     3. Return approval (or typed deny).
 *
 *   `recordResult(intent, recorded)`:
 *     1. Audit — append `broker.tool.result` envelope (ok / error,
 *        durationMs).
 *
 * The audit-chain prefix `broker.tool.*` keeps these envelopes out of
 * the TUI fan-out (`AuditService.onEvent` filters `broker.*`).
 */

export interface DispatchAuditSink {
  append(event: {
    runId: string;
    kind: string;
    payload: Record<string, unknown>;
  }): Promise<void> | void;
}

export interface BrokerDispatchOptions {
  readonly audit: DispatchAuditSink;
}

export class BrokerDispatch implements BrokerClient {
  private readonly audit: DispatchAuditSink;
  private readonly acls = new Map<string, ToolPolicy>();

  constructor(opts: BrokerDispatchOptions) {
    this.audit = opts.audit;
  }

  /**
   * Record the authoritative ACL for a phase. The harness calls this
   * once before dispatching the phase and `releasePhase` once it
   * finishes (success or failure). The worker has no way to register
   * its own ACL — that is the whole point of moving the state
   * parent-side.
   */
  registerPhase(runId: string, phaseId: string, policy: ToolPolicy | readonly string[]): void {
    this.acls.set(
      aclKey(runId, phaseId),
      policy instanceof ToolPolicy
        ? policy
        : ToolPolicy.from({ allowedTools: policy, hasSkills: false, cwd: "" }),
    );
  }

  releasePhase(runId: string, phaseId: string): void {
    this.acls.delete(aclKey(runId, phaseId));
  }

  async requestApproval(intent: ToolIntent): Promise<ApprovalResult> {
    const aclError = this.checkAcl(intent);
    if (aclError) {
      await this.appendDispatch(intent, "deny", aclError);
      return { ok: false, error: aclError };
    }
    await this.appendDispatch(intent, "allow");
    return { ok: true };
  }

  async recordResult(intent: ToolIntent, recorded: RecordedResult): Promise<void> {
    await this.audit.append({
      runId: intent.runId,
      kind: "broker.tool.result",
      payload: {
        tool: intent.tool,
        phaseId: intent.phaseId,
        ok: recorded.result.ok,
        durationMs: recorded.durationMs,
        ...(recorded.result.ok
          ? {}
          : {
              errorKind: recorded.result.error.kind,
              errorMessage: recorded.result.error.message,
            }),
      },
    });
  }

  private checkAcl(intent: ToolIntent): ToolError | undefined {
    if (!isKnownToolName(intent.tool)) {
      return {
        kind: "unknown_tool",
        message: `Unknown tool "${intent.tool}". Known: ${knownToolNames().join(", ")}.`,
      };
    }
    const policy = this.acls.get(aclKey(intent.runId, intent.phaseId));
    if (!policy) {
      return {
        kind: "denied",
        message: `No ACL registered for phase "${intent.phaseId}" of run "${intent.runId}".`,
      };
    }
    const decision = policy.decide({ tool: intent.tool, input: intent.input });
    if (decision.ok) return undefined;
    return { kind: "denied", message: decision.message };
  }

  private async appendDispatch(
    intent: ToolIntent,
    decision: "allow" | "deny",
    error?: ToolError,
  ): Promise<void> {
    await this.audit.append({
      runId: intent.runId,
      kind: "broker.tool.dispatch",
      payload: {
        tool: intent.tool,
        phaseId: intent.phaseId,
        input: intent.input,
        decision,
        ...(error ? { errorKind: error.kind, errorMessage: error.message } : {}),
      },
    });
  }
}

function aclKey(runId: string, phaseId: string): string {
  return `${runId}\0${phaseId}`;
}
