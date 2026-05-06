import { isAbsolute, relative } from "node:path";
import type { ToolError, ToolResult } from "../../broker/client/types";
import type { Skill } from "../../domain/skill";
import { type BashInput, executeBash } from "./bash";
import { type EditInput, executeEdit } from "./edit";
import { executeGlob, type GlobInput } from "./glob";
import { executeGrep, type GrepInput } from "./grep";
import { executeRead, type ReadInput } from "./read";
import { executeSkill, type SkillInput } from "./skill";
import { executeWrite, type WriteInput } from "./write";

/**
 * Worker-side tool execution. Runs in the worker's trust domain — the
 * kernel sandbox (`--sandbox srt`) confines the syscalls when active.
 * The broker has already approved the intent via `requestApproval`
 * (ADR-016 corrected); this module is just the executor switch.
 *
 * Input normalization (file-path absolute → relative-to-cwd) lives
 * here since it's part of execution semantics. The broker's policy
 * doesn't care about the rewritten path.
 */

export interface ExecutionContext {
  readonly cwd: string;
  readonly skills: readonly Skill[];
}

/**
 * Run the executor for a known tool. Returns a `ToolResult` rather
 * than throwing so the caller can record both ok and error outcomes
 * uniformly through the broker's `recordResult` audit path.
 */
export async function executeTool(
  tool: string,
  rawInput: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<ToolResult> {
  let input: Record<string, unknown>;
  try {
    input = normalizeFilePathInput(tool, rawInput, ctx.cwd);
  } catch (err) {
    return errorResult(err, "input");
  }
  try {
    const output = await runExecutor(tool, input, ctx);
    return { ok: true, output };
  } catch (err) {
    return errorResult(err, "executor");
  }
}

function errorResult(err: unknown, kind: ToolError["kind"]): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { kind, message } };
}

async function runExecutor(
  name: string,
  input: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<string> {
  switch (name) {
    case "Read":
      return executeRead(ctx.cwd, readInput(input));
    case "Write":
      return executeWrite(ctx.cwd, writeInput(input));
    case "Edit":
      return executeEdit(ctx.cwd, editInput(input));
    case "Glob":
      return executeGlob(ctx.cwd, globInput(input));
    case "Grep":
      return executeGrep(ctx.cwd, grepInput(input));
    case "Bash":
      return executeBash(ctx.cwd, bashInput(input));
    case "Skill":
      return executeSkill(ctx.skills, skillInput(input));
    default:
      throw new InputValidationError(`Unknown tool "${name}".`);
  }
}

class InputValidationError extends Error {
  override readonly name = "InputValidationError";
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
