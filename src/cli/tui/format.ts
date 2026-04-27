import type { CapturedFrame } from "@opentui/core";
import { formatPatch, type StructuredPatchHunk, structuredPatch } from "diff";
import { PALETTE } from "./theme";
import type { EditDiff, FeedRow } from "./types";

const ESC = "\x1b";
const RESET_RAW = `${ESC}[0m`;
const COLOR_TAG_DEFAULT = 257;

export const BRAND_GRADIENT = ["#5fb1ff", "#b58cff", "#ff7aa8"] as const;

export function ansiEnabled(): boolean {
  if (process.env["NO_COLOR"]) return false;
  return process.stdout.isTTY === true;
}

export function ansiFg(hex: string): string {
  if (!ansiEnabled()) return "";
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `${ESC}[38;2;${r};${g};${b}m`;
}

export function ansiStyled(text: string, hex: string): string {
  return ansiEnabled() ? `${ansiFg(hex)}${text}${RESET_RAW}` : text;
}

export function interpolateStops(stops: readonly string[], t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const last = stops.length - 1;
  if (last <= 0) return stops[0] ?? "#FFFFFF";
  const scaled = clamped * last;
  const lo = Math.floor(scaled);
  const hi = Math.min(last, lo + 1);
  return mixHex(stops[lo] ?? "#FFFFFF", stops[hi] ?? "#FFFFFF", scaled - lo);
}

export function frameToAnsi(frame: CapturedFrame): string {
  const out: string[] = [];
  for (const line of frame.lines) {
    let rendered = "";
    for (const span of line.spans) {
      rendered += colorizeSpan(span.fg, span.text);
    }
    out.push(`${rendered.trimEnd()}${RESET_RAW}`);
  }
  return out.join("\n");
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/**
 * Live-ticking elapsed clock. Used in the footer next to the active
 * phase id ("ordin · run · plan · 0:42"). Distinct from
 * `formatDuration` which renders post-completion stats with one
 * decimal — clock format reads more naturally while time is moving.
 */
export function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return `${min}:${sec.toString().padStart(2, "0")}`;
  const hr = Math.floor(min / 60);
  return `${hr}:${(min % 60).toString().padStart(2, "0")}`;
}

/**
 * Build a `file://` URI for an absolute path. Modern terminals (iTerm2,
 * Terminal.app, VS Code, Wezterm, Kitty) emit OSC 8 hyperlinks for any
 * `<a link={{url}}>` we render — cmd-click opens in the user's default
 * handler. We URL-encode each path segment so spaces / non-ascii don't
 * break the escape.
 */
export function fileUri(absolutePath: string): string {
  const encoded = absolutePath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
  return `file://${encoded}`;
}

/** Whether a tool's `detail` field is a real file path we can link. */
export function isFileTool(name: string | undefined): boolean {
  return (
    name === "Read" ||
    name === "Write" ||
    name === "Edit" ||
    name === "MultiEdit" ||
    name === "NotebookEdit"
  );
}

/**
 * Show file paths in their most useful form. Inside the active repo
 * we strip the prefix so users see `src/calculator.ts`, not
 * `/Users/em/src/harness/.scratch/target-repo/src/calculator.ts`.
 * Outside the repo (or when we don't know the repo), return the path
 * as-is — it'll wrap naturally inside the row's flex column.
 */
export function shortenPath(absolute: string, repoPath?: string): string {
  if (!repoPath) return absolute;
  if (!absolute.startsWith(repoPath)) return absolute;
  const rel = absolute.slice(repoPath.length).replace(/^\/+/, "");
  return rel.length > 0 ? rel : absolute;
}

/**
 * Single-line ellipsis for paths that won't fit in their row. Always
 * preserves the basename (the most diagnostic part — "what file?")
 * by chopping from the LEFT with a `…/` lead. Falls back to chopping
 * the basename's start when even the basename is too long.
 *
 * Used together with `wrapMode="none" truncate` on the row, so OpenTUI
 * still clips at the cell edge if our maxLen guess overflowed.
 */
