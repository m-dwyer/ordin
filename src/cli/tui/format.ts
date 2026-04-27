import type { CapturedFrame } from "@opentui/core";
import { formatPatch, type StructuredPatchHunk, structuredPatch } from "diff";
import { PALETTE } from "./theme";
import type { EditDiff } from "./types";

const ESC = "\x1b";
const RESET_RAW = `${ESC}[0m`;
const COLOR_TAG_DEFAULT = 257;

export const BRAND_GRADIENT = ["#89b4fa", "#cba6f7", "#f5c2e7"] as const;

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
