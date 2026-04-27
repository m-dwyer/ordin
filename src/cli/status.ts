import type { Command } from "commander";
import { ordin } from "./common";
import { colorForRunStatus, printHint, styled, writeLine } from "./tui/print";
import { PALETTE } from "./tui/theme";

/**
 * Phase 1 `status` is a simple read of the most recent run's meta.json.
 * Live subscribe() via `RunEvent` stream lands with the HTTP adapter.
 */
export function registerStatus(program: Command): void {
  program
    .command("status")
    .description("Print the most recent run's phase status")
    .action(async () => {
      const runtime = ordin();
      const [latest] = await runtime.listRuns();
      if (!latest) {
        printHint("No runs yet.");
        return;
      }
      writeLine(
        `${styled(latest.runId, PALETTE.text)} ${styled("—", PALETTE.hint)} ${styled(latest.status, colorForRunStatus(latest.status))}`,
      );
      for (const phase of latest.phases) {
        const gate = phase.gateDecision ?? "-";
        const gateColor =
          phase.gateDecision === "approved"
            ? PALETTE.done
            : phase.gateDecision === "rejected"
              ? PALETTE.failed
              : PALETTE.hint;
        writeLine(
          [
            "  ",
            styled(phase.phaseId.padEnd(8), PALETTE.text),
            "  ",
            styled(phase.status.padEnd(10), colorForRunStatus(phase.status)),
            "  ",
            styled("gate=", PALETTE.hint),
            styled(gate, gateColor),
          ].join(""),
        );
      }
    });
}
