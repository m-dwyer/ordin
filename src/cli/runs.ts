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

      printRunsTable(slice);
      printBlank();
      printRunsSummary(all);
    });
}

interface Column {
  readonly key: string;
  readonly label: string;
  readonly align?: "left" | "right";
  /** Cell value as plain text (used for width math). */
  readonly value: (meta: RunMeta, now: number) => string;
  /** Optional color for the cell — defaults to PALETTE.text. */
  readonly color?: (meta: RunMeta) => string;
}

function printRunsTable(rows: readonly RunMeta[]): void {
  const now = Date.now();
  const columns: readonly Column[] = [
    {
      key: "runId",
      label: "RUN ID",
      value: (m) => m.runId,
      color: () => PALETTE.text,
    },
    {
      key: "status",
      label: "STATUS",
      value: (m) => m.status,
      color: (m) => colorForRunStatus(m.status),
    },
    {
      key: "tier",
      label: "TIER",
      value: (m) => m.tier,
      color: () => PALETTE.hint,
    },
    {
      key: "elapsed",
      label: "ELAPSED",
      align: "right",
      value: (m) =>
        m.completedAt
          ? timeBetween(m.startedAt, m.completedAt)
          : timeBetween(m.startedAt, new Date(now).toISOString()),
      color: () => PALETTE.hint,
    },
    {
      key: "task",
      label: "TASK",
      value: (m) => m.task,
      color: () => PALETTE.toolPreview,
    },
  ];

  // Reserve space for the task column to truncate gracefully on
  // narrow terminals. Other columns are sized to their max content.
  const cols = process.stdout.columns ?? 120;
  const fixedWidths = columns
    .slice(0, -1)
    .map((c) => Math.max(c.label.length, ...rows.map((r) => c.value(r, now).length)));
  const padding = 2 * (columns.length - 1);
  const remaining = Math.max(20, cols - fixedWidths.reduce((a, b) => a + b, 0) - padding);
  const widths = [...fixedWidths, remaining];

  // Header row
  const header = columns
    .map((c, i) => styled(padCell(c.label, widths[i] ?? 0, c.align ?? "left"), PALETTE.hint))
    .join("  ");
  writeLine(header);
  writeLine(styled("─".repeat(visibleWidthRow(widths, padding)), PALETTE.border));

  // Body rows
  for (const meta of rows) {
    const cells = columns.map((c, i) => {
      const raw = c.value(meta, now);
      const width = widths[i] ?? 0;
      const truncated = c.key === "task" ? truncate(raw, width) : raw;
      return styled(padCell(truncated, width, c.align ?? "left"), c.color?.(meta) ?? PALETTE.text);
    });
    writeLine(cells.join("  "));
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

function visibleWidthRow(widths: readonly number[], padding: number): number {
  return widths.reduce((a, b) => a + b, 0) + padding;
}

function padCell(text: string, width: number, align: "left" | "right"): string {
  if (text.length >= width) return text;
  return align === "right" ? text.padStart(width) : text.padEnd(width);
}

function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  return `${text.slice(0, Math.max(1, width - 1))}…`;
}

function timeBetween(startIso: string, endIso: string): string {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (Number.isNaN(ms)) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
