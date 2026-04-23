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
import type { RunEvent } from "../../src/orchestrator/events";
import { RunStore } from "../../src/orchestrator/run-store";
import { SequentialOrchestrator } from "../../src/orchestrator/sequential";
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
  const dir = await mkdtemp(join(tmpdir(), "harness-orch-"));
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

async function makeHarness(): Promise<{
  workflow: Workflow;
  config: HarnessConfig;
  agents: Map<string, Agent>;
  skills: Map<string, Skill>;
  runStore: RunStore;
}> {
  const workflow = await new WorkflowLoader().load(await writeTempYaml(TEST_WORKFLOW_YAML));
  const configPath = await writeTempYaml(TEST_CONFIG_YAML);
  const config = await HarnessConfig.load(configPath);
  const agents = new Map<string, Agent>([
    ["planner", fakeAgent("planner")],
    ["builder", fakeAgent("builder")],
    ["reviewer", fakeAgent("reviewer")],
  ]);
  const skills = new Map<string, Skill>();
  const runsDir = await mkdtemp(join(tmpdir(), "harness-runs-"));
  const runStore = new RunStore(runsDir);
  return { workflow, config, agents, skills, runStore };
}

describe("SequentialOrchestrator", () => {
  let runtime: FakeRuntime;

  beforeEach(() => {
    runtime = new FakeRuntime();
  });

  it("runs phases in order when every gate approves", async () => {
    const { workflow, config, agents, skills, runStore } = await makeHarness();
    const gate = new QueuedGate([
      { status: "approved" },
      { status: "approved" },
      { status: "approved" },
    ]);

    const events: RunEvent[] = [];
    const orchestrator = new SequentialOrchestrator({
      workflow,
      config,
      agents,
      skills,
      runtimes: new Map([["fake", runtime]]),
      gateForKind: () => gate,
      runStore,
    });

    const meta = await orchestrator.run({
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

    // Lifecycle events fire in the expected order.
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

  it("follows Review→Build back-edge on rejection and passes context to next Build", async () => {
    const { workflow, config, agents, skills, runStore } = await makeHarness();
    const gate = new QueuedGate([
      { status: "approved" }, // plan
      { status: "approved" }, // build #1
      { status: "rejected", reason: "tests missing" }, // review #1 → back to build
      { status: "approved" }, // build #2
      { status: "approved" }, // review #2
    ]);

    const orchestrator = new SequentialOrchestrator({
      workflow,
      config,
      agents,
      skills,
      runtimes: new Map([["fake", runtime]]),
      gateForKind: () => gate,
      runStore,
    });

    const meta = await orchestrator.run({
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

    // The second Build invocation must carry the rejection reason as
    // iteration context so the agent can address the feedback.
    const secondBuild = runtime.invocations[3];
    expect(secondBuild?.prompt.phaseId).toBe("build");
    expect(secondBuild?.prompt.userPrompt).toContain("tests missing");
  });

  it("halts when max_iterations is exceeded", async () => {
    const { workflow, config, agents, skills, runStore } = await makeHarness();
    // review has max_iterations=2 for the build back-edge. So two builds are allowed;
    // a third review rejection must halt.
    const gate = new QueuedGate([
      { status: "approved" }, // plan
      { status: "approved" }, // build #1
      { status: "rejected", reason: "r1" }, // review #1 → build #2
      { status: "approved" }, // build #2
      { status: "rejected", reason: "r2" }, // review #2 → would be build #3 (blocked)
    ]);

    const orchestrator = new SequentialOrchestrator({
      workflow,
      config,
      agents,
      skills,
      runtimes: new Map([["fake", runtime]]),
      gateForKind: () => gate,
      runStore,
    });

    const meta = await orchestrator.run({
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
    const { workflow, config, agents, skills, runStore } = await makeHarness();
    runtime.result = {
      status: "failed",
      exitCode: 1,
      transcriptPath: "/tmp/t.jsonl",
      tokens: { input: 0, output: 0, cacheReadInput: 0, cacheCreationInput: 0 },
      durationMs: 50,
      error: "claude crashed",
    };
    const gate = new AutoGate();

    const orchestrator = new SequentialOrchestrator({
      workflow,
      config,
      agents,
      skills,
      runtimes: new Map([["fake", runtime]]),
      gateForKind: () => gate,
      runStore,
    });

    const meta = await orchestrator.run({
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

  it("throws a clear error when a phase references an unregistered agent", async () => {
    const { workflow, config, skills, runStore } = await makeHarness();
    const incompleteAgents = new Map<string, Agent>([["planner", fakeAgent("planner")]]);

    const orchestrator = new SequentialOrchestrator({
      workflow,
      config,
      agents: incompleteAgents,
      skills,
      runtimes: new Map([["fake", runtime]]),
      gateForKind: () => new AutoGate(),
      runStore,
    });

    await expect(
      orchestrator.run({ task: "t", slug: "t", workspaceRoot: "/tmp/repo", tier: "M" }),
    ).rejects.toThrow(/Agent "builder" declared by phase "build" not loaded/);
  });

  it("throws when a phase references an unregistered runtime", async () => {
    const { config, agents, skills, runStore } = await makeHarness();
    const workflow = await new WorkflowLoader().load(
      await writeTempYaml(
        `name: t
version: 1
phases:
  - { id: plan, agent: planner, runtime: missing, gate: auto }
`,
      ),
    );

    const orchestrator = new SequentialOrchestrator({
      workflow,
      config,
      agents,
      skills,
      runtimes: new Map([["fake", runtime]]),
      gateForKind: () => new AutoGate(),
      runStore,
    });

    await expect(
      orchestrator.run({ task: "t", slug: "t", workspaceRoot: "/tmp/repo", tier: "M" }),
    ).rejects.toThrow(/Runtime "missing".+not registered/);
  });
});