export function ellipsizePath(path: string, maxLen = 80): string {
  if (path.length <= maxLen) return path;
  const idx = path.lastIndexOf("/");
  const basename = idx === -1 ? path : path.slice(idx + 1);
  const tail = `…/${basename}`;
  if (tail.length <= maxLen) return tail;
  // Basename itself overflows — keep the last (maxLen - 1) chars with
  // a leading … so users still see the file extension.
  return `…${path.slice(-(maxLen - 1))}`;
}

const FILETYPE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  md: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  py: "python",
  rs: "rust",
  go: "go",
  sh: "bash",
  css: "css",
  html: "html",
};

/**
 * Build a unified-diff string for OpenTUI's `<diff>` from an Edit /
 * MultiEdit / NotebookEdit tool input. Uses the `diff` package so the
 * patch is always well-formed (correct hunk headers, line counts,
 * starting positions). Each hunk is capped at `maxSide` removed +
 * `maxSide` added lines so huge edits don't fill the screen; when any
 * hunk is capped, the result's `truncated` flag tells the renderer to
 * show an overflow hint.
 */
export function buildEditDiff(name: string, input: unknown, maxSide = 3): EditDiff | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  const filePath = typeof rec["file_path"] === "string" ? rec["file_path"] : undefined;
  if (!filePath) return undefined;

  type RawEdit = { old_string: string; new_string: string };
  const edits: RawEdit[] = [];

  if (name === "Edit" || name === "NotebookEdit") {
    const oldStr = typeof rec["old_string"] === "string" ? rec["old_string"] : "";
    const newStr = typeof rec["new_string"] === "string" ? rec["new_string"] : "";
    if (!oldStr && !newStr) return undefined;
    edits.push({ old_string: oldStr, new_string: newStr });
  } else if (name === "MultiEdit") {
    const list = Array.isArray(rec["edits"]) ? (rec["edits"] as unknown[]) : [];
    for (const edit of list) {
      if (!edit || typeof edit !== "object") continue;
      const e = edit as Record<string, unknown>;
      const oldStr = typeof e["old_string"] === "string" ? e["old_string"] : "";
      const newStr = typeof e["new_string"] === "string" ? e["new_string"] : "";
      if (oldStr || newStr) edits.push({ old_string: oldStr, new_string: newStr });
    }
    if (edits.length === 0) return undefined;
  } else {
    return undefined;
  }

  const base = filePath.split("/").pop() ?? filePath;
  const hunks: StructuredPatchHunk[] = [];
  let truncated = false;
  for (const edit of edits) {
    // context: 0 keeps hunks tight to the actual changes (no
    // surrounding context lines), since we're showing isolated edits
    // not full file diffs.
    const sub = structuredPatch(
      base,
      base,
      edit.old_string,
      edit.new_string,
      undefined,
      undefined,
      {
        context: 0,
      },
    );
    for (const hunk of sub.hunks) {
      const capped = capHunk(hunk, maxSide);
      if (capped.truncated) truncated = true;
      hunks.push(capped.hunk);
    }
  }

  const ext = base.includes(".") ? (base.split(".").pop() ?? "").toLowerCase() : "";
  const filetype = FILETYPE_BY_EXT[ext];

  return {
    filePath,
    diff: formatPatch({
      oldFileName: base,
      newFileName: base,
      oldHeader: undefined,
      newHeader: undefined,
      hunks,
    }),
    ...(filetype ? { filetype } : {}),
    truncated,
  };
}

// ── Row helpers (pure transforms used by run-app) ───────────────────

/**
 * Build the OSC 8 link target for a tool row's detail, when applicable.
 * - File tools (Read/Write/Edit/MultiEdit/NotebookEdit): wrap absolute
 *   path in `file://` so cmd-click opens in the user's default handler.
 * - WebFetch: detail is already a URL.
 * - Everything else (Glob patterns, Bash commands, Skill names): no link.
 */
export function linkUrl(tool: string | undefined, detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  if (isFileTool(tool)) return fileUri(detail);
  if (tool === "WebFetch") return detail;
  return undefined;
}

/**
 * For tools whose `detail` is a file path (Read/Write/Edit/Glob/etc.),
 * render the path repo-relative so the same `.scratch/target-repo/`
 * prefix doesn't burn a line per row.
 */
