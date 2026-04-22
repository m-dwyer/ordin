import { describe, expect, it } from "vitest";
import type { Agent } from "../../src/domain/agent";
import { Composer } from "../../src/domain/composer";
import type { Phase } from "../../src/domain/workflow";

const phase: Phase = {
  id: "plan",
  agent: "planner",
  runtime: "claude-cli",
  gate: "human",
  fresh_context: true,
};

const agent: Agent = {
  name: "planner",
  runtime: "claude-cli",
  body: "You are a planner.",
  source: "/tmp/agents/planner.md",
};

describe("Composer", () => {
  const composer = new Composer();

  it("uses harness.config defaults when agent frontmatter omits them", () => {
    const out = composer.compose({
      phase,
      agent,
      defaults: { model: "claude-opus-4-7", allowedTools: ["Read", "Grep"] },
      task: "plan a thing",
      cwd: "/repo",
      tier: "M",
    });
    expect(out.model).toBe("claude-opus-4-7");
    expect(out.tools).toEqual(["Read", "Grep"]);
    expect(out.systemPrompt).toBe("You are a planner.");
    expect(out.userPrompt).toContain("plan a thing");
    expect(out.tier).toBe("M");
  });

  it("lets agent frontmatter override defaults", () => {
    const out = composer.compose({
      phase,
      agent: { ...agent, model: "claude-sonnet-4-6", tools: ["Read"] },
      defaults: { model: "claude-opus-4-7", allowedTools: ["Read", "Grep", "Write"] },
      task: "plan",
      cwd: "/repo",
      tier: "L",
    });
    expect(out.model).toBe("claude-sonnet-4-6");
    expect(out.tools).toEqual(["Read"]);
  });

  it("carries the tier through to the ComposedPrompt", () => {
    const out = composer.compose({
      phase,
      agent,
      defaults: { model: "m", allowedTools: [] },
      task: "t",
      cwd: "/repo",
      tier: "S",
    });
    expect(out.tier).toBe("S");
  });

  it("renders artefact inputs, outputs, skills, and iteration context into the prompt", () => {
    const out = composer.compose({
      phase,
      agent,
      defaults: { model: "x", allowedTools: [] },
      task: "t",
      cwd: "/repo",
      tier: "M",
      artefactInputs: [{ label: "Brief", path: "problem.md" }],
      artefactOutputs: [{ label: "RFC", path: "docs/rfcs/t-rfc.md" }],
      skills: [{ name: "rfc-template", description: "RFC structure" }],
      iterationContext: "Previous review said X",
    });
    expect(out.userPrompt).toContain("Brief");
    expect(out.userPrompt).toContain("problem.md");
    expect(out.userPrompt).toContain("docs/rfcs/t-rfc.md");
    expect(out.userPrompt).toContain("rfc-template");
    expect(out.userPrompt).toContain("Previous review said X");
  });
});
