import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Skill } from "../../../domain/skill";
import {
  executeBash,
  executeEdit,
  executeGlob,
  executeGrep,
  executeRead,
  executeSkill,
  executeWrite,
  parseToolSpec,
} from "../shared/tools";

/**
 * Mastra Agent tool wrappers. Thin `createTool({...})` adapters
 * around the shared executors in `../shared/tools.ts`. Behaviour,
 * schemas, and parity with `ClaudeCliRuntime` live in the shared
 * module — this file is the Mastra-Agent-specific tool-builder
 * syntax.
 */

export type { ToolSpec } from "../shared/tools";
export { parseToolSpec };

/**
 * Build the Mastra tool map filtered by the phase's allowlist. The
 * `Skill` tool is added unconditionally when the agent has any skills
 * declared — it's the activation step of the agentskills.io
 * progressive-disclosure protocol, not a phase-author choice, so it
 * isn't gated by `allowed_tools`.
 */
export function buildTools(
  cwd: string,
  specs: readonly string[],
  skills: readonly Skill[] = [],
): ToolsInput {
  const allowed = new Set(specs.map((s) => parseToolSpec(s).name));
  const all = allTools(cwd);
  const out: ToolsInput = {};
  for (const name of allowed) {
    const t = all[name];
    if (t) out[name] = t;
  }
  if (skills.length > 0) {
    out["Skill"] = skillTool(skills);
  }
  return out;
}

function skillTool(skills: readonly Skill[]) {
  return createTool({
    id: "Skill",
    description: "Load a skill body by name. Catalog is in the user prompt.",
    inputSchema: z.object({
      name: z.string().describe("Name of the skill to load. Catalog is in the user prompt."),
    }),
    execute: async (input) => executeSkill(skills, input),
  });
}

function allTools(cwd: string): ToolsInput {
  return {
    Read: createTool({
      id: "Read",
      description: "Read a UTF-8 file relative to CWD or absolute. Returns its full contents.",
      inputSchema: z.object({
        file_path: z.string().describe("Path, relative to CWD or absolute."),
      }),
      execute: async (input) => executeRead(cwd, input),
    }),

    Write: createTool({
      id: "Write",
      description: "Overwrite (or create) a file with the given contents. Parent dirs are created.",
      inputSchema: z.object({
        file_path: z.string().describe("Target path; parent dirs are created."),
        content: z.string().describe("Full new file contents (overwrites)."),
      }),
      execute: async (input) => executeWrite(cwd, input),
    }),

    Edit: createTool({
      id: "Edit",
      description: "Replace exactly one occurrence of `old_string` with `new_string` in a file.",
      inputSchema: z.object({
        file_path: z.string(),
        old_string: z.string().describe("Exact string to replace; must be unique in the file."),
        new_string: z.string(),
      }),
      execute: async (input) => executeEdit(cwd, input),
    }),

    Glob: createTool({
      id: "Glob",
      description: "List files matching a glob pattern. Max 200 results.",
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'. Max 200 results."),
      }),
      execute: async (input) => executeGlob(cwd, input),
    }),

    Grep: createTool({
      id: "Grep",
      description: "Search file contents for a JavaScript regex.",
      inputSchema: z.object({
        pattern: z.string().describe("JavaScript regex."),
        path: z.string().optional().describe("Optional glob to scope search (default '**/*')."),
      }),
      execute: async (input) => executeGrep(cwd, input),
    }),

    Bash: createTool({
      id: "Bash",
      description:
        "Run a shell command in CWD via `bash -c`. Returns stdout; throws on non-zero exit.",
      inputSchema: z.object({
        command: z.string().describe("Shell command run in CWD via `bash -c`."),
      }),
      execute: async (input) => executeBash(cwd, input),
    }),
  };
}