export function prettifyDetail(
  tool: string | undefined,
  detail: string | undefined,
  repoPath?: string,
): string {
  if (!detail) return "";
  if (!tool) return detail;
  if (isFileTool(tool)) {
    return ellipsizePath(shortenPath(detail, repoPath));
  }
  return detail;
}

// ── Collapsibles ────────────────────────────────────────────────────

export const NOTE_COLLAPSE_THRESHOLD = 6;
export const TOOL_GROUP_THRESHOLD = 3;

/** Whether a tool name counts as low-signal exploration that we'd
 * group under "explored N files" when 3+ adjacent calls fire. */
export function isExplorationTool(name: string | undefined): boolean {
  return name === "Read" || name === "Glob" || name === "Grep";
}

export type Collapsible =
  | { kind: "note"; id: number; lineCount: number }
  | { kind: "tool-group"; id: number; rows: readonly FeedRow[] };

/**
 * One unit of phase-card output: either a single row (tool, edit,
 * note, error) or a grouped tool-run (3+ adjacent Read/Glob/Grep)
 * collapsed under a single disclosure header. Run-app turns this
 * into <Row/> or <ToolGroupRow/> children.
 */
export type RenderItem =
  | { kind: "row"; row: FeedRow }
  | { kind: "group"; id: number; rows: readonly FeedRow[] };

/**
 * Convert the flat row stream into a render plan: standalone rows
 * and tool-groups (Read/Glob/Grep ≥3 adjacent). The first row id of
 * each group becomes the anchor; subsequent rows in the group are
 * skipped from standalone emission. Order-preserving and pure.
 */
export function buildRenderPlan(rows: readonly FeedRow[]): RenderItem[] {
  const items: RenderItem[] = [];
  const collapsibles = findCollapsibles(rows);
  const groupByFirstId = new Map<number, readonly FeedRow[]>();
  const skipIds = new Set<number>();
  for (const c of collapsibles) {
    if (c.kind === "tool-group") {
      groupByFirstId.set(c.id, c.rows);
      for (const r of c.rows) skipIds.add(r.id);
      // first id is the anchor — it represents the whole group
      skipIds.delete(c.id);
    }
  }
  for (const row of rows) {
    if (groupByFirstId.has(row.id)) {
      items.push({ kind: "group", id: row.id, rows: groupByFirstId.get(row.id) ?? [] });
      continue;
    }
    if (skipIds.has(row.id)) continue;
    items.push({ kind: "row", row });
  }
  return items;
}

/**
 * Walk a phase's row stream and identify each collapsible spot — long
 * notes and adjacency-runs of read-class tool calls. Used by both the
 * render memo (to decide what to draw) and the controller (to drive
 * cycle-next-collapsed). Pure, deterministic, order-preserving.
 */
