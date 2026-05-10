import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dispatchFromRuntime,
  FakeRuntime,
  makeStubRuntime,
} from "../../test/fixtures/agent-runtime";
import { makeHarnessRoot } from "../../test/fixtures/harness-root";
import { AutoGate } from "../gates/auto";
import { DefaultHarnessStateLoader } from "../runtime/default-harness-state-loader";
import { DefaultRunExecutionFactory } from "../runtime/default-run-execution-factory";
import type { AgentRuntime } from "../worker/runtimes/types";
import { StartRunUseCase } from "./start-run";

describe("StartRunUseCase", () => {
  it("passes phase-specific artefact inputs through a full run", async () => {
    const runtime = new FakeRuntime();
    const { root, repoPath, useCase } = await makeUseCase(runtime);

    await useCase.execute({
      task: "Ship feature x",
      slug: "ship-feature-x",
      repoPath,
      tier: "M",
      gateForKind: () => new AutoGate(),
    });

    expect(runtime.invocations.map((i) => i.prompt.phaseId)).toEqual(["plan", "build", "review"]);
    expect(
      runtime.invocations.every(
        (i) => typeof i.runDir === "string" && i.runDir.startsWith(join(root, "runs")),
      ),
    ).toBe(true);

    const [planPrompt, buildPrompt, reviewPrompt] = runtime.invocations.map(
      (i) => i.prompt.userPrompt,
    );
    expect(planPrompt).not.toContain("## Read these artefacts before starting");

    expect(buildPrompt).toContain("## Read these artefacts before starting");
    expect(buildPrompt).toContain("docs/rfcs/ship-feature-x-rfc.md");
    expect(buildPrompt).not.toContain("Build-phase summary");

    expect(reviewPrompt).toContain("## Read these artefacts before starting");
    expect(reviewPrompt).toContain("docs/rfcs/ship-feature-x-rfc.md");
    expect(reviewPrompt).toContain("docs/rfcs/ship-feature-x-build-notes.md");
    expect(reviewPrompt).toContain("Build-phase summary");
  });

  it("fails the phase when declared outputs are not written to disk", async () => {
    const { repoPath, useCase } = await makeUseCase(makeStubRuntime());

    const meta = await useCase.execute({
      task: "Should fail",
      slug: "should-fail",
      repoPath,
      tier: "M",
      gateForKind: () => new AutoGate(),
    });

    expect(meta.status).toBe("failed");
    expect(meta.phases).toHaveLength(1);
    expect(meta.phases[0]?.phaseId).toBe("plan");
    expect(meta.phases[0]?.status).toBe("failed");
    expect(meta.phases[0]?.error).toMatch(/declared outputs that were not written/);
    expect(meta.phases[0]?.error).toContain("docs/rfcs/should-fail-rfc.md");
  });

  it("fails the phase before invoking the runtime when declared inputs are missing", async () => {
    const runtime = makeStubRuntime();
    const { repoPath, useCase } = await makeUseCase(runtime);

    const meta = await useCase.execute({
      task: "Skip plan",
      slug: "skip-plan",
      repoPath,
      tier: "M",
      onlyPhases: ["build"],
      gateForKind: () => new AutoGate(),
    });

    expect(runtime.invoke).not.toHaveBeenCalled();
    expect(meta.status).toBe("failed");
    expect(meta.phases[0]?.status).toBe("failed");
    expect(meta.phases[0]?.error).toMatch(/declared inputs that are missing on disk/);
    expect(meta.phases[0]?.error).toContain("docs/rfcs/skip-plan-rfc.md");
    expect(meta.phases[0]?.runtime).toBeUndefined();
    expect(meta.phases[0]?.model).toBeUndefined();
  });
});

async function makeUseCase(runtime: AgentRuntime = new FakeRuntime()) {
  const root = await makeHarnessRoot();
  const repoPath = await mkdtemp(join(tmpdir(), "ordin-start-run-repo-"));
  const loader = new DefaultHarnessStateLoader({
    root,
    workflowName: "software-delivery",
    engineName: "mastra",
    engines: undefined,
    sandboxModeOverride: undefined,
  });
  const factory = new DefaultRunExecutionFactory({
    dispatchPhaseOverride: dispatchFromRuntime(runtime),
  });
  return {
    root,
    repoPath,
    runtime,
    useCase: new StartRunUseCase(loader, factory),
  };
}
