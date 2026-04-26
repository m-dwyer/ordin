import { describe, expect, it } from "vitest";
import { WorkflowManifest } from "../../src/domain/workflow";
import { type Engine, EngineRegistry } from "../../src/orchestrator/engine";
import {
  collectWorkflowDiagnostics,
  compileWorkflowPlan,
  WorkflowValidationError,
} from "../../src/orchestrator/workflow-plan";

describe("compileWorkflowPlan", () => {
  it("keeps linear topology explicit", () => {
    const plan = compileWorkflowPlan(
      new WorkflowManifest({
        name: "linear",
        version: "1",
        phases: [
          { id: "plan", agent: "planner", runtime: "fake", gate: "auto" },
          { id: "build", agent: "builder", runtime: "fake", gate: "auto" },
        ],
      }),
    );

    expect(plan.kind).toBe("linear");
    if (plan.kind === "linear") {
      expect(plan.phases.map((phase) => phase.id)).toEqual(["plan", "build"]);
    }
  });

  it("extracts a single retry loop into neutral topology", () => {
    const plan = compileWorkflowPlan(
      new WorkflowManifest({
        name: "with-loop",
        version: "1",
        phases: [
          { id: "plan", agent: "planner", runtime: "fake", gate: "auto" },
          { id: "build", agent: "builder", runtime: "fake", gate: "auto" },
          {
            id: "review",
            agent: "reviewer",
            runtime: "fake",
            gate: "human",
            on_reject: { goto: "build", max_iterations: 2 },
          },
          { id: "ship", agent: "shipper", runtime: "fake", gate: "auto" },
        ],
      }),
    );

    expect(plan.kind).toBe("single-retry-loop");
    if (plan.kind === "single-retry-loop") {
      expect(plan.beforeLoop.map((phase) => phase.id)).toEqual(["plan"]);
      expect(plan.loop.map((phase) => phase.id)).toEqual(["build", "review"]);
      expect(plan.afterLoop.map((phase) => phase.id)).toEqual(["ship"]);
      expect(plan.rejecter.id).toBe("review");
      expect(plan.maxIterations).toBe(2);
    }
  });

  it("rejects unsupported topology at compile time", () => {
    const manifest = new WorkflowManifest({
      name: "multi",
      version: "1",
      phases: [
        {
          id: "a",
          agent: "agent",
          runtime: "fake",
          gate: "human",
          on_reject: { goto: "a", max_iterations: 1 },
        },
        {
          id: "b",
          agent: "agent",
          runtime: "fake",
          gate: "human",
          on_reject: { goto: "a", max_iterations: 1 },
        },
      ],
    });

    expect(() => compileWorkflowPlan(manifest)).toThrow(/at most one on_reject/);
  });

  it("rejects duplicate phase ids at compile time", () => {
    const manifest = new WorkflowManifest({
      name: "duplicate",
      version: "1",
      phases: [
        { id: "x", agent: "agent", runtime: "fake", gate: "human" },
        { id: "x", agent: "agent", runtime: "fake", gate: "human" },
      ],
    });

    expect(() => compileWorkflowPlan(manifest)).toThrow(WorkflowValidationError);
    expect(collectWorkflowDiagnostics(manifest)).toEqual([
      expect.objectContaining({ code: "duplicate_phase_id", phaseId: "x" }),
    ]);
  });

  it("rejects unresolved on_reject targets at compile time", () => {
    const manifest = new WorkflowManifest({
      name: "missing-target",
      version: "1",
      phases: [
        {
          id: "review",
          agent: "agent",
          runtime: "fake",
          gate: "human",
          on_reject: { goto: "build", max_iterations: 1 },
        },
      ],
    });

    expect(() => compileWorkflowPlan(manifest)).toThrow(/goto="build"/);
    expect(collectWorkflowDiagnostics(manifest)).toEqual([
      expect.objectContaining({ code: "missing_reject_target", phaseId: "review" }),
    ]);
  });

  it("reports invalid forward on_reject targets as diagnostics", () => {
    const manifest = new WorkflowManifest({
      name: "forward",
      version: "1",
      phases: [
        {
          id: "review",
          agent: "agent",
          runtime: "fake",
          gate: "human",
          on_reject: { goto: "build", max_iterations: 1 },
        },
        { id: "build", agent: "agent", runtime: "fake", gate: "human" },
      ],
    });

    expect(collectWorkflowDiagnostics(manifest)).toEqual([
      expect.objectContaining({ code: "invalid_reject_target", phaseId: "review" }),
    ]);
  });
});

describe("EngineRegistry", () => {
  const fakeEngine: Engine = {
    name: "fake",
    compile: (manifest) => ({
      engineName: "fake",
      manifest,
      plan: compileWorkflowPlan(manifest),
    }),
    preview: async () => [],
    run: async () => {
      throw new Error("not implemented");
    },
  };

  it("resolves engines by name", () => {
    const registry = new EngineRegistry([fakeEngine]);
    expect(registry.get("fake")).toBe(fakeEngine);
  });

  it("rejects duplicate engine names", () => {
    expect(() => new EngineRegistry([fakeEngine, fakeEngine])).toThrow(/already registered/);
  });
});
