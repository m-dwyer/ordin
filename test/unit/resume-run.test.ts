import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ResumeRunUseCase, TerminalRunError } from "../../src/composition/resume-run";
import { RunStore } from "../../src/orchestrator/run-store";

describe("ResumeRunUseCase", () => {
  it("refuses to resume a run whose meta is already terminal", async () => {
    const runsDir = await mkdtemp(join(tmpdir(), "resume-terminal-"));
    const runStore = new RunStore(runsDir);
    const runId = "test-run";
    await runStore.ensureRunDir(runId);
    await writeFile(
      join(runStore.runDir(runId), "meta.json"),
      JSON.stringify({
        runId,
        workflow: "t",
        bundle: { name: "b", version: "1", hash: "h" },
        tier: "M",
        task: "t",
        slug: "t",
        repo: "/tmp",
        startedAt: "2026-05-15T00:00:00.000Z",
        completedAt: "2026-05-15T00:01:00.000Z",
        status: "failed",
        phases: [],
        inFlight: null,
        currentPhaseId: null,
        pendingGate: null,
      }),
    );

    // Loader stub — we only need state.runStore for the early refusal.
    const loader = {
      root: runsDir,
      bundleName: "b",
      load: async () => ({ runStore }) as never,
    } as never;
    const factory = {} as never;
    const useCase = new ResumeRunUseCase(loader, factory);

    await expect(useCase.execute({ runId })).rejects.toBeInstanceOf(TerminalRunError);
  });
});
