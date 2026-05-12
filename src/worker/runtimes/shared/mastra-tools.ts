import type { ToolsInput } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { BrokerClient, ToolIntent } from "../../../broker/client/types";
import type { Skill } from "../../../domain/skill";
import { TOOL_CATALOG, type ToolName } from "../../../domain/tool-authority";
import { executeTool } from "../../tools/dispatcher";
import type { RuntimeEvent } from "../types";

const tracer = trace.getTracer("ordin.tool-dispatch");

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
 * Derive the effective allowed-tools list and use it to decide which
 * Mastra tools we expose. The broker holds the authoritative ACL for
 * the (run, phase) pair (registered parent-side); the intent the
 * worker sends carries no ACL hint, so a compromised runtime cannot
 * widen its own permissions through this surface.
 *
 * Auto-Skill: when the phase has skills attached (`ctx.skills`
 * non-empty), `Skill` is implicitly allowed so the model can load
 * skill bodies on demand. Workflow authors don't need to list it
 * separately — skill attachment is the opt-in. The harness applies
 * the same auto-add when registering the phase ACL, keeping the
 * Mastra tool list and the broker ACL in lockstep.
 */
export function buildDispatcherTools(
  toolNames: readonly string[],
  ctx: DispatcherToolsContext,
): ToolsInput {
  const effective = new Set(toolNames);
  if (ctx.skills.length > 0) effective.add("Skill");

  const out: ToolsInput = {};
  for (const [name, definition] of Object.entries(TOOL_CATALOG) as [ToolName, ToolCatalogEntry][]) {
    if (effective.has(name)) out[name] = makeTool(name, definition, ctx);
  }
  return out;
}

type ToolCatalogEntry = (typeof TOOL_CATALOG)[ToolName];

function makeTool(name: string, entry: ToolCatalogEntry, ctx: DispatcherToolsContext) {
  return createTool({
    id: name,
    description: entry.description,
    inputSchema: entry.inputSchema,
    execute: async (inputData) => {
      const input = inputData as Record<string, unknown>;
      const callId = randomCallId(name);
      const intent: ToolIntent = {
        tool: name,
        input,
        runId: ctx.runId,
        phaseId: ctx.phaseId,
        cwd: ctx.cwd,
        skills: ctx.skills,
      };
      ctx.onEvent({ type: "tool.use", id: callId, name, input });

      // Wrap the whole approval → execute → record sequence in one
      // OTel span so Langfuse renders each tool dispatch as a single
      // node nested inside the active context (model_step / phase).
      return tracer.startActiveSpan(
        `ordin.tool.${name}`,
        { attributes: { "ordin.tool.name": name } },
        async (span) => {
          const started = Date.now();
          try {
            const approval = await ctx.broker.requestApproval(intent);
            if (!approval.ok) {
              const message = approval.error.message;
              ctx.onEvent({ type: "tool.result", id: callId, ok: false, result: message });
              await ctx.broker.recordResult(intent, {
                result: { ok: false, error: approval.error },
                durationMs: Date.now() - started,
              });
              span.setAttribute("ordin.tool.error_kind", approval.error.kind);
              span.setStatus({ code: SpanStatusCode.ERROR, message });
              throw new Error(message);
            }

            const result = await executeTool(name, input, {
              cwd: ctx.cwd,
              skills: ctx.skills,
            });
            const durationMs = Date.now() - started;
            await ctx.broker.recordResult(intent, { result, durationMs });

            if (result.ok) {
              ctx.onEvent({
                type: "tool.result",
                id: callId,
                ok: true,
                ...(result.output ? { result: result.output } : {}),
              });
              span.setAttribute("ordin.tool.success", true);
              return result.output;
            }
            const message = result.error.message;
            ctx.onEvent({ type: "tool.result", id: callId, ok: false, result: message });
            span.setAttribute("ordin.tool.error_kind", result.error.kind);
            span.setStatus({ code: SpanStatusCode.ERROR, message });
            throw new Error(message);
          } finally {
            span.end();
          }
        },
      );
    },
  });
}

function randomCallId(name: string): string {
  return `ordin_${name}_${Math.random().toString(36).slice(2, 10)}`;
}
