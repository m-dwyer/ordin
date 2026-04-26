import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OrdinHttpClient } from "../../src/client/http-client";
import { createHttpApp } from "../../src/http/app";
import { type RunningHttpServer, startHttpServer } from "../../src/http/server";
import { RunService } from "../../src/run-service/run-service";
import { FakeRuntime, makeHarnessRoot } from "../fixtures/harness-root";

describe("OrdinHttpClient (real server)", () => {
  let server: RunningHttpServer;
  let client: OrdinHttpClient;

  beforeAll(async () => {
    const root = await makeHarnessRoot();
    const service = new RunService({
      root,
      runtimes: new Map([["ai-sdk", new FakeRuntime()]]),
    });
    server = await startHttpServer(createHttpApp(service), { port: 0 });
    client = new OrdinHttpClient({ baseUrl: `http://${server.hostname}:${server.port}` });
  });

  afterAll(async () => {
    await server.close();
  });

  it("drives a full run end-to-end through the client", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "ordin-client-"));
    const { runId } = await client.startRun({
      task: "Client run",
      slug: "client-run",
      repoPath,
      tier: "M",
    });

    expect(runId).toMatch(/client-run/);

    for (const phaseId of ["plan", "build", "review"]) {
      await waitForGate(client, runId, phaseId);
      const { resolved } = await client.resolveGate(runId, phaseId, { status: "approved" });
      expect(resolved).toBe(true);
    }

    const meta = await pollCompletion(client, runId);
    expect(meta.status).toBe("completed");
    expect(meta.phases.map((p) => p.phaseId)).toEqual(["plan", "build", "review"]);
  });

  it("streams RunEvents through subscribe()", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "ordin-client-sse-"));
    const { runId } = await client.startRun({
      task: "Client SSE",
      slug: "client-sse",
      repoPath,
      tier: "M",
    });

    const collected: string[] = [];
    const decisions = (async () => {
      for (const phaseId of ["plan", "build", "review"]) {
        await waitForGate(client, runId, phaseId);
        await client.resolveGate(runId, phaseId, { status: "approved" });
      }
    })();

    for await (const event of client.subscribe(runId)) {
      collected.push(event.type);
      if (event.type === "run.completed") break;
    }
    await decisions;

    expect(collected[0]).toBe("run.started");
    expect(collected).toContain("phase.started");
    expect(collected).toContain("gate.requested");
    expect(collected[collected.length - 1]).toBe("run.completed");
  });

  it("returns composed previews via previewRun()", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "ordin-client-preview-"));
    const previews = await client.previewRun({
      task: "Preview",
      slug: "client-preview",
      repoPath,
      tier: "M",
    });
    expect(previews.map((p) => p.phaseId)).toEqual(["plan", "build", "review"]);
  });

  it("surfaces server error bodies in thrown Error messages", async () => {
    await expect(client.getRun("does-not-exist")).rejects.toThrow(/404/);
  });
});

async function waitForGate(
  client: OrdinHttpClient,
  runId: string,
  phaseId: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gates = await client.pendingGates(runId);
    if (gates.some((g) => g.phaseId === phaseId)) return;
    await sleep(20);
  }
  throw new Error(`Gate ${phaseId} for ${runId} never appeared`);
}

async function pollCompletion(
  client: OrdinHttpClient,
  runId: string,
  timeoutMs = 5000,
): Promise<{ status: string; phases: Array<{ phaseId: string }> }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const meta = await client.getRun(runId);
      if (meta.status !== "running") return meta;
    } catch {
      // pending file flush — retry
    }
    await sleep(20);
  }
  throw new Error(`Run ${runId} never completed`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
