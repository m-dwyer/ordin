import type { Command } from "commander";
import { ordin } from "./common";

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
        process.stdout.write("No runs yet.\n");
        return;
      }
      for (const meta of slice) {
        const duration = meta.completedAt
          ? timeBetween(meta.startedAt, meta.completedAt)
          : "running";
        process.stdout.write(
          `${meta.runId}  ${meta.status.padEnd(9)}  tier=${meta.tier}  ${duration}  ${meta.task}\n`,
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
