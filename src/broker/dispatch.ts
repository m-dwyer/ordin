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
 * Pipeline (Phase B-bis; pattern scanner inserted in Phase C):
 *
 *   `requestApproval(intent)`:
 *     1. ACL — tool name must appear in the phase's `allowed_tools`.
 *        Unknown tool names also reject here.
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

export const KNOWN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Skill"] as const;
export type KnownTool = (typeof KNOWN_TOOLS)[number];

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

  constructor(opts: BrokerDispatchOptions) {
    this.audit = opts.audit;
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
    if (!(KNOWN_TOOLS as readonly string[]).includes(intent.tool)) {
      return {
        kind: "unknown_tool",
        message: `Unknown tool "${intent.tool}". Known: ${KNOWN_TOOLS.join(", ")}.`,
      };
    }
    if (!intent.allowedTools.includes(intent.tool)) {
      return {
        kind: "denied",
        message: `Tool "${intent.tool}" is not in this phase's allowed_tools.`,
      };
    }
    return undefined;
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
