import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AutoGate } from "../../src/gates/auto";
import type { Engine } from "../../src/orchestrator/engine";
import { HarnessRuntime } from "../../src/runtime/harness";
import type {
  AgentRuntime,
  InvokeRequest,
  InvokeResult,
  RuntimeCapabilities,
} from "../../src/runtimes/types";

class FakeRuntime implements AgentRuntime {
  readonly name = "fake";
  readonly capabilities: RuntimeCapabilities = {
    nativeSkillDiscovery: false,
    streaming: false,
    mcpSupport: false,
    maxContextTokens: 200_000,
  };
  readonly invocations: InvokeRequest[] = [];

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    this.invocations.push(req);
    return {
      status: "ok",
      exitCode: 0,
      transcriptPath: "/tmp/transcript.jsonl",
      tokens: { input: 1, output: 2, cacheReadInput: 0, cacheCreationInput: 0 },
      durationMs: 5,
    };
  }
}

describe("HarnessRuntime", () => {
  it("can run through an injected engine adapter", async () => {
    const root = await makeHarnessRoot();
    const engine: Engine = {
      name: "custom",
      compile: (manifest) => ({
        engineName: "custom",
        manifest,
        run: async (input) => ({
          runId: `custom-${input.slug}`,
          workflow: manifest.name,
          tier: input.tier,
          task: input.task,
          slug: input.slug,
          repo: input.workspaceRoot,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.000Z",
          status: "completed",
          phases: [],
        }),
      }),
    };

    const harness = new HarnessRuntime({ root, engine: "custom", engines: [engine] });
    const meta = await harness.startRun({
      task: "Use custom engine",
      slug: "custom-engine",
      repoPath: "/tmp/repo",
    });

    expect(meta.runId).toBe("custom-custom-engine");
    expect(meta.workflow).toBe("software-delivery");
  });

  it("passes phase-specific artefact inputs through a full run", async () => {
    const root = await makeHarnessRoot();
    const runtime = new FakeRuntime();
    const harness = new HarnessRuntime({
      root,
      runtimes: new Map([["ai-sdk", runtime]]),
      gateForKind: () => new AutoGate(),
    });

    await harness.startRun({
      task: "Ship feature x",
      slug: "ship-feature-x",
      repoPath: "/tmp/repo",
      tier: "M",
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
});

async function makeHarnessRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ordin-runtime-"));
  await mkdir(join(root, "agents"), { recursive: true });
  await mkdir(join(root, "skills"), { recursive: true });
  await mkdir(join(root, "workflows"), { recursive: true });

  await write(
    join(root, "ordin.config.yaml"),
    `run_store:
  base_dir: ${join(root, "runs")}
default_runtime: ai-sdk
default_model: m
allowed_tools: []
runtimes:
  ai-sdk:
    base_url: http://localhost:4000
tiers:
  S: {}
  M: {}
  L: {}
`,
  );
  await write(
    join(root, "workflows", "software-delivery.yaml"),
    `name: software-delivery
version: 1
runtime: ai-sdk
model: m
phases:
  - id: plan
    agent: planner
    gate: human
    allowed_tools: []
    outputs:
      - { label: RFC, path: "docs/rfcs/{slug}-rfc.md", description: "Reviewable RFC for this problem" }
  - id: build
    agent: build-local
    gate: human
    allowed_tools: []
    inputs:
      - { label: "Approved RFC", path: "docs/rfcs/{slug}-rfc.md", description: "Plan-phase output; source of truth for Build and Review" }
    outputs:
      - { label: "Build notes", path: "docs/rfcs/{slug}-build-notes.md" }
  - id: review
    agent: reviewer
    gate: human
    allowed_tools: []
    inputs:
      - { label: "Approved RFC", path: "docs/rfcs/{slug}-rfc.md" }
      - { label: "Build notes", path: "docs/rfcs/{slug}-build-notes.md", description: "Build-phase summary" }
    outputs:
      - { label: Review, path: "reviews/{slug}-review.md" }
`,
  );
  await write(join(root, "projects.yaml"), "projects: {}\n");

  await write(
    join(root, "agents", "planner.md"),
    `---
name: planner
runtime: ai-sdk
---

Planner prompt.
`,
  );
  await write(
    join(root, "agents", "build-local.md"),
    `---
name: build-local
runtime: ai-sdk
---

Build prompt.
`,
  );
  await write(
    join(root, "agents", "reviewer.md"),
    `---
name: reviewer
runtime: ai-sdk
---

Review prompt.
`,
  );

  return root;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}
