import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dispatchFromRuntime, FakeRuntime } from "../../test/fixtures/agent-runtime";
import { makeHarnessRoot } from "../../test/fixtures/harness-root";
import { AutoGate } from "../gates/auto";
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
      gateForKind: () => new AutoGate(),
      dispatchPhase: dispatchFromRuntime(new FakeRuntime()),
    });

    const meta = await runtime.startRun({
      task: "Ship feature x",
      slug: "ship-feature-x",
      repoPath,
      tier: "M",
      onEvent: (ev) => events.push(ev),
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
});
