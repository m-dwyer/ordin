import type { Command } from "commander";
import type { PhaseMeta } from "../runtime/harness";
import { ordin } from "./common";
import {
  colorForRunStatus,
  printBlank,
  printCommandHeader,
  printHint,
  styled,
  writeLine,
} from "./tui/print";
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

      printCommandHeader("status", latest ? "latest run" : "no runs yet");
      printBlank();

      if (!latest) {
        printHint("No runs yet.");
        printBlank();
        writeLine(`  ${styled("Get started:", PALETTE.text)}`);
        writeLine(
          `    ${styled('ordin run --tier S "describe what you want to build"', PALETTE.toolName)}`,
        );
        return;
      }

      writeLine(
        `  ${styled("run:", PALETTE.hint)}    ${styled(latest.runId, PALETTE.text)}` +
          `  ${styled("·", PALETTE.border)}  ${styled(latest.status, colorForRunStatus(latest.status))}`,
      );
      writeLine(`  ${styled("task:", PALETTE.hint)}   ${styled(latest.task, PALETTE.toolPreview)}`);
      printBlank();
      printPhaseChain(latest.phases);
    });
}

/**
 * Render phases as a horizontal flow, one per line, with the rejected
 * gate (or any error detail) indented underneath the phase that
 * produced it. Mirrors the live run-time SummaryLine so anyone who's
 * watched a run recognises the visual.
 */
function printPhaseChain(phases: readonly PhaseMeta[]): void {
  if (phases.length === 0) {
    writeLine(`  ${styled("(no phases run yet)", PALETTE.hint)}`);
    return;
  }
  const labelWidth = Math.max(...phases.map((p) => p.phaseId.length));
  for (const phase of phases) {
    const glyph = styled(statusGlyph(phase.status), colorForRunStatus(phase.status));
    const label = styled(phase.phaseId.padEnd(labelWidth), PALETTE.text);
    const status = styled(phase.status, colorForRunStatus(phase.status));
    writeLine(`  ${glyph}  ${label}   ${status}`);
    if (phase.gateDecision === "rejected" && phase.gateNote) {
      writeLine(`     ${" ".repeat(labelWidth)}   ${styled(phase.gateNote, PALETTE.failed)}`);
    } else if (phase.error) {
      writeLine(`     ${" ".repeat(labelWidth)}   ${styled(phase.error, PALETTE.failed)}`);
    }
  }
}

function statusGlyph(status: string): string {
  switch (status) {
    case "completed":
    case "approved":
      return "✓";
    case "failed":
    case "rejected":
    case "aborted":
      return "✗";
    case "running":
      return "▸";
    case "halted":
      return "◆";
    case "pending":
      return "◌";
    default:
      return "·";
  }
}
