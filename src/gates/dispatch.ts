import type { Phase } from "../domain/workflow";
import type { Gate, GateContext, GateDecision, GatePrompter } from "./types";

/**
 * Approves unconditionally. Used for S-tier runs or when the user
 * explicitly opts out of gating. Never used as a default.
 */
export class AutoGate implements Gate {
  readonly kind = "auto";

  async request(_ctx: GateContext): Promise<GateDecision> {
    return { status: "approved", note: "auto-approved" };
  }
}

/**
 * Human-in-the-loop gate. Business logic only — delegates presentation
 * and input collection to an injected `GatePrompter`. The CLI passes an
 * OpenTUI prompter; a future HTTP/Slack client would pass its own.
 */
export class HumanGate implements Gate {
  readonly kind = "human";

  constructor(private readonly prompter: GatePrompter) {}

  request(ctx: GateContext): Promise<GateDecision> {
    return this.prompter.prompt(ctx);
  }
}

/**
 * A `GatePrompter` that approves every prompt. Used by tests and
 * headless flows that want `human`-gate phases to flow through without
 * adding a `kind`-aware switch in the gate layer.
 */
export class AutoApprovePrompter implements GatePrompter {
  async prompt(_ctx: GateContext): Promise<GateDecision> {
    return { status: "approved", note: "auto-approved" };
  }
}

/**
 * Single source of truth for `Phase["gate"]` → `Gate` mapping. Callers
 * (CLI, run-session, application use cases) construct one with the
 * prompter they have. Omitting the prompter is the strict headless
 * mode: `auto`/`pre-commit` still resolve to `AutoGate`, but `human`
 * fails closed so a caller can't silently ship past a human checkpoint
 * by forgetting to wire a prompter. Tests that want human-gates to
 * auto-approve pass an `AutoApprovePrompter`.
 */
export class GateResolver {
  constructor(private readonly prompter?: GatePrompter) {}

  forKind(kind: Phase["gate"]): Gate {
    switch (kind) {
      case "human":
        if (!this.prompter) {
          throw new Error(
            'Gate kind "human" requires a GatePrompter. Pass one to new GateResolver(...) ' +
              "(CLI wires an OpenTUI prompter; run-session wires a deferred prompter; " +
              "headless callers can pass an AutoApprovePrompter).",
          );
        }
        return new HumanGate(this.prompter);
      case "auto":
      case "pre-commit":
        return new AutoGate();
      default: {
        const _exhaustive: never = kind;
        throw new Error(`Unknown gate kind: ${String(_exhaustive)}`);
      }
    }
  }
}
