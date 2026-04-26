import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "../../src/domain/agent";
import type { HarnessConfig } from "../../src/domain/config";
import type { Workflow } from "../../src/domain/workflow";
import type { GateDecision } from "../../src/gates/types";
import { HarnessConfigLoader } from "../../src/infrastructure/config-loader";
import { WorkflowLoader } from "../../src/infrastructure/workflow-loader";
import type { EngineServices, GateRequest } from "../../src/orchestrator/engine";
import type { RunEvent } from "../../src/orchestrator/events";
import { MastraEngine } from "../../src/orchestrator/mastra";
import { type RunMeta, RunStore } from "../../src/orchestrator/run-store";
import type {
  AgentRuntime,
  InvokeRequest,
  InvokeResult,
  RuntimeCapabilities,
} from "../../src/runtimes/types";

/**
 * Verifies MastraEngine drives topology correctly: phase ordering,
 * `on_reject` back-edges, retry caps, failure halting, compile-time
 * topology validation, and the linear-vs-loop plan path. Gate decisions
 * are inputs that select which topology path the test exercises —
 * each test inlines a phase-keyed callback expressing intent.
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
  result: InvokeResult = {
    status: "ok",
    exitCode: 0,
    transcriptPath: "/tmp/transcript.jsonl",
    tokens: { input: 10, output: 20, cacheReadInput: 0, cacheCreationInput: 0 },
    durationMs: 100,
  };

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    this.invocations.push(req);
    return this.result;
  }
}

async function writeTempYaml(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mastra-engine-"));
  const path = join(dir, "f.yaml");
  await writeFile(path, contents, "utf8");
  return path;
}

const TEST_WORKFLOW_YAML = `name: t
version: 1
runtime: fake
model: m
phases:
  - { id: plan, agent: planner, gate: human, allowed_tools: [] }
  - { id: build, agent: builder, gate: human, allowed_tools: [] }
  - { id: review, agent: reviewer, gate: human, allowed_tools: [], on_reject: { goto: build, max_iterations: 2 } }
`;

const TEST_CONFIG_YAML = `default_model: m
allowed_tools: []
`;

const fakeAgent = (name: string): Agent => ({
  name,
  runtime: "fake",
  body: `system prompt for ${name}`,
  source: `/virtual/${name}.md`,
  skills: [],
});

interface Harness {
  readonly workflow: Workflow;
  readonly config: HarnessConfig;
  readonly agents: Map<string, Agent>;
  readonly runStore: RunStore;
}

async function makeHarness(): Promise<Harness> {
  const workflow = await new WorkflowLoader().load(await writeTempYaml(TEST_WORKFLOW_YAML));
  const configPath = await writeTempYaml(TEST_CONFIG_YAML);
  const config = await new HarnessConfigLoader().load(configPath);
  const agents = new Map<string, Agent>([
    ["planner", fakeAgent("planner")],
    ["builder", fakeAgent("builder")],
    ["reviewer", fakeAgent("reviewer")],
  ]);
  const runsDir = await mkdtemp(join(tmpdir(), "mastra-runs-"));
  const runStore = new RunStore(runsDir);
  return { workflow, config, agents, runStore };
}

function makeServices(harness: Harness, runtime: AgentRuntime): EngineServices {
  return {
    config: harness.config,
    agents: harness.agents,
    runtimes: new Map([[runtime.name, runtime]]),
    runStore: harness.runStore,
  };
}

async function runWithMastra(
  harness: Harness,
  runtime: AgentRuntime,
  onGateRequested: (request: GateRequest) => Promise<GateDecision>,
  input: {
    readonly task?: string;
    readonly slug?: string;
    readonly workspaceRoot?: string;
    readonly tier?: "S" | "M" | "L";
    readonly onEvent?: (event: RunEvent) => void;
  } = {},
): Promise<RunMeta> {
  const engine = new MastraEngine();
  const program = engine.compile(harness.workflow);
  return engine.run(
    program,
    {
      task: input.task ?? "t",
      slug: input.slug ?? "t",
      workspaceRoot: input.workspaceRoot ?? "/tmp/repo",
      tier: input.tier ?? "M",
      onGateRequested,
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    },
    makeServices(harness, runtime),
  );
}

describe("MastraEngine", () => {
  let runtime: FakeRuntime;

  beforeEach(() => {
    runtime = new FakeRuntime();
  });

  it("runs phases in order when every gate approves", async () => {
    const harness = await makeHarness();

    const events: RunEvent[] = [];
    const meta = await runWithMastra(harness, runtime, async () => ({ status: "approved" }), {
      task: "do the thing",
      slug: "do-thing",
      workspaceRoot: "/tmp/repo",
      tier: "M",
      onEvent: (e) => events.push(e),
    });

    expect(meta.status).toBe("completed");
    expect(meta.phases.map((p) => p.phaseId)).toEqual(["plan", "build", "review"]);
    expect(meta.phases.every((p) => p.iteration === 1)).toBe(true);
    expect(meta.phases.every((p) => p.gateDecision === "approved")).toBe(true);
    expect(runtime.invocations.map((i) => i.prompt.phaseId)).toEqual(["plan", "build", "review"]);

    const lifecycleTypes = events
      .map((e) => e.type)
      .filter(
        (t) =>
          t === "run.started" ||
          t === "run.completed" ||
          t === "phase.started" ||
          t === "phase.runtime.completed" ||
          t === "phase.completed" ||
          t === "gate.requested" ||
          t === "gate.decided",
      );
    expect(lifecycleTypes).toEqual([
      "run.started",
      "phase.started",
      "phase.runtime.completed",
      "gate.requested",
      "gate.decided",
      "phase.completed",
      "phase.started",
      "phase.runtime.completed",
      "gate.requested",
      "gate.decided",
      "phase.completed",
      "phase.started",
      "phase.runtime.completed",
      "gate.requested",
      "gate.decided",
      "phase.completed",
      "run.completed",
    ]);
  });

  it("follows Review→Build back-edge on rejection and passes structured feedback", async () => {
    const harness = await makeHarness();
    let reviewCount = 0;

    const meta = await runWithMastra(
      harness,
      runtime,
      async (req) => {
        if (req.phaseId === "review" && ++reviewCount === 1) {
          return { status: "rejected", reason: "tests missing" };
        }
        return { status: "approved" };
      },
      { task: "t", slug: "t", workspaceRoot: "/tmp/repo", tier: "M" },
    );

    expect(meta.status).toBe("completed");
    expect(meta.phases.map((p) => `${p.phaseId}#${p.iteration}`)).toEqual([
      "plan#1",
      "build#1",
      "review#1",
      "build#2",
      "review#2",
    ]);

    const secondBuild = runtime.invocations[3];
    expect(secondBuild?.prompt.phaseId).toBe("build");
    expect(secondBuild?.prompt.userPrompt).toContain("Rejection from review");
    expect(secondBuild?.prompt.userPrompt).toContain("tests missing");
  });

  it("halts when max_iterations is exceeded", async () => {
    const harness = await makeHarness();

    const meta = await runWithMastra(
      harness,
      runtime,
      async (req) =>
        req.phaseId === "review"
          ? { status: "rejected", reason: "always rejects" }
          : { status: "approved" },
      { task: "t", slug: "t", workspaceRoot: "/tmp/repo", tier: "M" },
    );

    expect(meta.status).toBe("halted");
    const buildIterations = meta.phases.filter((p) => p.phaseId === "build").length;
    expect(buildIterations).toBe(2);
  });

  it("records failure and stops when the runtime returns failed", async () => {
    const harness = await makeHarness();
    runtime.result = {
      status: "failed",
      exitCode: 1,
      transcriptPath: "/tmp/t.jsonl",
      tokens: { input: 0, output: 0, cacheReadInput: 0, cacheCreationInput: 0 },
      durationMs: 50,
      error: "claude crashed",
    };

    const meta = await runWithMastra(harness, runtime, async () => ({ status: "approved" }), {
      task: "t",
      slug: "t",
      workspaceRoot: "/tmp/repo",
      tier: "M",
    });

    expect(meta.status).toBe("failed");
    expect(meta.phases).toHaveLength(1);
    expect(meta.phases[0]?.status).toBe("failed");
    expect(meta.phases[0]?.error).toBe("claude crashed");
  });

  it("halts when a non-rejecter phase gate rejects (no on_reject back-edge)", async () => {
    const harness = await makeHarness();

    const meta = await runWithMastra(
      harness,
      runtime,
      async (req) =>
        req.phaseId === "build"
          ? { status: "rejected", reason: "build no good" }
          : { status: "approved" },
      { task: "t", slug: "t", workspaceRoot: "/tmp/repo", tier: "M" },
    );

    expect(meta.status).toBe("halted");
    expect(meta.phases.map((p) => p.phaseId)).toEqual(["plan", "build"]);
  });

  it("throws at compile time for multiple on_reject phases", async () => {
    const workflow = await new WorkflowLoader().load(
      await writeTempYaml(
        `name: multi
version: 1
phases:
  - { id: a, agent: planner, runtime: fake, gate: human, on_reject: { goto: a, max_iterations: 2 } }
  - { id: b, agent: planner, runtime: fake, gate: human, on_reject: { goto: a, max_iterations: 2 } }
`,
      ),
    );
    expect(() => new MastraEngine().compile(workflow)).toThrow(/at most one on_reject/);
  });

  it("preview() returns composed prompts for every phase without invoking the runtime", async () => {
    const harness = await makeHarness();
    const engine = new MastraEngine();
    const program = engine.compile(harness.workflow);
    const previews = await engine.preview(
      program,
      {
        task: "preview only",
        slug: "preview-only",
        workspaceRoot: "/tmp/repo",
        tier: "M",
      },
      { config: harness.config, agents: harness.agents },
    );

    expect(previews.map((p) => p.phase.id)).toEqual(["plan", "build", "review"]);
    expect(previews.every((p) => p.runtimeName === "fake")).toBe(true);
    expect(previews.every((p) => p.prompt.userPrompt.includes("preview only"))).toBe(true);
    // No runtime was invoked because preview never touches one.
    expect(runtime.invocations).toHaveLength(0);
  });

  it("runs a linear workflow with no on_reject back-edge", async () => {
    const workflow = await new WorkflowLoader().load(
      await writeTempYaml(
        `name: linear
version: 1
phases:
  - { id: plan, agent: planner, runtime: fake, gate: auto }
  - { id: build, agent: builder, runtime: fake, gate: auto }
`,
      ),
    );
    const harness = { ...(await makeHarness()), workflow };
    const meta = await runWithMastra(harness, runtime, async () => ({ status: "approved" }), {
      task: "t",
      slug: "t",
      workspaceRoot: "/tmp/repo",
      tier: "M",
    });
    expect(meta.status).toBe("completed");
    expect(meta.phases.map((p) => p.phaseId)).toEqual(["plan", "build"]);
  });
});
