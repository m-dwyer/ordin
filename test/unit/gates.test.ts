import { describe, expect, it, vi } from "vitest";
import { AutoGate } from "../../src/gates/auto";
import { HumanGate } from "../../src/gates/human";
import type { GateContext, GateDecision, GatePrompter } from "../../src/gates/types";

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

describe("HumanGate", () => {
  const ctx: GateContext = {
    runId: "r",
    phaseId: "plan",
    cwd: "/x",
    artefacts: [{ label: "RFC", path: "docs/rfcs/x-rfc.md" }],
    summary: "duration: 1.0s",
  };

  it("delegates to the injected prompter and returns its decision verbatim", async () => {
    const decision: GateDecision = { status: "approved", note: "lgtm" };
    const prompter: GatePrompter = { prompt: vi.fn().mockResolvedValue(decision) };
    const gate = new HumanGate(prompter);

    const result = await gate.request(ctx);

    expect(result).toBe(decision);
    expect(prompter.prompt).toHaveBeenCalledWith(ctx);
    expect(gate.kind).toBe("human");
  });

  it("propagates rejection decisions without transformation", async () => {
    const decision: GateDecision = { status: "rejected", reason: "tests missing" };
    const prompter: GatePrompter = { prompt: async () => decision };
    const gate = new HumanGate(prompter);

    await expect(gate.request(ctx)).resolves.toBe(decision);
  });

  it("propagates prompter errors", async () => {
    const prompter: GatePrompter = {
      prompt: async () => {
        throw new Error("prompter crashed");
      },
    };
    const gate = new HumanGate(prompter);

    await expect(gate.request(ctx)).rejects.toThrow("prompter crashed");
  });
});
