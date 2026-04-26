import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpApp } from "../../src/http/app";
import { type RunningHttpServer, startHttpServer } from "../../src/http/server";
import { RunService } from "../../src/run-service/run-service";
import { FakeRuntime, makeHarnessRoot } from "../fixtures/harness-root";

/**
 * Real-port integration: exercises the @hono/node-server adapter that
 * `app.fetch()` skips. Port 0 = OS picks an available port; the actual
 * port is read off the resolved `RunningHttpServer`.
 */
describe("HTTP server (real port)", () => {
  let server: RunningHttpServer;
  let baseUrl: string;

  beforeAll(async () => {
    const root = await makeHarnessRoot();
    const service = new RunService({
      root,
      runtimes: new Map([["ai-sdk", new FakeRuntime()]]),
    });
    server = await startHttpServer(createHttpApp(service), { port: 0 });
    baseUrl = `http://${server.hostname}:${server.port}`;
  });

  afterAll(async () => {
    await server.close();
  });

  it("serves /openapi.json over real HTTP", async () => {
    const res = await fetch(`${baseUrl}/openapi.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.0.0");
    expect(doc.paths).toHaveProperty("/runs");
  });

  it("drives a full run end-to-end via real HTTP", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "ordin-http-net-"));
    const start = await fetch(`${baseUrl}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "Net", slug: "net-run", repoPath, tier: "M" }),
    });
    expect(start.status).toBe(200);
    const { runId } = (await start.json()) as { runId: string };

    for (const phaseId of ["plan", "build", "review"]) {
      await waitForGate(baseUrl, runId, phaseId);
      const decided = await fetch(`${baseUrl}/runs/${runId}/gates/${phaseId}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "approved" }),
      });
      expect(decided.status).toBe(200);
    }

    const meta = await pollCompletion(baseUrl, runId);
    expect(meta.status).toBe("completed");
    expect(meta.phases.map((p) => p.phaseId)).toEqual(["plan", "build", "review"]);
  });
});

async function waitForGate(
  baseUrl: string,
  runId: string,
  phaseId: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/runs/${runId}/gates`);
    const gates = (await res.json()) as Array<{ phaseId: string }>;
    if (gates.some((g) => g.phaseId === phaseId)) return;
    await sleep(20);
  }
  throw new Error(`Gate ${phaseId} for ${runId} never appeared`);
}

async function pollCompletion(
  baseUrl: string,
  runId: string,
  timeoutMs = 5000,
): Promise<{ status: string; phases: Array<{ phaseId: string }> }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${baseUrl}/runs/${runId}`);
    if (res.status === 200) {
      const meta = (await res.json()) as { status: string; phases: Array<{ phaseId: string }> };
      if (meta.status !== "running") return meta;
    }
    await sleep(20);
  }
  throw new Error(`Run ${runId} never completed`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
