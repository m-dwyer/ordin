import { describe, expect, it, vi } from "vitest";

// `controller.ts` statically imports @opentui/core (and through it
// @opentui/solid), which eagerly loads tree-sitter highlight assets
// (`*.scm`) that vitest's loader can't parse. These tests don't
// exercise the renderer at all — only the controller's
// RunEvent → state-mutation logic — so we stub the OpenTUI modules
// before importing the controller. vi.mock is hoisted, so the stubs
// are in place before any import resolves.
vi.mock("@opentui/core", () => ({
  ASCIIFontRenderable: class {},
  BoxRenderable: class {},
  CliRenderEvents: { DESTROY: "destroy" },
  createCliRenderer: vi.fn(async () => ({ on: () => {}, destroy: () => {} })),
  measureText: vi.fn(() => ({ width: 0, height: 0 })),
  TextRenderable: class {},
}));
vi.mock("@opentui/solid", () => ({
  render: vi.fn(async () => {}),
}));
// run-app.tsx contains Solid JSX with `jsx: "preserve"` — Vite can't
// parse it without the Solid babel plugin, which we don't load in
// tests. The controller only references RunApp inside mount(), which
// we never call here, so a stub component is fine.
vi.mock("../../src/cli/tui/run-app", () => ({
  RunApp: () => null,
}));

import { OpenTuiRunController } from "../../src/cli/tui/controller";
import type { GateContext } from "../../src/gates/types";
import type { RunEvent } from "../../src/runtime/harness";

/**
 * Tests the controller's event-handling and gate-flow logic without
 * mounting the OpenTUI renderer. The controller constructor only
 * initialises Solid stores/signals; `mount()` is what creates the
 * renderer, and `scrollback()` no-ops when no renderer is attached —
 * so we can drive `pushEvent`/`requestGate`/`decideGate` and assert on
 * `state()` directly.
 *
 * The point of these tests is regression coverage for the
 * RunEvent → ControllerState mapping (the boundary that's most likely
 * to break when the orchestrator's event shape evolves), not for the
 * Solid component layer or the renderer lifecycle.
 */

const RUN_ID = "run-test";

function phaseStarted(phaseId: string, iteration = 1, model = "claude-sonnet-4-6"): RunEvent {
  return {
    type: "phase.started",
    runId: RUN_ID,
    phaseId,
    iteration,
    model,
    runtime: "claude-cli",
  };
}

function gateContext(phaseId: string): GateContext {
  return {
    runId: RUN_ID,
    phaseId,
    cwd: "/tmp/repo",
    artefacts: [{ label: "RFC", path: "docs/rfcs/test-rfc.md" }],
  };
}

