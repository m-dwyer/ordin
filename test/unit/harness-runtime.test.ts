import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
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

/**
 * Stand-in agent runtime. Records invocations and materialises any
 * output paths the prompt declares — mimics a real agent calling
 * `Write` so the engine's post-phase artefact verification is
 * satisfied without us spinning up a real model.
 */
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
    await materializeDeclaredOutputs(req.prompt.userPrompt, req.prompt.cwd);
    return {
      status: "ok",
      exitCode: 0,
      transcriptPath: "/tmp/transcript.jsonl",
      tokens: { input: 1, output: 2, cacheReadInput: 0, cacheCreationInput: 0 },
      durationMs: 5,
    };
  }
}

async function materializeDeclaredOutputs(userPrompt: string, cwd: string): Promise<void> {
  const section = /## Produce these artefacts\n([\s\S]*?)(?=\n## |\nWorking directory:|$)/.exec(
    userPrompt,
  );
  if (!section?.[1]) return;
  const paths = [...section[1].matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "").filter(Boolean);
  for (const rel of paths) {
    const abs = resolvePath(cwd, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, "", "utf8");
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

  it("fails the phase when declared outputs are not written to disk", async () => {
    const root = await makeHarnessRoot();
    // Runtime that returns ok but writes nothing — mimics a model that
    // emitted file content as inline text instead of calling Write.
    const silentRuntime: AgentRuntime = {
      name: "fake",
      capabilities: {
        nativeSkillDiscovery: false,
        streaming: false,
        mcpSupport: false,
        maxContextTokens: 200_000,
      },
      async invoke(): Promise<InvokeResult> {
        return {
          status: "ok",
          exitCode: 0,
          transcriptPath: "/tmp/transcript.jsonl",
          tokens: { input: 1, output: 2, cacheReadInput: 0, cacheCreationInput: 0 },
          durationMs: 5,
        };
      },
    };
    const repoPath = await mkdtemp(join(tmpdir(), "ordin-empty-repo-"));
    const harness = new HarnessRuntime({
      root,
      runtimes: new Map([["ai-sdk", silentRuntime]]),
      gateForKind: () => new AutoGate(),
    });

    const meta = await harness.startRun({
      task: "Should fail",
      slug: "should-fail",
      repoPath,
      tier: "M",
    });

    expect(meta.status).toBe("failed");
    expect(meta.phases).toHaveLength(1);
    expect(meta.phases[0]?.phaseId).toBe("plan");
    expect(meta.phases[0]?.status).toBe("failed");
    expect(meta.phases[0]?.error).toMatch(/declared outputs that were not written/);
    expect(meta.phases[0]?.error).toContain("docs/rfcs/should-fail-rfc.md");
  });

  it("fails the phase before invoking the runtime when declared inputs are missing", async () => {
    const root = await makeHarnessRoot();
    let invoked = 0;
    const tripwireRuntime: AgentRuntime = {
      name: "fake",
      capabilities: {
        nativeSkillDiscovery: false,
        streaming: false,
        mcpSupport: false,
        maxContextTokens: 200_000,
      },
      async invoke(): Promise<InvokeResult> {
        invoked++;
        return {
          status: "ok",
          exitCode: 0,
          transcriptPath: "/tmp/transcript.jsonl",
          tokens: { input: 0, output: 0, cacheReadInput: 0, cacheCreationInput: 0 },
          durationMs: 0,
        };
      },
    };
    const repoPath = await mkdtemp(join(tmpdir(), "ordin-empty-repo-"));
    const harness = new HarnessRuntime({
      root,
      runtimes: new Map([["ai-sdk", tripwireRuntime]]),
      gateForKind: () => new AutoGate(),
    });

    // Start at build, which declares the RFC as a required input — but
    // the workspace is empty, so the phase should fail before runtime.
    const meta = await harness.startRun({
      task: "Skip plan",
      slug: "skip-plan",
      repoPath,
      tier: "M",
      onlyPhases: ["build"],
    });

    expect(invoked).toBe(0);
    expect(meta.status).toBe("failed");
    expect(meta.phases[0]?.status).toBe("failed");
    expect(meta.phases[0]?.error).toMatch(/declared inputs that are missing on disk/);
    expect(meta.phases[0]?.error).toContain("docs/rfcs/skip-plan-rfc.md");
    // Pre-runtime failures don't have a runtime/model decided.
    expect(meta.phases[0]?.runtime).toBeUndefined();
    expect(meta.phases[0]?.model).toBeUndefined();
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
