import type { Command } from "commander";
import type { RunMeta } from "../runtime/harness";
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

export function registerRuns(program: Command): void {
  program
    .command("runs")
    .description("List historical runs")
    .option("-n, --limit <n>", "How many recent runs to show", (v) => Number.parseInt(v, 10), 20)
    .action(async (opts: { limit: number }) => {
      const runtime = ordin();
      const all = await runtime.listRuns();
      const slice = all.slice(0, opts.limit);

      printCommandHeader("runs", `${slice.length} most recent`);
      printBlank();

      if (slice.length === 0) {
        printEmptyState();
        return;
      }

      // TTY path: OpenTUI TextTableRenderable does the column fitting,
      // proportional shrinking, and cell padding via Yoga — no
      // hand-rolled width math. Non-TTY (piped to a file / grep / etc.)
      // gets a minimal plain row print since the layout would just be
      // ANSI noise in captured output.
      if (process.stdout.isTTY) {
        const { renderRunsTable } = await import("./tui/runs-table");
        await renderRunsTable(slice);
      } else {
        printPlainRows(slice);
      }
      printBlank();
      printRunsSummary(all);
    });
}

function printPlainRows(rows: readonly RunMeta[]): void {
  const now = Date.now();
  for (const meta of rows) {
    const elapsed = meta.completedAt
      ? timeBetween(meta.startedAt, meta.completedAt)
      : timeBetween(meta.startedAt, new Date(now).toISOString());
    writeLine(`${meta.runId}\t${meta.status}\t${meta.tier}\t${elapsed}\t${meta.task}`);
  }
}

function printRunsSummary(all: readonly RunMeta[]): void {
  const counts = new Map<string, number>();
  for (const r of all) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const breakdown = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, n]) => `${n} ${styled(status, colorForRunStatus(status))}`)
    .join(styled(" · ", PALETTE.border));
  writeLine(
    `${styled(`${all.length} runs`, PALETTE.text)}` +
      (breakdown ? `${styled(" · ", PALETTE.border)}${breakdown}` : ""),
  );
}

function printEmptyState(): void {
  printHint("No runs yet.");
  printBlank();
  writeLine(`  ${styled("Get started:", PALETTE.text)}`);
  writeLine(
    `    ${styled('ordin run --tier S "describe what you want to build"', PALETTE.toolName)}`,
  );
}

function timeBetween(startIso: string, endIso: string): string {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (Number.isNaN(ms)) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
