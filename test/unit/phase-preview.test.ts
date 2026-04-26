import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/domain/agent";
import { HarnessConfig } from "../../src/domain/config";
import { PhasePreparer } from "../../src/domain/phase-preview";
import { WorkflowManifest } from "../../src/domain/workflow";

const agent: Agent = {
  name: "planner",
  runtime: "agent-runtime",
  body: "Plan.",
  source: "/tmp/agents/planner.md",
  skills: [],
};

const config = new HarnessConfig(
  { base_dir: "/tmp/runs" },
  "default-runtime",
  "default-model",
  [],
  {},
  { S: {}, M: {}, L: {} },
);

describe("PhasePreparer", () => {
  it("resolves runtime precedence from phase, workflow, agent, then config default", () => {
    const preparer = new PhasePreparer();
    const phase = { id: "plan", agent: "planner", gate: "auto" as const };

    const withWorkflow = preparer.prepare({
      phase,
      agent,
      workflow: new WorkflowManifest({
        name: "wf",
        version: "1",
        runtime: "workflow-runtime",
        phases: [phase],
      }),
      config,
      task: "t",
      cwd: "/repo",
      tier: "M",
      artefactInputs: [],
      artefactOutputs: [],
    });
    expect(withWorkflow.runtimeName).toBe("workflow-runtime");

    const withPhase = preparer.prepare({
      phase: { ...phase, runtime: "phase-runtime" },
      agent,
      workflow: new WorkflowManifest({
        name: "wf",
        version: "1",
        runtime: "workflow-runtime",
        phases: [{ ...phase, runtime: "phase-runtime" }],
      }),
      config,
      task: "t",
      cwd: "/repo",
      tier: "M",
      artefactInputs: [],
      artefactOutputs: [],
    });
    expect(withPhase.runtimeName).toBe("phase-runtime");

    const withAgent = preparer.prepare({
      phase,
      agent,
      workflow: new WorkflowManifest({ name: "wf", version: "1", phases: [phase] }),
      config,
      task: "t",
      cwd: "/repo",
      tier: "M",
      artefactInputs: [],
      artefactOutputs: [],
    });
    expect(withAgent.runtimeName).toBe("agent-runtime");

    const withDefault = preparer.prepare({
      phase,
      agent: { ...agent, runtime: undefined },
      workflow: new WorkflowManifest({ name: "wf", version: "1", phases: [phase] }),
      config,
      task: "t",
      cwd: "/repo",
      tier: "M",
      artefactInputs: [],
      artefactOutputs: [],
    });
    expect(withDefault.runtimeName).toBe("default-runtime");
  });
});
