import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applySeedPlan, buildRunInput, resolveRunCommand } from "../../src/cli/run-command";
import type { Harness, RunMeta } from "../../src/composition/harness";
import { WorkflowManifest } from "../../src/domain/workflow";

describe("run command resolution", () => {
  it("reconstructs --again input and lets explicit flags override reused values", async () => {
    const prior = runMeta({
      runId: "old",
      workflow: "software-delivery",
      task: "Old task",
      slug: "old-task",
      repo: "/repo/old",
      tier: "M",
      sandboxMode: "srt",
      phaseSlicing: { onlyPhases: ["build"] },
    });

    const resolved = await resolveRunCommand(
      [],
      { again: "old", repo: "/repo/new", tier: "S", slug: "new-task" },
      () => fakeRuntime({ runs: { old: prior } }),
    );

    expect(resolved.bundle).toBe("software-delivery");
    expect(resolved.sandbox).toBe("srt");
    expect(resolved.input).toMatchObject({
      task: "Old task",
      slug: "new-task",
      repoPath: "/repo/new",
      tier: "S",
      onlyPhases: ["build"],
    });
  });

  it("requires phase slicing for seeding runs", async () => {
    await expect(
      resolveRunCommand(["Task"], { fromRun: "old" }, () =>
        fakeRuntime({ runs: { old: runMeta({ runId: "old" }) } }),
      ),
    ).rejects.toThrow(/Seed flags require --only/);
  });

  it("allows fixture capture from a run without phase slicing", async () => {
    const resolved = await resolveRunCommand(
      [],
      { fromRun: "old", captureFixture: "plan-rfc" },
      () => fakeRuntime({ runs: { old: runMeta({ runId: "old" }) } }),
    );

    expect(resolved.seed).toMatchObject({
      kind: "capture-fixture",
      name: "plan-rfc",
    });
  });

  it("applies fixture seeds before the live run can start", async () => {
    const root = await mkdtemp(join(tmpdir(), "ordin-run-command-"));
    const repo = join(root, "repo");
    const fixturesRoot = join(root, "fixtures", "runs");
    await mkdir(join(fixturesRoot, "plan", "docs", "rfcs"), { recursive: true });
    await writeFile(join(fixturesRoot, "plan", "docs", "rfcs", "task-rfc.md"), "rfc");

    const resolved = await resolveRunCommand(
      ["Task"],
      { repo, slug: "task", fixture: "plan", only: "build" },
      () => fakeRuntime({ root, repo }),
    );

    await applySeedPlan(resolved.seed, resolved.input, fakeRuntime({ root, repo }));

    await expect(readFile(join(repo, "docs", "rfcs", "task-rfc.md"), "utf8")).resolves.toBe("rfc");
  });
});

describe("buildRunInput", () => {
  it("builds a full workflow run input", () => {
    expect(
      buildRunInput(["Add", "validation"], {
        repo: ".scratch/repo",
        tier: "S",
        slug: "add-validation",
      }),
    ).toEqual({
      task: "Add validation",
      slug: "add-validation",
      repoPath: ".scratch/repo",
      tier: "S",
    });
  });

  it("supports running a single workflow-defined phase", () => {
    expect(
      buildRunInput(["Do", "work"], {
        project: "fixture",
        tier: "M",
        only: "implement",
      }),
    ).toEqual({
      task: "Do work",
      slug: "do-work",
      projectName: "fixture",
      tier: "M",
      onlyPhases: ["implement"],
    });
  });

  it("supports starting from a workflow-defined phase", () => {
    expect(
      buildRunInput(["Continue"], {
        repo: ".scratch/repo",
        tier: "L",
        slug: "continue",
        from: "review",
      }),
    ).toEqual({
      task: "Continue",
      slug: "continue",
      repoPath: ".scratch/repo",
      tier: "L",
      startAt: "review",
    });
  });

  it("rejects conflicting phase slicing options", () => {
    expect(() =>
      buildRunInput(["Do work"], {
        tier: "M",
        only: "build",
        from: "build",
      }),
    ).toThrow(/either --only or --from/);
  });

  it("uses --from-run values when task details are omitted", () => {
    expect(
      buildRunInput([], {}, { fromRun: runMeta({ task: "Prior task", slug: "prior" }) }),
    ).toMatchObject({
      task: "Prior task",
      slug: "prior",
      tier: "M",
    });
  });
});

function fakeRuntime(opts: {
  readonly root?: string;
  readonly repo?: string;
  readonly runs?: Record<string, RunMeta>;
}): Harness {
  const workflow = new WorkflowManifest({
    name: "software-delivery",
    version: "1",
    phases: [
      {
        id: "plan",
        agent: "planner",
        gate: "human",
        outputs: [{ label: "RFC", path: "docs/rfcs/{slug}-rfc.md" }],
      },
      {
        id: "build",
        agent: "builder",
        gate: "human",
        inputs: [{ label: "RFC", path: "docs/rfcs/{slug}-rfc.md" }],
      },
    ],
  });
  return {
    getRun: async (runId: string) => {
      const run = opts.runs?.[runId];
      if (!run) throw new Error(`missing run ${runId}`);
      return run;
    },
    workflowDefinition: async () => workflow,
    paths: () => ({
      root: opts.root ?? "/harness",
      configFile: "",
      projectsFile: "",
      projectsLocalFile: "",
    }),
    resolveRunWorkspace: async () => opts.repo ?? "/repo",
  } as unknown as Harness;
}

function runMeta(overrides: Partial<RunMeta>): RunMeta {
  return {
    runId: "run",
    workflow: "software-delivery",
    bundle: { name: "software-delivery", version: "0", hash: "0".repeat(64) },
    tier: "M",
    task: "Task",
    slug: "task",
    repo: "/repo",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "completed",
    phases: [],
    ...overrides,
  };
}
