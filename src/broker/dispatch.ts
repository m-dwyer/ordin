import { isAbsolute, relative } from "node:path";
import type { BrokerClient, ToolError, ToolIntent, ToolResult } from "./client/types";
import { type BashInput, executeBash } from "./tools/bash";
import { type EditInput, executeEdit } from "./tools/edit";
import { executeGlob, type GlobInput } from "./tools/glob";
import { executeGrep, type GrepInput } from "./tools/grep";
import { executeRead, type ReadInput } from "./tools/read";
import { executeSkill, type SkillInput } from "./tools/skill";
import { executeWrite, type WriteInput } from "./tools/write";

/**
 * Single dispatch point for tool execution (ADR-016). Runs in the
 * broker's address space (parent process for `InProcessBrokerClient`,
 * future broker server for `HttpBrokerClient`). Pipeline:
 *
 *   1. ACL — tool name must appear in the phase's `allowed_tools`.
 *      Unknown names also reject here.
 *   2. Audit — append a `broker.tool.dispatch` envelope describing the
 *      attempt and the decision (allow/deny). Denials end here.
 *   3. Input normalization — file-path tools coerce absolute paths
 *      inside `cwd` to workspace-relative form (defense against tools
 *      that paste back paths from prior turns).
 *   4. Executor — invoke the per-tool implementation in `tools/*`.
 *   5. Audit — append a `broker.tool.result` envelope (ok/error,
 *      duration). Result content is not chained — too large.
 *
 * Pattern scanner (ADR-012) plugs in between (1) and (3) when Phase C
 * lands. The audit-chain prefix `broker.tool.*` keeps these envelopes
 * out of the TUI fan-out (`AuditService.onEvent` filters `broker.*`).
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

  async dispatchTool(intent: ToolIntent): Promise<ToolResult> {
    const aclError = this.checkAcl(intent);
    if (aclError) {
      await this.appendDispatch(intent, "deny", aclError);
      return { ok: false, error: aclError };
    }
    await this.appendDispatch(intent, "allow");

    const started = Date.now();
    let result: ToolResult;
    try {
      const normalized = normalizeFilePathInput(intent.tool, intent.input, intent.cwd);
      const output = await runExecutor(intent.tool, normalized, intent);
      result = { ok: true, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const kind = isInputValidationError(err) ? "input" : "executor";
      result = { ok: false, error: { kind, message } };
    }
    await this.appendResult(intent, result, Date.now() - started);
    return result;
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

  private async appendResult(
    intent: ToolIntent,
    result: ToolResult,
    durationMs: number,
  ): Promise<void> {
    await this.audit.append({
      runId: intent.runId,
      kind: "broker.tool.result",
      payload: {
        tool: intent.tool,
        phaseId: intent.phaseId,
        ok: result.ok,
        durationMs,
        ...(result.ok ? {} : { errorKind: result.error.kind, errorMessage: result.error.message }),
      },
    });
  }
}

class InputValidationError extends Error {
  override readonly name = "InputValidationError";
}

function isInputValidationError(err: unknown): boolean {
  return err instanceof InputValidationError;
}

async function runExecutor(
  name: string,
  input: Record<string, unknown>,
  intent: ToolIntent,
): Promise<string> {
  switch (name) {
    case "Read":
      return executeRead(intent.cwd, readInput(input));
    case "Write":
      return executeWrite(intent.cwd, writeInput(input));
    case "Edit":
      return executeEdit(intent.cwd, editInput(input));
    case "Glob":
      return executeGlob(intent.cwd, globInput(input));
    case "Grep":
      return executeGrep(intent.cwd, grepInput(input));
    case "Bash":
      return executeBash(intent.cwd, bashInput(input));
    case "Skill":
      return executeSkill(intent.skills, skillInput(input));
    default:
      throw new InputValidationError(`Unknown tool "${name}". Known: ${KNOWN_TOOLS.join(", ")}.`);
  }
}

function normalizeFilePathInput(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): Record<string, unknown> {
  const key = name === "Grep" ? "path" : "file_path";
  if (!["Read", "Write", "Edit", "Grep"].includes(name)) return input;
  const value = input[key];
  if (typeof value !== "string" || !isAbsolute(value)) return input;

  const rel = relative(cwd, value);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new InputValidationError(`${name} path is outside the workspace: ${value}`);
  }
  return { ...input, [key]: rel || "." };
}

function readInput(input: Record<string, unknown>): ReadInput {
  return { file_path: requiredString(input, "file_path") };
}

function writeInput(input: Record<string, unknown>): WriteInput {
  return {
    file_path: requiredString(input, "file_path"),
    content: requiredString(input, "content"),
  };
}

function editInput(input: Record<string, unknown>): EditInput {
  return {
    file_path: requiredString(input, "file_path"),
    old_string: requiredString(input, "old_string"),
    new_string: requiredString(input, "new_string"),
  };
}

function globInput(input: Record<string, unknown>): GlobInput {
  return { pattern: requiredString(input, "pattern") };
}

function grepInput(input: Record<string, unknown>): GrepInput {
  return {
    pattern: requiredString(input, "pattern"),
    ...(typeof input["path"] === "string" ? { path: input["path"] } : {}),
  };
}

function bashInput(input: Record<string, unknown>): BashInput {
  return { command: requiredString(input, "command") };
}

function skillInput(input: Record<string, unknown>): SkillInput {
  return { name: requiredString(input, "name") };
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new InputValidationError(`Tool input field "${key}" must be a string.`);
  }
  return value;
}
