import type { Gate, GateContext, GateDecision } from "./types";

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
