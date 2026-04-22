import { describe, expect, it } from "vitest";
import { AutoGate } from "../../src/gates/auto";

describe("AutoGate", () => {
  it("approves unconditionally", async () => {
    const gate = new AutoGate();
    const decision = await gate.request({
      runId: "r",
      phaseId: "plan",
      cwd: "/x",
      artefacts: [],
    });
    expect(decision.status).toBe("approved");
    expect(gate.kind).toBe("auto");
  });
});
