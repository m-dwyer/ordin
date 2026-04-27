/**
 * `ordin runs` table renderer. Backed by OpenTUI's TextTableRenderable
 * via `testRender` + `captureSpans` (the same render-once pattern
 * preview.tsx uses for the dry-run banner) so we get Yoga column
 * fitting, proportional shrinking, and per-cell colour without
 * hand-rolling padCell / truncate / width math.
 *
 * Two quirks to be aware of:
 *   - `text_table` isn't in the @opentui/solid JSX intrinsic
 *     catalogue, so we register it via `extend()` — same trick the
 *     spinner package uses (see opentui-spinner/dist/solid.mjs).
 *   - The Solid reconciler's prop setter for `content` stringifies
 *     any value (any prop named `content` hits a special branch in
 *     @opentui/solid/index.js that does Array#join). That breaks
 *     TextTable, whose `content` must be a TextChunk[][]. We sidestep
 *     it by setting `content` imperatively in a ref callback.
 */
import { fg as opentuiFg, type TextChunk, TextTableRenderable } from "@opentui/core";
import { extend, testRender } from "@opentui/solid";
import type { RunMeta } from "../../runtime/harness";
import { formatDuration, frameToAnsi } from "./format";
import { colorForRunStatus, styled } from "./print";
import { PALETTE } from "./theme";

extend({ text_table: TextTableRenderable });

declare module "@opentui/solid" {
  interface OpenTUIComponents {
    text_table: typeof TextTableRenderable;
  }
}

const HEADERS = ["RUN ID", "STATUS", "TIER", "ELAPSED", "TASK"] as const;

export async function renderRunsTable(rows: readonly RunMeta[]): Promise<void> {
  const cols = process.stdout.columns ?? 120;
  const content = buildContent(rows);
  // Header row + one row per data row + a 1-line divider we paint as
  // a separate widget below so the divider colour is independent of
  // the table's fg.
  const tableHeight = 1 + rows.length;

  const { renderOnce, captureSpans } = await testRender(
    () => (
      <text_table
        ref={(node) => {
          // The Solid reconciler stringifies any prop named `content`
          // before assigning, which destroys TextChunk[][] structure.
          // Set it imperatively after mount; the renderable's own
          // setter handles TextTableContent correctly.
          node.content = content;
        }}
        columnWidthMode="full"
        columnFitter="proportional"
        wrapMode="none"
        columnGap={2}
        border={false}
        showBorders={false}
        outerBorder={false}
        cellPadding={0}
      />
    ),
    { width: cols, height: tableHeight },
  );
  await renderOnce();
  const lines = frameToAnsi(captureSpans()).split("\n");
  // Slot a horizontal divider between header (lines[0]) and body so
  // the table reads as "headers · rule · rows" without TextTable's
  // built-in border (which is heavier than we want here). We re-use
  // print.ts's styled() helper for the divider — no need to involve
  // OpenTUI for a plain rule.
  const divider = styled("─".repeat(cols), PALETTE.border);
  process.stdout.write(`${lines[0]}\n${divider}\n${lines.slice(1).join("\n")}\n`);
}

// Cap the natural widths of the two flexible columns so the
// proportional fitter doesn't get dominated by a single 80-char
// slug. Yoga still does final width fitting; these caps just bound
// the *natural* width it weighs against. Cells trimmed here get a
// `…` so the truncation reads intentional rather than as a typo.
// (TextTable wrapMode "none" hard-cuts without any ellipsis option;
// the agent who reviewed the OpenTUI source confirmed there's no
// built-in ellipsis flag.)
const RUN_ID_MAX = 42;
const TASK_MAX = 60;

function buildContent(rows: readonly RunMeta[]): TextChunk[][][] {
  const now = Date.now();
  const headerRow: TextChunk[][] = HEADERS.map((label) => [opentuiFg(PALETTE.hint)(label)]);
  const bodyRows: TextChunk[][][] = rows.map((meta): TextChunk[][] => {
    const elapsed = meta.completedAt
      ? timeBetween(meta.startedAt, meta.completedAt)
      : timeBetween(meta.startedAt, new Date(now).toISOString());
    return [
      [opentuiFg(PALETTE.text)(ellipsize(meta.runId, RUN_ID_MAX))],
      [opentuiFg(colorForRunStatus(meta.status))(meta.status)],
      [opentuiFg(PALETTE.hint)(meta.tier)],
      [opentuiFg(PALETTE.hint)(elapsed)],
      [opentuiFg(PALETTE.toolPreview)(ellipsize(meta.task, TASK_MAX))],
    ];
  });
  return [headerRow, ...bodyRows];
}

function ellipsize(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function timeBetween(startIso: string, endIso: string): string {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (Number.isNaN(ms)) return "";
  return formatDuration(ms);
}
