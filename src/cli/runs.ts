import type { Command } from "commander";
import { ordin } from "./common";
import { colorForRunStatus, printHint, styled, writeLine } from "./tui/print";
import { PALETTE } from "./tui/theme";

export function registerRuns(program: Command): void {
  program
    .command("runs")
    .description("List historical runs")
    .option("-n, --limit <n>", "How many recent runs to show", (v) => Number.parseInt(v, 10), 20)
    .action(async (opts: { limit: number }) => {
      const runtime = ordin();
      const all = await runtime.listRuns();
      const slice = all.slice(0, opts.limit);
      if (slice.length === 0) {
        printHint("No runs yet.");
        return;
      }
      const now = Date.now();
      for (const meta of slice) {
        // Show elapsed-since-start for in-flight runs so the duration
        // column carries information even before completion. The
        // status column already says "running" — repeating it here is
        // noise.
        const duration = meta.completedAt
          ? timeBetween(meta.startedAt, meta.completedAt)
          : timeBetween(meta.startedAt, new Date(now).toISOString());
        writeLine(
          [
            styled(meta.runId, PALETTE.text),
            styled(meta.status.padEnd(9), colorForRunStatus(meta.status)),
            styled(`tier=${meta.tier}`, PALETTE.hint),
            styled(duration.padEnd(7), PALETTE.hint),
            styled(meta.task, PALETTE.toolPreview),
          ].join("  "),
        );
      }
    });
}

function timeBetween(startIso: string, endIso: string): string {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (Number.isNaN(ms)) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
