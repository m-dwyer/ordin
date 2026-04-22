import type { Command } from "commander";
import { ordin } from "./common";

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
        process.stdout.write("No runs yet.\n");
        return;
      }
      process.stdout.write(`${latest.runId} — ${latest.status}\n`);
      for (const phase of latest.phases) {
        const gate = phase.gateDecision ?? "-";
        process.stdout.write(
          `  ${phase.phaseId.padEnd(8)}  ${phase.status.padEnd(10)}  gate=${gate}\n`,
        );
      }
    });
}
