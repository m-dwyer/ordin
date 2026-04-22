import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateRunId, type RunMeta, RunStore } from "../../src/orchestrator/run-store";

describe("RunStore", () => {
  it("round-trips run metadata", async () => {
    const base = await mkdtemp(join(tmpdir(), "harness-rs-"));
    const store = new RunStore(base);
    const meta: RunMeta = {
      runId: generateRunId("test-slug"),
      workflow: "wf",
      tier: "M",
      task: "do the thing",
      slug: "test-slug",
      repo: "/r",
      startedAt: new Date().toISOString(),
      status: "running",
      phases: [],
    };
    await store.writeMeta(meta);
    const again = await store.readMeta(meta.runId);
    expect(again).toEqual(meta);
  });

  it("listRuns returns newest first", async () => {
    const base = await mkdtemp(join(tmpdir(), "harness-rs-"));
    const store = new RunStore(base);
    const a: RunMeta = {
      runId: generateRunId("a", new Date("2025-01-01T00:00:00Z")),
      workflow: "w",
      tier: "M",
      task: "t",
      slug: "a",
      repo: "/r",
      startedAt: "2025-01-01T00:00:00.000Z",
      status: "completed",
      phases: [],
    };
    const b: RunMeta = {
      ...a,
      runId: generateRunId("b", new Date("2025-02-01T00:00:00Z")),
      slug: "b",
      startedAt: "2025-02-01T00:00:00.000Z",
    };
    await store.writeMeta(a);
    await store.writeMeta(b);
    const list = await store.listRuns();
    expect(list.map((m) => m.slug)).toEqual(["b", "a"]);
  });
});
