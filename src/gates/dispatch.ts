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
 * Single source of truth for `Phase["gate"]` → `Gate` mapping. Callers
 * (CLI, run-session, application use cases) build their resolver here
 * with the prompter they have. Omitting the prompter is the headless
 * mode: `auto`/`pre-commit` still resolve to `AutoGate`, but `human`
 * fails closed so a caller can't silently ship past a human checkpoint
 * by forgetting to wire a prompter.
 */
export function gateResolverFor(prompter?: GatePrompter): (kind: Phase["gate"]) => Gate {
  return (kind) => {
    switch (kind) {
      case "human":
        if (!prompter) {
          throw new Error(
            'Gate kind "human" requires a GatePrompter. Pass one to gateResolverFor ' +
              "(CLI wires an OpenTUI prompter; run-session wires a deferred prompter; " +
              "headless callers should use `auto` gates instead).",
          );
        }
        return new HumanGate(prompter);
      case "auto":
      case "pre-commit":
        return new AutoGate();
      default: {
        const _exhaustive: never = kind;
        throw new Error(`Unknown gate kind: ${String(_exhaustive)}`);
      }
    }
  };
}
