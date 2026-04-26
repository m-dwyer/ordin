import type { Phase } from "../domain/workflow";
import { AutoGate } from "./auto";
import { HumanGate } from "./human";
import type { Gate, GatePrompter } from "./types";

/**
 * Single source of truth for `Phase["gate"]` → `Gate` mapping. CLI and
 * RunService both call this with their own prompter; adding a new kind
 * (or moving `pre-commit` away from `AutoGate`) happens once here.
 */
export function gateResolverFor(prompter: GatePrompter): (kind: Phase["gate"]) => Gate {
  return (kind) => {
    switch (kind) {
      case "human":
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
