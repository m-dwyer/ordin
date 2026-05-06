import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { BrokerClient, ToolIntent } from "../../../broker/client/types";
import type { Skill } from "../../../domain/skill";
import { executeTool } from "../../tools/dispatcher";
import type { RuntimeEvent } from "../types";

/**
 * Mastra/Vercel tool builder. Each Mastra tool call splits into three
 * worker-side steps (ADR-016 corrected):
 *
 *   1. `broker.requestApproval(intent)` — broker checks ACL, runs the
 *      pattern scanner (ADR-012, when it lands), audits the intent.
 *   2. `executeTool(intent)` — worker runs the executor locally, in
 *      its own trust domain (kernel-sandboxed under `--sandbox srt`).
 *   3. `broker.recordResult(intent, recorded)` — broker audits the
 *      outcome.
 *
 * The runtime never sees which transport the broker uses;
 * `InProcessBrokerClient` and `HttpBrokerClient` speak the same
 * `BrokerClient` surface.
 *
 * Worker isolation: `BrokerClient` and `ToolIntent` are imported as
 * type-only edges. The concrete client is constructed parent-side and
 * threaded through `DispatcherToolsContext`.
 */

export interface DispatcherToolsContext {
  readonly cwd: string;
  readonly skills: readonly Skill[];
  readonly broker: BrokerClient;
  readonly runId: string;
  readonly phaseId: string;
  readonly onEvent: (event: RuntimeEvent) => void;
}

/**
 * Derive the effective allowed-tools list once, then use it for both
 * (a) which Mastra tools we expose and (b) the `allowedTools` field
 * on each `ToolIntent` the broker checks. Two concerns must stay in
 * lockstep: if the model can call a tool, the broker must also know
 * the runtime considers it permitted. Drift between the two is the
 * footgun this function eliminates.
 *
 * Auto-Skill: when the phase has skills attached (`ctx.skills`
 * non-empty), `Skill` is implicitly allowed so the model can load
 * skill bodies on demand. Workflow authors don't need to list it
 * separately — skill attachment is the opt-in.
 */
export function buildDispatcherTools(
  toolNames: readonly string[],
  ctx: DispatcherToolsContext,
): ToolsInput {
  const effective = new Set(toolNames);
  if (ctx.skills.length > 0) effective.add("Skill");
  const allowedTools = [...effective];

  const out: ToolsInput = {};
  for (const [name, schema] of Object.entries(TOOL_SCHEMAS)) {
    if (effective.has(name)) out[name] = makeTool(name, schema, allowedTools, ctx);
  }
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

function makeTool(
  name: string,
  entry: ToolSchemaEntry,
  allowedTools: readonly string[],
  ctx: DispatcherToolsContext,
) {
  return createTool({
    id: name,
    description: entry.description,
    inputSchema: entry.schema,
    execute: async (inputData) => {
      const input = inputData as Record<string, unknown>;
      const callId = randomCallId(name);
      const intent: ToolIntent = {
        tool: name,
        input,
        runId: ctx.runId,
        phaseId: ctx.phaseId,
        cwd: ctx.cwd,
        allowedTools,
        skills: ctx.skills,
      };
      ctx.onEvent({ type: "tool.use", id: callId, name, input });
      const started = Date.now();

      const approval = await ctx.broker.requestApproval(intent);
      if (!approval.ok) {
        const message = approval.error.message;
        ctx.onEvent({ type: "tool.result", id: callId, ok: false, result: message });
        ctx.onEvent({
          type: "timing",
          name: `ordin.tool.${name}`,
          durationMs: Date.now() - started,
          status: "error",
          error: message,
          attributes: { "ordin.tool.name": name, "ordin.tool.error_kind": approval.error.kind },
        });
        // Record the (denied) outcome so audit reflects the worker
        // never executed it. Fire-and-await — the result envelope
        // mirrors the dispatch deny envelope.
        await ctx.broker.recordResult(intent, {
          result: { ok: false, error: approval.error },
          durationMs: Date.now() - started,
        });
        throw new Error(message);
      }

      const result = await executeTool(name, input, { cwd: ctx.cwd, skills: ctx.skills });
      const durationMs = Date.now() - started;
      await ctx.broker.recordResult(intent, { result, durationMs });

      if (result.ok) {
        ctx.onEvent({
          type: "tool.result",
          id: callId,
          ok: true,
          ...(result.output ? { result: result.output } : {}),
        });
        ctx.onEvent({
          type: "timing",
          name: `ordin.tool.${name}`,
          durationMs,
          status: "ok",
          attributes: { "ordin.tool.name": name },
        });
        return result.output;
      }
      const message = result.error.message;
      ctx.onEvent({ type: "tool.result", id: callId, ok: false, result: message });
      ctx.onEvent({
        type: "timing",
        name: `ordin.tool.${name}`,
        durationMs,
        status: "error",
        error: message,
        attributes: { "ordin.tool.name": name, "ordin.tool.error_kind": result.error.kind },
      });
      throw new Error(message);
    },
  });
}

function randomCallId(name: string): string {
  return `ordin_${name}_${Math.random().toString(36).slice(2, 10)}`;
}
