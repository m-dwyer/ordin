import { beforeAll, describe, expect, it } from "vitest";
import type { Artefact } from "../src/domain/artefact";
import { runPhase } from "./helpers";
import { rubric } from "./judge";

/**
 * Plan-phase evals. Runs the planner against the fixture target repo
 * (calculator library) with seeded tasks, then asserts on the produced
 * RFC. Deterministic checks cover template compliance; rubric checks
 * (LLM-as-judge) cover substance.
 *
 * On failure, rubric() prints the criterion, score, judge's rationale,
 * and artefact path — cat the path to see what the planner produced.
 */

describe("plan: add input validation to the calculator", () => {
  let rfc: Artefact;

  beforeAll(async () => {
    rfc = await runPhase({
      phase: "plan",
      task: "Add input validation to the calculator — reject non-numeric args with a clear error.",
      slug: "plan-add-input-validation",
      tier: "S",
    });
  });

  it("produces an RFC with all required sections", () => {
    for (const heading of ["summary", "problem", "options", "recommendation", "work breakdown", "risks"]) {
      expect(rfc.content.toLowerCase()).toMatch(new RegExp(`^##\\s+${heading}\\b`, "m"));
    }
  });

  it("addresses the asked-about domain", () => {
    const lower = rfc.content.toLowerCase();
    expect(lower).toMatch(/validation/);
    expect(lower).toMatch(/calculator/);
  });

  it("summary is actionable as a handover to Build", async () => {
    await rubric(
      rfc,
      "Is the Summary section a useful, concrete handover to the Build phase — not just a restatement of the problem?",
    );
  });

  it("recommendation is justified vs. alternatives", async () => {
    await rubric(
      rfc,
      "Does the Recommendation section explain WHY the chosen option beats the alternatives, with concrete reasoning?",
    );
  });

  it("work breakdown is concrete with acceptance criteria", async () => {
    await rubric(
      rfc,
      "Does the Work breakdown contain concrete milestones with acceptance criteria a reviewer could tick off, or is it vague?",
    );
  });
});
