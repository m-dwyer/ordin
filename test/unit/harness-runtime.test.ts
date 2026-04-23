import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AutoGate } from "../../src/gates/auto";
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
  it("passes phase-specific artefact inputs through a full run", async () => {
    const root = await makeHarnessRoot();
    const runtime = new FakeRuntime();
    const harness = new HarnessRuntime({
      root,
      runtimes: new Map([["claude-cli", runtime]]),
      gateForKind: () => new AutoGate(),
    });

    await harness.startRun({
      task: "Ship feature x",
      slug: "ship-feature-x",
      repoPath: "/tmp/repo",
      tier: "M",
    });

    expect(runtime.invocations.map((i) => i.prompt.phaseId)).toEqual(["plan", "build", "review"]);

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
    `runtime:
  default: claude-cli
  claude_cli:
    bin: claude
    runs_dir: ${join(root, "runs")}
phases:
  plan:
    model: m
    allowed_tools: []
  build:
    model: m
    allowed_tools: []
  review:
    model: m
    allowed_tools: []
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
phases:
  - { id: plan, agent: planner, runtime: claude-cli, gate: human }
  - { id: build, agent: build-local, runtime: claude-cli, gate: human }
  - { id: review, agent: reviewer, runtime: claude-cli, gate: human }
`,
  );
  await write(join(root, "projects.yaml"), "projects: {}\n");

  await write(
    join(root, "agents", "planner.md"),
    `---
name: planner
runtime: claude-cli
---

Planner prompt.
`,
  );
  await write(
    join(root, "agents", "build-local.md"),
    `---
name: build-local
runtime: claude-cli
---

Build prompt.
`,
  );
  await write(
    join(root, "agents", "reviewer.md"),
    `---
name: reviewer
runtime: claude-cli
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