describe("OpenTuiRunController", () => {
  describe("phase lifecycle", () => {
    it("starts empty when not mounted with phase ids", () => {
      const controller = new OpenTuiRunController();
      expect(controller.state().phases()).toEqual([]);
    });

    it("phase.started adds a running phase to the list", () => {
      const controller = new OpenTuiRunController();
      controller.pushEvent(phaseStarted("plan"));
      expect(controller.state().phases()).toEqual([
        {
          id: "plan",
          status: "running",
          model: "claude-sonnet-4-6",
          iteration: 1,
          activity: "starting",
        },
      ]);
    });

    it("phase.runtime.completed records totals while the phase awaits post-runtime checks", () => {
      const controller = new OpenTuiRunController();
      controller.pushEvent(phaseStarted("plan"));
      controller.pushEvent({
        type: "phase.runtime.completed",
        runId: RUN_ID,
        phaseId: "plan",
        iteration: 1,
        durationMs: 32_400,
        tokens: { input: 100, output: 1840, cacheReadInput: 0, cacheCreationInput: 0 },
      });

      const phase = controller.state().phases()[0];
      expect(phase?.status).toBe("running");
      expect(phase?.activity).toBe("validating outputs");
      expect(phase?.durationMs).toBe(32_400);
      expect(phase?.tokensIn).toBe(100);
      expect(phase?.tokensOut).toBe(1840);
    });

    it("phase.completed marks the phase done with duration + token totals", () => {
      const controller = new OpenTuiRunController();
      controller.pushEvent(phaseStarted("plan"));
      controller.pushEvent({
        type: "phase.completed",
        runId: RUN_ID,
        phaseId: "plan",
        iteration: 1,
        durationMs: 32_400,
        tokens: { input: 100, output: 1840, cacheReadInput: 0, cacheCreationInput: 0 },
      });

      const phase = controller.state().phases()[0];
      expect(phase?.status).toBe("done");
      expect(phase?.activity).toBeUndefined();
      expect(phase?.durationMs).toBe(32_400);
      expect(phase?.tokensIn).toBe(100);
      expect(phase?.tokensOut).toBe(1840);
    });

    it("phase.failed marks the phase failed and clears activity", () => {
      const controller = new OpenTuiRunController();
      controller.pushEvent(phaseStarted("plan"));
      controller.pushEvent({
        type: "phase.failed",
        runId: RUN_ID,
        phaseId: "plan",
        iteration: 1,
        error: "boom: something exploded",
      });

      const phase = controller.state().phases()[0];
      expect(phase?.status).toBe("failed");
      expect(phase?.activity).toBeUndefined();
    });

    it("phase.started with later iteration updates the existing row in place", () => {
      const controller = new OpenTuiRunController();
      controller.pushEvent(phaseStarted("build", 1));
      controller.pushEvent(phaseStarted("build", 2));

      const phases = controller.state().phases();
      expect(phases).toHaveLength(1);
      expect(phases[0]?.iteration).toBe(2);
      expect(phases[0]?.status).toBe("running");
    });
  });

  describe("agent activity mapping", () => {
    it("agent.thinking sets activity to 'thinking…'", () => {
      const controller = new OpenTuiRunController();
      controller.pushEvent(phaseStarted("plan"));
      controller.pushEvent({ type: "agent.thinking", runId: RUN_ID, phaseId: "plan" });
      expect(controller.state().phases()[0]?.activity).toBe("thinking…");
    });

    it("agent.tool.use sets activity to '<tool> · <preview>'", () => {
      const controller = new OpenTuiRunController();
      controller.pushEvent(phaseStarted("plan"));
      controller.pushEvent({
        type: "agent.tool.use",
        runId: RUN_ID,
        phaseId: "plan",
        id: "t1",
        name: "Read",
        input: { file_path: "src/auth.ts" },
      });
      expect(controller.state().phases()[0]?.activity).toBe("Read · src/auth.ts");
    });

    it("agent.tool.result does NOT reset activity (so fast tools stay readable)", () => {
      const controller = new OpenTuiRunController();
      controller.pushEvent(phaseStarted("plan"));
      controller.pushEvent({
        type: "agent.tool.use",
        runId: RUN_ID,
        phaseId: "plan",
        id: "t1",
        name: "Read",
        input: { file_path: "src/auth.ts" },
      });
      controller.pushEvent({
        type: "agent.tool.result",
        runId: RUN_ID,
        phaseId: "plan",
        id: "t1",
        ok: true,
      });
      expect(controller.state().phases()[0]?.activity).toBe("Read · src/auth.ts");
    });

    it("subsequent agent.thinking reset activity back to 'thinking…'", () => {
      const controller = new OpenTuiRunController();
      controller.pushEvent(phaseStarted("plan"));
      controller.pushEvent({
        type: "agent.tool.use",
        runId: RUN_ID,
        phaseId: "plan",
        id: "t1",
        name: "Bash",
        input: { command: "ls" },
      });
      controller.pushEvent({ type: "agent.thinking", runId: RUN_ID, phaseId: "plan" });
      expect(controller.state().phases()[0]?.activity).toBe("thinking…");
    });
  });

  describe("gate flow", () => {
    it("requestGate moves the phase into 'gate' status and exposes the context", async () => {
      const controller = new OpenTuiRunController();
      controller.pushEvent(phaseStarted("plan"));

      const ctx = gateContext("plan");
      const decisionPromise = controller.requestGate(ctx);

      expect(controller.state().phases()[0]?.status).toBe("gate");
      expect(controller.state().gate()?.ctx).toEqual(ctx);

      // resolve so the test doesn't dangle
      controller.state().decideGate({ status: "approved" });
      await decisionPromise;
    });

    it("decideGate(approved) resolves with the decision and marks phase done", async () => {
      const controller = new OpenTuiRunController();
      controller.pushEvent(phaseStarted("plan"));

      const promise = controller.requestGate(gateContext("plan"));
      controller.state().decideGate({ status: "approved", note: "lgtm" });

      await expect(promise).resolves.toEqual({ status: "approved", note: "lgtm" });
      expect(controller.state().gate()).toBeNull();
      expect(controller.state().phases()[0]?.status).toBe("done");
    });

    it("decideGate(rejected) resolves with the decision and marks phase failed", async () => {
      const controller = new OpenTuiRunController();
      controller.pushEvent(phaseStarted("plan"));

      const promise = controller.requestGate(gateContext("plan"));
      controller.state().decideGate({ status: "rejected", reason: "missing tests" });

      await expect(promise).resolves.toEqual({ status: "rejected", reason: "missing tests" });
      expect(controller.state().gate()).toBeNull();
      expect(controller.state().phases()[0]?.status).toBe("failed");
    });
  });

  describe("noisy lifecycle events", () => {
    // Several RunEvent variants are intentionally swallowed — they
    // either flow through other channels (gate.requested via requestGate)
    // or aren't user-facing (run.started, agent.tokens). Asserting they
    // don't mutate state guards against accidental wiring.
    it("ignores run.started / run.completed / agent.tokens", () => {
      const controller = new OpenTuiRunController();
      controller.pushEvent(phaseStarted("plan"));
      const before = controller.state().phases()[0];

      controller.pushEvent({ type: "run.started", runId: RUN_ID });
      controller.pushEvent({ type: "run.completed", runId: RUN_ID, status: "completed" });
      controller.pushEvent({
        type: "agent.tokens",
        runId: RUN_ID,
        phaseId: "plan",
        usage: { input: 10, output: 20, cacheReadInput: 0, cacheCreationInput: 0 },
      });

      expect(controller.state().phases()[0]).toEqual(before);
    });
  });
});
