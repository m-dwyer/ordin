import { isAbsolute, relative } from "node:path";
import type { Skill } from "../../../domain/skill";
import {
  type BashInput,
  type EditInput,
  executeBash,
  executeEdit,
  executeGlob,
  executeGrep,
  executeRead,
  executeSkill,
  executeWrite,
  type GlobInput,
  type GrepInput,
  type ReadInput,
  type SkillInput,
  type WriteInput,
} from "./tools";

/**
 * Name-based tool dispatcher. Maps app-level tool names ("Bash",
 * "Read", …) to the shared executors. Used by runtimes that don't
 * have their own SDK-driven tool dispatch — ScriptedRuntime today,
 * future custom / SDK-less runtimes later.
 *
 * Single-purpose for now; designed as the seat for the v3 ADR-012
 * pre-execution pattern scanner. The intended evolution: `before` /
 * `after` hooks on this class let a scanner inspect (name, input,
 * ctx) and block dangerous patterns before the executor runs.
 */
export interface ToolDispatchContext {
  readonly cwd: string;
  readonly skills: readonly Skill[];
}

const KNOWN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Skill"] as const;
export type KnownTool = (typeof KNOWN_TOOLS)[number];

export class ToolDispatcher {
  async dispatch(
    name: string,
    input: Record<string, unknown>,
    ctx: ToolDispatchContext,
  ): Promise<string> {
    const normalized = normalizeFilePathInput(name, input, ctx.cwd);
    switch (name) {
      case "Read":
        return executeRead(ctx.cwd, readInput(normalized));
      case "Write":
        return executeWrite(ctx.cwd, writeInput(normalized));
      case "Edit":
        return executeEdit(ctx.cwd, editInput(normalized));
      case "Glob":
        return executeGlob(ctx.cwd, globInput(normalized));
      case "Grep":
        return executeGrep(ctx.cwd, grepInput(normalized));
      case "Bash":
        return executeBash(ctx.cwd, bashInput(normalized));
      case "Skill":
        return executeSkill(ctx.skills, skillInput(normalized));
      default:
        throw new Error(`Unknown tool "${name}". Known: ${KNOWN_TOOLS.join(", ")}.`);
    }
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
    throw new Error(`${name} path is outside the workspace: ${value}`);
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
  if (typeof value !== "string") throw new Error(`Tool input field "${key}" must be a string.`);
  return value;
}
