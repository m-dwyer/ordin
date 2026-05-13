/**
 * OpenTUI-backed prompter for `HumanGate`. Stage 3 successor to the
 * Clack prompter — instead of opening inline `select`/`text` dialogs in
 * the terminal scrollback, the gate is presented in the run-time TUI's
 * footer panel and resolved by a keypress in `RunApp`.
 *
 * The prompter is intentionally a thin delegator: the controller owns
 * the live App mount, the reactive state, and the Promise resolution
 * machinery. This file just adapts its `requestGate` to the
 * `GatePrompter` interface so the orchestrator can use the OpenTUI
 * controller exactly the way it used the Clack one.
 */
import { GateResolver } from "../../gates/dispatch";
import type { GateContext, GateDecision, GatePrompter } from "../../gates/types";
import type { OpenTuiRunController } from "../tui/controller";

export class OpenTuiGatePrompter implements GatePrompter {
  constructor(private readonly controller: OpenTuiRunController) {}

  prompt(ctx: GateContext): Promise<GateDecision> {
    return this.controller.requestGate(ctx);
  }
}

export function openTuiGateResolver(controller: OpenTuiRunController): GateResolver {
  return new GateResolver(new OpenTuiGatePrompter(controller));
}

/**
 * `HarnessOptions.egressGatePrompter` — wired into the broker
 * via the harness so srt's askCallback (broker.askApproval) surfaces
 * the unallowlisted host as a card in the run TUI. Returns true when
 * the user presses `a`; false on `r`.
 */
export function openTuiEgressGatePrompter(
  controller: OpenTuiRunController,
): (req: { host: string; port: number | undefined }) => Promise<boolean> {
  return ({ host, port }) => controller.requestEgressGate(host, port);
}
