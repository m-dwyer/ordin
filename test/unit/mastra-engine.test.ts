import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Agent } from "../../src/domain/agent";
import { HarnessConfig } from "../../src/domain/config";
import type { Skill } from "../../src/domain/skill";
import { type Workflow, WorkflowLoader } from "../../src/domain/workflow";
import { AutoGate } from "../../src/gates/auto";
import type { Gate, GateContext, GateDecision } from "../../src/gates/types";
import type { EngineServices } from "../../src/orchestrator/engine";
import type { RunEvent } from "../../src/orchestrator/events";
import { MastraEngine } from "../../src/orchestrator/mastra";
import { PhaseRunner } from "../../src/orchestrator/phase-runner";
import { RunStore } from "../../src/orchestrator/run-store";
import type {
  AgentRuntime,
  InvokeRequest,
  InvokeResult,
  RuntimeCapabilities,
} from "../../src/runtimes/types";

/**
 * Behaviour parity between MastraEngine and SequentialEngine. Scenarios
 * are deliberately the same as `orchestrator.test.ts` — we want proof
 * that the swap doesn't change observable outputs.
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

class QueuedGate implements Gate {
  readonly kind = "human";
  constructor(private readonly queue: GateDecision[]) {}
  async request(_ctx: GateContext): Promise<GateDecision> {
    const next = this.queue.shift();
    if (!next) throw new Error("QueuedGate exhausted");
    return next;
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
phases:
  - { id: plan, agent: planner, runtime: fake, gate: human }
  - { id: build, agent: builder, runtime: fake, gate: human }
  - { id: review, agent: reviewer, runtime: fake, gate: human, on_reject: { goto: build, max_iterations: 2 } }
`;

const TEST_CONFIG_YAML = `phases:
  plan:
    model: m
    allowed_tools: []
  build:
    model: m
    allowed_tools: []
  review:
    model: m
    allowed_tools: []
`;

const fakeAgent = (name: string): Agent => ({
  name,
  runtime: "fake",
  body: `system prompt for ${name}`,
  source: `/virtual/${name}.md`,
});

interface Harness {
  readonly workflow: Workflow;
  readonly config: HarnessConfig;
  readonly agents: Map<string, Agent>;
  readonly skills: Map<string, Skill>;
  readonly runStore: RunStore;
}

async function makeHarness(): Promise<Harness> {
  const workflow = await new WorkflowLoader().load(await writeTempYaml(TEST_WORKFLOW_YAML));
  const configPath = await writeTempYaml(TEST_CONFIG_YAML);
  const config = await HarnessConfig.load(configPath);
  const agents = new Map<string, Agent>([
    ["planner", fakeAgent("planner")],
    ["builder", fakeAgent("builder")],
    ["reviewer", fakeAgent("reviewer")],
  ]);
  const skills = new Map<string, Skill>();
  const runsDir = await mkdtemp(join(tmpdir(), "mastra-runs-"));
  const runStore = new RunStore(runsDir);
  return { workflow, config, agents, skills, runStore };
}

function makeServices(harness: Harness, runtime: AgentRuntime, gate: Gate): EngineServices {
  return {
    phaseRunner: new PhaseRunner({
      config: harness.config,
      agents: harness.agents,
      skills: harness.skills,
      runtimes: new Map([[runtime.name, runtime]]),
    }),
    gateFor: () => gate,
    runStore: harness.runStore,
  };
}

describe("MastraEngine", () => {
  let runtime: FakeRuntime;

  beforeEach(() => {
    runtime = new FakeRuntime();
  });

  it("runs phases in order when every gate approves", async () => {
    const harness = await makeHarness();
    const gate = new QueuedGate([
      { status: "approved" },
      { status: "approved" },
      { status: "approved" },
    ]);

    const events: RunEvent[] = [];
    const engine = new MastraEngine(makeServices(harness, runtime, gate));

    const meta = await engine.run({
      workflow: harness.workflow,
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
          t === "phase.completed" ||
          t === "gate.requested" ||
          t === "gate.decided",
      );
    expect(lifecycleTypes).toEqual([
      "run.started",
      "phase.started",
      "phase.completed",
      "gate.requested",
      "gate.decided",
      "phase.started",
      "phase.completed",
      "gate.requested",
      "gate.decided",
      "phase.started",
      "phase.completed",
      "gate.requested",
      "gate.decided",
      "run.completed",
    ]);
  });

  it("follows Review→Build back-edge on rejection and passes structured feedback", async () => {
    const harness = await makeHarness();
    const gate = new QueuedGate([
      { status: "approved" }, // plan
      { status: "approved" }, // build #1
      { status: "rejected", reason: "tests missing" }, // review #1 → build #2
      { status: "approved" }, // build #2
      { status: "approved" }, // review #2
    ]);

    const engine = new MastraEngine(makeServices(harness, runtime, gate));
    const meta = await engine.run({
      workflow: harness.workflow,
      task: "t",
      slug: "t",
      workspaceRoot: "/tmp/repo",
      tier: "M",
    });

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
    const gate = new QueuedGate([
      { status: "approved" }, // plan
      { status: "approved" }, // build #1
      { status: "rejected", reason: "r1" }, // review #1 → build #2
      { status: "approved" }, // build #2
      { status: "rejected", reason: "r2" }, // review #2 → would be build #3 (blocked)
    ]);

    const engine = new MastraEngine(makeServices(harness, runtime, gate));
    const meta = await engine.run({
      workflow: harness.workflow,
      task: "t",
      slug: "t",
      workspaceRoot: "/tmp/repo",
      tier: "M",
    });

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
    const engine = new MastraEngine(makeServices(harness, runtime, new AutoGate()));

    const meta = await engine.run({
      workflow: harness.workflow,
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
    // Build rejects but has no on_reject → halt without retry.
    const gate = new QueuedGate([
      { status: "approved" }, // plan
      { status: "rejected", reason: "build no good" }, // build
    ]);
    const engine = new MastraEngine(makeServices(harness, runtime, gate));
    const meta = await engine.run({
      workflow: harness.workflow,
      task: "t",
      slug: "t",
      workspaceRoot: "/tmp/repo",
      tier: "M",
    });
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
    const harness = await makeHarness();
    const engine = new MastraEngine(
      makeServices({ ...harness, workflow }, runtime, new AutoGate()),
    );
    // Compile error surfaces inside engine.run — wrapped try/catch converts
    // unknown throws to rethrow, so this should reject.
    await expect(
      engine.run({
        workflow,
        task: "t",
        slug: "t",
        workspaceRoot: "/tmp/repo",
        tier: "M",
      }),
    ).rejects.toThrow(/at most one on_reject/);
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
    const harness = await makeHarness();
    const engine = new MastraEngine(
      makeServices({ ...harness, workflow }, runtime, new AutoGate()),
    );
    const meta = await engine.run({
      workflow,
      task: "t",
      slug: "t",
      workspaceRoot: "/tmp/repo",
      tier: "M",
    });
    expect(meta.status).toBe("completed");
    expect(meta.phases.map((p) => p.phaseId)).toEqual(["plan", "build"]);
  });
});
