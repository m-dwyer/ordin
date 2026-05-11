import { isAbsolute, relative } from "node:path";
import { deriveToolPolicy, type ToolPolicy } from "./client/tool-authority";
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
      isToolPolicy(policy)
        ? policy
        : deriveToolPolicy({ allowedTools: policy, hasSkills: false, cwd: "" }),
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
    if (!(KNOWN_TOOLS as readonly string[]).includes(intent.tool)) {
      return {
        kind: "unknown_tool",
        message: `Unknown tool "${intent.tool}". Known: ${KNOWN_TOOLS.join(", ")}.`,
      };
    }
    const acl = this.acls.get(aclKey(intent.runId, intent.phaseId));
    if (!acl) {
      return {
        kind: "denied",
        message: `No ACL registered for phase "${intent.phaseId}" of run "${intent.runId}".`,
      };
    }
    if (!acl.toolNames.includes(intent.tool)) {
      return {
        kind: "denied",
        message: `Tool "${intent.tool}" is not in this phase's allowed_tools.`,
      };
    }
    const patternError = checkPatternAcl(acl, intent);
    if (patternError) return patternError;
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

function aclKey(runId: string, phaseId: string): string {
  return `${runId}\0${phaseId}`;
}

function isToolPolicy(value: ToolPolicy | readonly string[]): value is ToolPolicy {
  return "specs" in value && "toolNames" in value;
}

function checkPatternAcl(policy: ToolPolicy, intent: ToolIntent): ToolError | undefined {
  const specs = policy.specs.filter((spec) => spec.name === intent.tool);
  if (specs.length === 0) return undefined;
  if (specs.some((spec) => !spec.pattern)) return undefined;

  const rawValue = patternValue(intent);
  if (rawValue === undefined) {
    return {
      kind: "denied",
      message: `Tool "${intent.tool}" requires a pattern match, but its input has no matchable field.`,
    };
  }
  const value = normalizeForMatch(intent.tool, rawValue, policy.cwd);
  if (specs.some((spec) => spec.pattern && globMatches(spec.pattern, value))) {
    return undefined;
  }
  return {
    kind: "denied",
    message: `Tool "${intent.tool}" input "${rawValue}" does not match this phase's allowed_tools patterns.`,
  };
}

/**
 * Resolve absolute filesystem inputs against the phase cwd so that
 * relative allowed_tools patterns (`Write(docs/rfcs/*)`) match the
 * absolute paths Claude's tool surface emits. Path-bearing tools only;
 * Bash command / Glob pattern / Skill name aren't filesystem paths.
 */
function normalizeForMatch(tool: string, value: string, cwd: string): string {
  if (!cwd || !isAbsolute(value)) return value;
  if (tool !== "Read" && tool !== "Write" && tool !== "Edit" && tool !== "Grep") return value;
  return relative(cwd, value);
}

function patternValue(intent: ToolIntent): string | undefined {
  switch (intent.tool) {
    case "Bash":
      return stringField(intent.input, "command");
    case "Read":
    case "Write":
    case "Edit":
      return stringField(intent.input, "file_path");
    case "Grep":
      return stringField(intent.input, "path");
    case "Glob":
      return stringField(intent.input, "pattern");
    case "Skill":
      return stringField(intent.input, "name");
    default:
      return undefined;
  }
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function globMatches(pattern: string, value: string): boolean {
  return globRegex(pattern).test(value);
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
