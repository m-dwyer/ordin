import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchFromRuntime, FakeRuntime } from "../../test/fixtures/agent-runtime";
import { makeHarnessRoot } from "../../test/fixtures/harness-root";
import { AutoGate } from "../gates/dispatch";
import type { RunEvent } from "../orchestrator/events";
import { HarnessRuntime } from "./harness";

describe("HarnessRuntime", () => {
  it("runs a workflow end-to-end with broker, audit, and passthrough sandbox", async () => {
    const root = await makeHarnessRoot();
    const repoPath = await mkdtemp(join(tmpdir(), "ordin-harness-repo-"));
    await mkdir(repoPath, { recursive: true });
    const events: RunEvent[] = [];

    const runtime = new HarnessRuntime({
      root,
      dispatchPhase: dispatchFromRuntime(new FakeRuntime()),
    });

    const meta = await runtime.startRun({
      task: "Ship feature x",
      slug: "ship-feature-x",
      repoPath,
      tier: "M",
      onEvent: (ev) => events.push(ev),
      gateForKind: () => new AutoGate(),
    });

    expect(meta.status).toBe("completed");
    expect(meta.phases.map((p) => p.phaseId)).toEqual(["plan", "build", "review"]);

    const auditPath = join(root, "runs", meta.runId, "audit.jsonl");
    const auditInfo = await stat(auditPath);
    expect(auditInfo.isFile()).toBe(true);
    const auditLines = (await readFile(auditPath, "utf8")).trim().split("\n").filter(Boolean);
    expect(auditLines.length).toBeGreaterThan(0);

    const eventTypes = events.map((ev) => ev.type);
    expect(eventTypes[0]).toBe("run.started");
    expect(eventTypes).toContain("phase.completed");
    expect(eventTypes.at(-1)).toBe("run.completed");
  });

  it("prepareRun returns a session with runId, events stream, and completion", async () => {
    const root = await makeHarnessRoot();
    const repoPath = await mkdtemp(join(tmpdir(), "ordin-harness-repo-"));
    await mkdir(repoPath, { recursive: true });

    const runtime = new HarnessRuntime({
      root,
      dispatchPhase: dispatchFromRuntime(new FakeRuntime()),
    });

    const session = await runtime.prepareRun({
      task: "Session test",
      slug: "session-test",
      repoPath,
      tier: "M",
      gateForKind: () => new AutoGate(),
    });

    expect(session.runId).toMatch(/_session-test$/);
    expect(runtime.findSession(session.runId)).toBe(session);

    const meta = await session.completion;
    expect(meta.status).toBe("completed");
    expect(meta.runId).toBe(session.runId);

    expect(session.isClosed()).toBe(true);
    // Sessions remain in the map after completion so late MCP polls
    // can drain buffered events and observe isClosed.
    expect(runtime.findSession(session.runId)).toBe(session);
    expect(session.buffered().map((ev) => ev.type)).toContain("run.completed");
  });
});
