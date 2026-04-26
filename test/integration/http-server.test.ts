import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHttpApp } from "../../src/http/app";
import type { RunEvent } from "../../src/orchestrator/events";
import { RunService } from "../../src/run-service/run-service";
import { FakeRuntime, makeHarnessRoot } from "../fixtures/harness-root";

describe("HTTP app (in-process)", () => {
  it("serves a valid OpenAPI 3.0 document at /openapi.json", async () => {
    const { app } = await makeApp();
    const res = await app.fetch(new Request("http://localhost/openapi.json"));
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.0.0");
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining([
        "/runs",
        "/runs/{runId}",
        "/runs/{runId}/gates",
        "/runs/{runId}/gates/{phaseId}/decide",
        "/preview",
      ]),
    );
  });

  it("returns composed phase previews from POST /preview", async () => {
    const { app } = await makeApp();
    const repoPath = await mkdtemp(join(tmpdir(), "ordin-http-repo-"));
    const res = await app.fetch(
      new Request("http://localhost/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Preview", slug: "http-preview", repoPath, tier: "M" }),
      }),
    );
    expect(res.status).toBe(200);
    const previews = (await res.json()) as Array<{
      phaseId: string;
      runtimeName: string;
      systemPrompt: string;
      userPrompt: string;
    }>;
    expect(previews.map((p) => p.phaseId)).toEqual(["plan", "build", "review"]);
    expect(previews[0]?.runtimeName).toBe("ai-sdk");
    expect(previews[0]?.userPrompt).toContain("Preview");
  });

  it("starts a run, surfaces a pending gate, and resolves it via POST /decide", async () => {
    const { app } = await makeApp();
    const repoPath = await mkdtemp(join(tmpdir(), "ordin-http-repo-"));

    const start = await app.fetch(
      new Request("http://localhost/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Ship", slug: "ship-it", repoPath, tier: "M" }),
      }),
    );
    expect(start.status).toBe(200);
    const { runId } = (await start.json()) as { runId: string };
    expect(runId).toMatch(/ship-it/);

    await Promise.all(
      ["plan", "build", "review"].map((phaseId) =>
        waitForPendingGate(app, runId, phaseId).then(() =>
          decide(app, runId, phaseId, { status: "approved" }),
        ),
      ),
    );

    const meta = await pollRunCompletion(app, runId);
    expect(meta.status).toBe("completed");
    expect(meta.phases.map((p) => p.phaseId)).toEqual(["plan", "build", "review"]);
  });

  it("streams RunEvents over SSE at /runs/:runId/events", async () => {
    const { app } = await makeApp();
    const repoPath = await mkdtemp(join(tmpdir(), "ordin-http-repo-"));

    const start = await app.fetch(
      new Request("http://localhost/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "Ship", slug: "ship-sse", repoPath, tier: "M" }),
      }),
    );
    const { runId } = (await start.json()) as { runId: string };

    const sse = await app.fetch(new Request(`http://localhost/runs/${runId}/events`));
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");

    const decisions = ["plan", "build", "review"].map((phaseId) =>
      waitForPendingGate(app, runId, phaseId).then(() =>
        decide(app, runId, phaseId, { status: "approved" }),
      ),
    );

    const events = await collectSseEvents(sse, () => Promise.all(decisions));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("phase.started");
    expect(types).toContain("gate.requested");
    expect(types).toContain("gate.decided");
    expect(types[types.length - 1]).toBe("run.completed");
  });

  describe("failure paths", () => {
    it("returns 404 for an unknown run id", async () => {
      const { app } = await makeApp();
      const res = await app.fetch(new Request("http://localhost/runs/no-such-run"));
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBeTruthy();
    });

    it("returns 400 when the request body is missing required fields", async () => {
      const { app } = await makeApp();
      const res = await app.fetch(
        new Request("http://localhost/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: "no-task" }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("halts the run when a gate is rejected", async () => {
      const { app } = await makeApp();
      const repoPath = await mkdtemp(join(tmpdir(), "ordin-http-repo-"));
      const start = await app.fetch(
        new Request("http://localhost/runs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ task: "Halt", slug: "halt-me", repoPath, tier: "M" }),
        }),
      );
      const { runId } = (await start.json()) as { runId: string };

      await waitForPendingGate(app, runId, "plan");
      await decide(app, runId, "plan", { status: "rejected", reason: "not good enough" });

      const meta = await pollRunCompletion(app, runId);
      expect(meta.status).toBe("halted");
      expect(meta.phases.map((p) => p.phaseId)).toEqual(["plan"]);
    });
  });
});

async function makeApp(): Promise<{ app: ReturnType<typeof createHttpApp>; service: RunService }> {
  const root = await makeHarnessRoot();
  const service = new RunService({
    root,
    runtimes: new Map([["ai-sdk", new FakeRuntime()]]),
  });
  return { app: createHttpApp(service), service };
}

async function decide(
  app: ReturnType<typeof createHttpApp>,
  runId: string,
  phaseId: string,
  decision: { status: "approved"; note?: string } | { status: "rejected"; reason: string },
): Promise<void> {
  const res = await app.fetch(
    new Request(`http://localhost/runs/${runId}/gates/${phaseId}/decide`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(decision),
    }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { resolved: boolean };
  expect(body.resolved).toBe(true);
}

async function waitForPendingGate(
  app: ReturnType<typeof createHttpApp>,
  runId: string,
  phaseId: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.fetch(new Request(`http://localhost/runs/${runId}/gates`));
    const gates = (await res.json()) as Array<{ phaseId: string }>;
    if (gates.some((g) => g.phaseId === phaseId)) return;
    await sleep(20);
  }
  throw new Error(`Gate ${phaseId} for ${runId} never appeared within ${timeoutMs}ms`);
}

async function pollRunCompletion(
  app: ReturnType<typeof createHttpApp>,
  runId: string,
  timeoutMs = 5000,
): Promise<{ status: string; phases: Array<{ phaseId: string }> }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.fetch(new Request(`http://localhost/runs/${runId}`));
    if (res.status === 200) {
      const meta = (await res.json()) as { status: string; phases: Array<{ phaseId: string }> };
      if (meta.status !== "running") return meta;
    }
    await sleep(20);
  }
  throw new Error(`Run ${runId} never completed within ${timeoutMs}ms`);
}

async function collectSseEvents(
  res: Response,
  trigger: () => Promise<unknown>,
): Promise<RunEvent[]> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("SSE response has no body");
  const decoder = new TextDecoder();
  const events: RunEvent[] = [];

  void trigger();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const dataLine = chunk.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice(6)) as RunEvent;
      events.push(event);
      if (event.type === "run.completed") return events;
    }
  }
  return events;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
