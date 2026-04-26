import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GateDecisionSchema, StartRunRequestSchema } from "../http/schemas";
import { toPendingGateWire, toPhasePreviewWire } from "../http/wire";
import type { RunService } from "../run-service/run-service";

/**
 * MCP transport over `RunService`. Same wire shape as the HTTP server
 * (input zod schemas reused from `src/http/schemas`); the difference is
 * how the host invokes us. MCP tool calls are one-shot, so SSE is
 * replaced with a polling `getEvents` tool that pages through the
 * event buffer via a cursor.
 *
 * Tool results carry the data in BOTH `content` (a summary plus a JSON
 * block) and `structuredContent`. Many MCP hosts today only surface
 * `content` to the host LLM — agents reasoning over `structuredContent`
 * alone literally don't see the data.
 */
export interface CreateMcpServerOptions {
  readonly name?: string;
  readonly version?: string;
}

interface TextBlock {
  readonly type: "text";
  readonly text: string;
}

function dataContent(summary: string, data: unknown): TextBlock[] {
  return [
    { type: "text", text: summary },
    { type: "text", text: JSON.stringify(data) },
  ];
}

export function createMcpServer(service: RunService, opts: CreateMcpServerOptions = {}): McpServer {
  const server = new McpServer({
    name: opts.name ?? "ordin",
    version: opts.version ?? "0.1.0",
  });

  server.registerTool(
    "startRun",
    {
      description:
        "Start a workflow run. Returns a runId immediately; the run continues in the background. " +
        "Poll `getEvents` to watch progress and surface gate prompts to the user.",
      inputSchema: StartRunRequestSchema.shape,
      outputSchema: { runId: z.string() },
    },
    async (input) => {
      const runId = await service.startRun(input);
      return {
        content: [{ type: "text", text: runId }],
        structuredContent: { runId },
      };
    },
  );

  server.registerTool(
    "previewRun",
    {
      description:
        "Compose phase prompts without invoking any runtime. Useful for showing the user what " +
        "would run before they commit to starting it.",
      inputSchema: StartRunRequestSchema.shape,
      outputSchema: { previews: z.array(z.unknown()) },
    },
    async (input) => {
      const previews = (await service.previewRun(input)).map(toPhasePreviewWire);
      return {
        content: dataContent(`${previews.length} phase(s) composed`, { previews }),
        structuredContent: { previews },
      };
    },
  );

  server.registerTool(
    "listRuns",
    {
      description: "List runs known to this server (most recent first).",
      inputSchema: {},
      outputSchema: { runs: z.array(z.unknown()) },
    },
    async () => {
      const runs = await service.listRuns();
      return {
        content: dataContent(`${runs.length} run(s)`, { runs }),
        structuredContent: { runs },
      };
    },
  );

  server.registerTool(
    "getRun",
    {
      description: "Read run metadata (status, phases, tokens, errors) for a runId.",
      inputSchema: { runId: z.string() },
      outputSchema: { meta: z.unknown() },
    },
    async ({ runId }) => {
      const meta = await service.getRun(runId);
      return {
        content: dataContent(`${meta.runId} · ${meta.status}`, { meta }),
        structuredContent: { meta },
      };
    },
  );

  server.registerTool(
    "getEvents",
    {
      description:
        "Read RunEvents for a run. Pass `since=0` first; on each return, save `nextCursor` and " +
        "pass it as `since` next time to get only new events. Stop when `done` is true. " +
        "Each result returns the actual event objects (with `type`, `phaseId`, etc.) — " +
        "inspect them directly, don't infer from the summary alone.",
      inputSchema: {
        runId: z.string(),
        since: z.number().int().nonnegative().optional(),
      },
      outputSchema: {
        events: z.array(z.unknown()),
        nextCursor: z.number().int().nonnegative(),
        done: z.boolean(),
      },
    },
    async ({ runId, since }) => {
      const result = service.getEvents(runId, since ?? 0);
      const summary = `${result.events.length} new event(s)${result.done ? " · run complete" : ""}`;
      return {
        content: dataContent(summary, result),
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "pendingGates",
    {
      description: "List gates currently awaiting a decision for a runId.",
      inputSchema: { runId: z.string() },
      outputSchema: { gates: z.array(z.unknown()) },
    },
    async ({ runId }) => {
      const gates = service.pendingGatesFor(runId).map(toPendingGateWire);
      return {
        content: dataContent(`${gates.length} pending gate(s)`, { gates }),
        structuredContent: { gates },
      };
    },
  );

  server.registerTool(
    "resolveGate",
    {
      description:
        "Resolve a pending gate. Call after the user has reviewed phase output and decided " +
        "approve or reject. Rejection halts the run unless the workflow has an `on_reject` back-edge.",
      inputSchema: {
        runId: z.string(),
        phaseId: z.string(),
        decision: GateDecisionSchema,
      },
      outputSchema: { resolved: z.boolean() },
    },
    async ({ runId, phaseId, decision }) => {
      const resolved = service.resolveGate(runId, phaseId, decision);
      return {
        content: [
          {
            type: "text",
            text: resolved
              ? `Resolved ${runId}/${phaseId} as ${decision.status}`
              : `No pending gate for ${runId}/${phaseId}`,
          },
        ],
        structuredContent: { resolved },
        ...(resolved ? {} : { isError: true }),
      };
    },
  );

  return server;
}
