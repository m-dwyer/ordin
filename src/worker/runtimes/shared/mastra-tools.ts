import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Skill } from "../../../domain/skill";
import type { RuntimeEvent } from "../types";
import type { ToolDispatcher } from "./dispatcher";

/**
 * Mastra/Vercel tool builder that routes every tool call through
 * `ToolDispatcher.dispatch` and emits the harness's tool events
 * (`tool.use` / `tool.result` / `ordin.tool.<name>` timing) for
 * observability. The dispatcher is the single executor for both
 * Mastra-Agent runtimes once `AiSdkRuntime` migrates onto this
 * builder (planned follow-up).
 *
 * Tool input schemas mirror the canonical executors in
 * `./tools.ts`; the dispatcher coerces to the same input shapes.
 */

export interface DispatcherToolsContext {
  readonly cwd: string;
  readonly skills: readonly Skill[];
  readonly dispatcher: ToolDispatcher;
  readonly onEvent: (event: RuntimeEvent) => void;
}

export function buildDispatcherTools(
  toolNames: readonly string[],
  ctx: DispatcherToolsContext,
): ToolsInput {
  const allowed = new Set(toolNames);
  const out: ToolsInput = {};
  for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) {
    if (allowed.has(name)) out[name] = makeTool(name, schema, ctx);
  }
  if (ctx.skills.length > 0) out["Skill"] = makeTool("Skill", TOOL_SCHEMAS.Skill, ctx);
  return out;
}

const TOOL_SCHEMAS = {
  Read: {
    description: "Read a UTF-8 file relative to CWD or absolute. Returns its full contents.",
    schema: z.object({
      file_path: z.string().describe("Path, relative to CWD or absolute."),
    }),
  },
  Write: {
    description: "Overwrite (or create) a file with the given contents. Parent dirs are created.",
    schema: z.object({
      file_path: z.string().describe("Target path; parent dirs are created."),
      content: z.string().describe("Full new file contents (overwrites)."),
    }),
  },
  Edit: {
    description: "Replace exactly one occurrence of `old_string` with `new_string` in a file.",
    schema: z.object({
      file_path: z.string(),
      old_string: z.string().describe("Exact string to replace; must be unique in the file."),
      new_string: z.string(),
    }),
  },
  Glob: {
    description: "List files matching a glob pattern. Max 200 results.",
    schema: z.object({
      pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'. Max 200 results."),
    }),
  },
  Grep: {
    description: "Search file contents for a JavaScript regex.",
    schema: z.object({
      pattern: z.string().describe("JavaScript regex."),
      path: z.string().optional().describe("Optional glob to scope search (default '**/*')."),
    }),
  },
  Bash: {
    description:
      "Run a shell command in CWD via `bash -c`. Returns stdout; throws on non-zero exit.",
    schema: z.object({
      command: z.string().describe("Shell command run in CWD via `bash -c`."),
    }),
  },
  Skill: {
    description: "Load a skill body by name. Catalog is in the user prompt.",
    schema: z.object({
      name: z.string().describe("Name of the skill to load. Catalog is in the user prompt."),
    }),
  },
} as const;

type ToolSchemaEntry = (typeof TOOL_SCHEMAS)[keyof typeof TOOL_SCHEMAS];

function makeTool(name: string, entry: ToolSchemaEntry, ctx: DispatcherToolsContext) {
  return createTool({
    id: name,
    description: entry.description,
    inputSchema: entry.schema,
    execute: async (inputData) => {
      const input = inputData as Record<string, unknown>;
      const callId = randomCallId(name);
      ctx.onEvent({ type: "tool.use", id: callId, name, input });
      const started = Date.now();
      try {
        const result = await ctx.dispatcher.dispatch(name, input, {
          cwd: ctx.cwd,
          skills: ctx.skills,
        });
        ctx.onEvent({
          type: "tool.result",
          id: callId,
          ok: true,
          ...(result ? { result } : {}),
        });
        ctx.onEvent({
          type: "timing",
          name: `ordin.tool.${name}`,
          durationMs: Date.now() - started,
          status: "ok",
          attributes: { "ordin.tool.name": name },
        });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.onEvent({ type: "tool.result", id: callId, ok: false, result: message });
        ctx.onEvent({
          type: "timing",
          name: `ordin.tool.${name}`,
          durationMs: Date.now() - started,
          status: "error",
          error: message,
          attributes: { "ordin.tool.name": name },
        });
        throw err;
      }
    },
  });
}

function randomCallId(name: string): string {
  return `ordin_${name}_${Math.random().toString(36).slice(2, 10)}`;
}
