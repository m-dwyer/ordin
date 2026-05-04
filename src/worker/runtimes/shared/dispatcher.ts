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
    switch (name) {
      case "Read":
        return executeRead(ctx.cwd, input as unknown as ReadInput);
      case "Write":
        return executeWrite(ctx.cwd, input as unknown as WriteInput);
      case "Edit":
        return executeEdit(ctx.cwd, input as unknown as EditInput);
      case "Glob":
        return executeGlob(ctx.cwd, input as unknown as GlobInput);
      case "Grep":
        return executeGrep(ctx.cwd, input as unknown as GrepInput);
      case "Bash":
        return executeBash(ctx.cwd, input as unknown as BashInput);
      case "Skill":
        return executeSkill(ctx.skills, input as unknown as SkillInput);
      default:
        throw new Error(`Unknown tool "${name}". Known: ${KNOWN_TOOLS.join(", ")}.`);
    }
  }
}
