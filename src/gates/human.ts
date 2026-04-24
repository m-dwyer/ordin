import type { Gate, GateContext, GateDecision, GatePrompter } from "./types";

/**
 * Human-in-the-loop gate. Business logic only — delegates presentation
 * and input collection to an injected `GatePrompter`. The CLI passes a
 * clack-based prompter; a future HTTP/Slack client would pass its own.
 */
export class HumanGate implements Gate {
  readonly kind = "human";

  constructor(private readonly prompter: GatePrompter) {}

  request(ctx: GateContext): Promise<GateDecision> {
    return this.prompter.prompt(ctx);
  }
}