export function findCollapsibles(rows: readonly FeedRow[]): Collapsible[] {
  const out: Collapsible[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (!row) {
      i++;
      continue;
    }
    if (row.kind === "note") {
      const lines = (row.detail ?? "").split("\n").length;
      if (lines > NOTE_COLLAPSE_THRESHOLD) out.push({ kind: "note", id: row.id, lineCount: lines });
      i++;
      continue;
    }
    if (row.kind === "tool" && isExplorationTool(row.tool)) {
      let j = i + 1;
      while (j < rows.length) {
        const next = rows[j];
        if (!next || next.kind !== "tool" || !isExplorationTool(next.tool)) break;
        j++;
      }
      const run = rows.slice(i, j);
      if (run.length >= TOOL_GROUP_THRESHOLD) {
        out.push({ kind: "tool-group", id: row.id, rows: run });
      }
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

function capHunk(
  hunk: StructuredPatchHunk,
  maxSide: number,
): { hunk: StructuredPatchHunk; truncated: boolean } {
  const removed: string[] = [];
  const added: string[] = [];
  const context: string[] = [];
  for (const line of hunk.lines) {
    if (line.startsWith("-")) removed.push(line);
    else if (line.startsWith("+")) added.push(line);
    else context.push(line);
  }
  const truncated = removed.length > maxSide || added.length > maxSide;
  if (!truncated) return { hunk, truncated: false };
  const cappedRemoved = removed.slice(0, maxSide);
  const cappedAdded = added.slice(0, maxSide);
  return {
    hunk: {
      ...hunk,
      oldLines: cappedRemoved.length + context.length,
      newLines: cappedAdded.length + context.length,
      lines: [...context, ...cappedRemoved, ...cappedAdded],
    },
    truncated: true,
  };
}

export function firstLine(s: string, max = 120): string {
  const line = s.split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

/**
 * Per-tool category styling. Drives the glyph + colour + weight used
 * by the run-app `ToolRow` component so reads, mutations, and shells
 * are visually distinct in the scrollback.
 */
export interface ToolRowStyle {
  glyph: string;
  glyphColor: string;
  nameWeight: "bold" | "dim" | "plain";
  detailColor: string;
}

const TOOL_STYLES: Record<string, ToolRowStyle> = {
  Read: {
    glyph: "▸",
    glyphColor: PALETTE.muted,
    nameWeight: "dim",
    detailColor: PALETTE.toolPreview,
  },
  Glob: {
    glyph: "▸",
    glyphColor: PALETTE.muted,
    nameWeight: "dim",
    detailColor: PALETTE.toolPreview,
  },
  Grep: {
    glyph: "▸",
    glyphColor: PALETTE.muted,
    nameWeight: "dim",
    detailColor: PALETTE.toolPreview,
  },
  Write: { glyph: "●", glyphColor: PALETTE.accent, nameWeight: "bold", detailColor: PALETTE.text },
  Edit: { glyph: "●", glyphColor: PALETTE.accent, nameWeight: "bold", detailColor: PALETTE.text },
  NotebookEdit: {
    glyph: "●",
    glyphColor: PALETTE.accent,
    nameWeight: "bold",
    detailColor: PALETTE.text,
  },
  Bash: { glyph: "$", glyphColor: PALETTE.accent2, nameWeight: "bold", detailColor: PALETTE.text },
  Skill: {
    glyph: "✦",
    glyphColor: PALETTE.toolName,
    nameWeight: "bold",
    detailColor: PALETTE.accent,
  },
  WebFetch: {
    glyph: "↗",
    glyphColor: PALETTE.accent,
    nameWeight: "bold",
    detailColor: PALETTE.toolPreview,
  },
};

const FALLBACK_STYLE: ToolRowStyle = {
  glyph: "▸",
  glyphColor: PALETTE.toolName,
  nameWeight: "plain",
  detailColor: PALETTE.toolPreview,
};

export function toolRowStyle(name: string): ToolRowStyle {
  return TOOL_STYLES[name] ?? FALLBACK_STYLE;
}

export function summariseToolInput(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const v = rec[key];
    return typeof v === "string" ? v : undefined;
  };
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "NotebookEdit":
      return str("file_path");
    case "Bash": {
      const cmd = str("command");
      return cmd ? firstLine(cmd, 88) : undefined;
    }
    case "Grep":
    case "Glob":
      return str("pattern");
    case "Skill":
      return str("name") ?? str("skill");
    case "WebFetch":
      return str("url");
    default: {
      const json = JSON.stringify(input);
      return json.length > 80 ? `${json.slice(0, 77)}...` : json;
    }
  }
}

function colorizeSpan(
  fg: { r: number; g: number; b: number; buffer: Float32Array },
  text: string,
): string {
  const tag = fg.buffer[4];
  if (tag === COLOR_TAG_DEFAULT) return text;
  const r = Math.round(fg.r * 255);
  const g = Math.round(fg.g * 255);
  const b = Math.round(fg.b * 255);
  return `${ESC}[38;2;${r};${g};${b}m${text}`;
}

/**
 * Mix two hex colors. `t=0` returns `a`, `t=1` returns `b`. Used to
 * desaturate "past" content by mixing toward the canvas bg.
 */
export function mix(a: string, b: string, t: number): string {
  return mixHex(a, b, t);
}

function mixHex(a: string, b: string, t: number): string {
  const ar = Number.parseInt(a.slice(1, 3), 16);
  const ag = Number.parseInt(a.slice(3, 5), 16);
  const ab = Number.parseInt(a.slice(5, 7), 16);
  const br = Number.parseInt(b.slice(1, 3), 16);
  const bg = Number.parseInt(b.slice(3, 5), 16);
  const bb = Number.parseInt(b.slice(5, 7), 16);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(bl)}`;
}
