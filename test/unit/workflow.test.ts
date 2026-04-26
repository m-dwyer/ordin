import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePhaseRuntime } from "../../src/domain/workflow";
import { WorkflowLoader } from "../../src/infrastructure/workflow-loader";
import { compileWorkflowPlan } from "../../src/orchestrator/workflow-plan";

async function writeTempYaml(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "harness-wf-"));
  const path = join(dir, "wf.yaml");
  await writeFile(path, contents, "utf8");
  return path;
}

describe("WorkflowLoader", () => {
  const loader = new WorkflowLoader();

  it("loads a valid workflow and exposes phase helpers", async () => {
    const path = await writeTempYaml(
      `name: t
version: 1
phases:
  - { id: plan, agent: p, runtime: claude-cli, gate: human }
  - { id: build, agent: b, runtime: claude-cli, gate: human }
  - { id: review, agent: r, runtime: claude-cli, gate: human, on_reject: { goto: build, max_iterations: 2 } }
`,
    );
    const wf = await loader.load(path);
    expect(wf.firstPhase().id).toBe("plan");
    expect(wf.nextPhase("plan")?.id).toBe("build");
    expect(wf.nextPhase("review")).toBeUndefined();
    expect(wf.findPhase("review").on_reject?.goto).toBe("build");
  });

  it("supports workflow-level runtime with phase overrides", async () => {
    const path = await writeTempYaml(
      `name: t
version: 1
runtime: ai-sdk
phases:
  - { id: plan, agent: p, gate: human }
  - { id: review, agent: r, runtime: claude-cli, gate: human }
`,
    );
    const wf = await loader.load(path);

    expect(wf.runtime).toBe("ai-sdk");
    expect(resolvePhaseRuntime(wf.findPhase("plan"), wf, undefined, "fallback")).toBe("ai-sdk");
    expect(resolvePhaseRuntime(wf.findPhase("review"), wf, undefined, "fallback")).toBe(
      "claude-cli",
    );
  });

  it("uses agent runtime when phase and workflow do not override it", async () => {
    const path = await writeTempYaml(
      `name: t
version: 1
phases:
  - { id: plan, agent: p, gate: human }
  - { id: review, agent: r, runtime: claude-cli, gate: human }
`,
    );
    const wf = await loader.load(path);

    expect(resolvePhaseRuntime(wf.findPhase("plan"), wf, "agent-runtime", "fallback")).toBe(
      "agent-runtime",
    );
    expect(resolvePhaseRuntime(wf.findPhase("review"), wf, "agent-runtime", "fallback")).toBe(
      "claude-cli",
    );
  });

  it("loads duplicate phase ids for the workflow compiler to reject", async () => {
    const path = await writeTempYaml(
      `name: t
version: 1
phases:
  - { id: x, agent: a, runtime: claude-cli, gate: human }
  - { id: x, agent: a, runtime: claude-cli, gate: human }
`,
    );
    const wf = await loader.load(path);
    expect(wf.phases.map((phase) => phase.id)).toEqual(["x", "x"]);
  });

  it("loads unresolved on_reject targets for the workflow compiler to reject", async () => {
    const path = await writeTempYaml(
      `name: t
version: 1
phases:
  - { id: plan, agent: a, runtime: claude-cli, gate: human, on_reject: { goto: nope, max_iterations: 1 } }
`,
    );
    const wf = await loader.load(path);
    expect(wf.findPhase("plan").on_reject?.goto).toBe("nope");
  });

  describe("slicing", () => {
    async function threePhase() {
      const path = await writeTempYaml(
        `name: t
version: 1
phases:
  - { id: plan, agent: a, runtime: claude-cli, gate: human }
  - { id: build, agent: b, runtime: claude-cli, gate: human }
  - { id: review, agent: r, runtime: claude-cli, gate: human, on_reject: { goto: build, max_iterations: 2 } }
`,
      );
      return loader.load(path);
    }

    it("startingAt returns the same workflow when starting at the first phase", async () => {
      const wf = await threePhase();
      expect(wf.startingAt("plan")).toBe(wf);
    });

    it("startingAt drops earlier phases", async () => {
      const wf = await threePhase();
      const sliced = wf.startingAt("build");
      expect(sliced.phases.map((p) => p.id)).toEqual(["build", "review"]);
      expect(sliced.findPhase("review").on_reject?.goto).toBe("build");
      expect(compileWorkflowPlan(sliced).kind).toBe("single-retry-loop");
    });

    it("startingAt strips on_reject when the target was skipped", async () => {
      const wf = await threePhase();
      const sliced = wf.startingAt("review");
      expect(sliced.phases.map((p) => p.id)).toEqual(["review"]);
      expect(sliced.findPhase("review").on_reject).toBeUndefined();
      expect(compileWorkflowPlan(sliced).kind).toBe("linear");
    });

    it("startingAt throws on an unknown phase", async () => {
      const wf = await threePhase();
      expect(() => wf.startingAt("nope")).toThrow(/"nope" not found/);
    });

    it("only() keeps phases in workflow order", async () => {
      const wf = await threePhase();
      const filtered = wf.only(["review", "plan"]);
      expect(filtered.phases.map((p) => p.id)).toEqual(["plan", "review"]);
    });

    it("only() strips on_reject pointing outside the selection", async () => {
      const wf = await threePhase();
      const filtered = wf.only(["review"]);
      expect(filtered.findPhase("review").on_reject).toBeUndefined();
      expect(compileWorkflowPlan(filtered).kind).toBe("linear");
    });

    it("only() preserves on_reject when the target is still present", async () => {
      const wf = await threePhase();
      const filtered = wf.only(["build", "review"]);
      expect(filtered.findPhase("review").on_reject?.goto).toBe("build");
      expect(compileWorkflowPlan(filtered).kind).toBe("single-retry-loop");
    });

    it("only() throws if no phases match", async () => {
      const wf = await threePhase();
      expect(() => wf.only(["ghost"])).toThrow(/No matching phases/);
    });
  });
});
