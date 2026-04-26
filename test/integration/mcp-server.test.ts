import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../../src/mcp/server";
import { RunService } from "../../src/run-service/run-service";
import { FakeRuntime, makeHarnessRoot } from "../fixtures/harness-root";

/**
 * In-process MCP transport via `InMemoryTransport.createLinkedPair`.
 * Same code path a real host (Claude Code, Cursor, …) would hit; just
 * skips spawning a subprocess.
 */
describe("MCP server", () => {
  it("exposes the expected tool surface", async () => {
    const { client } = await makePair();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "getEvents",
      "getRun",
      "listRuns",
      "pendingGates",
      "previewRun",
      "resolveGate",
      "startRun",
    ]);
  });

  it("drives a full run end-to-end through tool calls", async () => {
    const { client } = await makePair();
    const repoPath = await mkdtemp(join(tmpdir(), "ordin-mcp-"));

    const start = await client.callTool({
      name: "startRun",
      arguments: { task: "MCP run", slug: "mcp-run", repoPath, tier: "M" },
    });
    const { runId } = start.structuredContent as { runId: string };
    expect(runId).toMatch(/mcp-run/);

    for (const phaseId of ["plan", "build", "review"]) {
      await waitForGate(client, runId, phaseId);
      const decided = await client.callTool({
        name: "resolveGate",
        arguments: { runId, phaseId, decision: { status: "approved" } },
      });
      expect((decided.structuredContent as { resolved: boolean }).resolved).toBe(true);
    }

    const final = await pollUntilDone(client, runId);
    expect(final.done).toBe(true);
    const types = final.events.map((e) => (e as { type: string }).type);
    expect(types[0]).toBe("run.started");
    expect(types[types.length - 1]).toBe("run.completed");
  });

  it("returns data in the `content` array, not just `structuredContent`", async () => {
    const { client } = await makePair();
    const repoPath = await mkdtemp(join(tmpdir(), "ordin-mcp-content-"));
    const start = await client.callTool({
      name: "startRun",
      arguments: { task: "MCP content", slug: "mcp-content", repoPath, tier: "M" },
    });
    const { runId } = start.structuredContent as { runId: string };

    const events = await client.callTool({
      name: "getEvents",
      arguments: { runId, since: 0 },
    });
    const blocks = events.content as Array<{ type: string; text: string }>;
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const concatenated = blocks.map((b) => b.text).join("\n");
    expect(concatenated).toContain("run.started");
  });

  it("returns isError when resolving a non-existent gate", async () => {
    const { client } = await makePair();
    const res = await client.callTool({
      name: "resolveGate",
      arguments: {
        runId: "no-such-run",
        phaseId: "plan",
        decision: { status: "approved" },
      },
    });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { resolved: boolean }).resolved).toBe(false);
  });
});

async function makePair(): Promise<{ client: Client }> {
  const root = await makeHarnessRoot();
  const service = new RunService({
    root,
    runtimes: new Map([["ai-sdk", new FakeRuntime()]]),
  });
  const server = createMcpServer(service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "0" });
  await client.connect(clientTransport);
  return { client };
}

async function waitForGate(
  client: Client,
  runId: string,
  phaseId: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await client.callTool({ name: "pendingGates", arguments: { runId } });
    const { gates } = res.structuredContent as { gates: Array<{ phaseId: string }> };
    if (gates.some((g) => g.phaseId === phaseId)) return;
    await sleep(20);
  }
  throw new Error(`Gate ${phaseId} never appeared`);
}

async function pollUntilDone(
  client: Client,
  runId: string,
  timeoutMs = 5000,
): Promise<{ events: unknown[]; done: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let cursor = 0;
  const all: unknown[] = [];
  while (Date.now() < deadline) {
    const res = await client.callTool({
      name: "getEvents",
      arguments: { runId, since: cursor },
    });
    const result = res.structuredContent as {
      events: unknown[];
      nextCursor: number;
      done: boolean;
    };
    all.push(...result.events);
    cursor = result.nextCursor;
    if (result.done) return { events: all, done: true };
    await sleep(20);
  }
  throw new Error(`Run ${runId} never completed`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
