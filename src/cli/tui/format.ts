import type { CapturedFrame } from "@opentui/core";

const ESC = "\x1b";
const RESET_RAW = `${ESC}[0m`;
const COLOR_TAG_DEFAULT = 257;

export const BRAND_GRADIENT = ["#7AB8FF", "#A28BFF", "#D77CC8"] as const;

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

export function firstLine(s: string, max = 120): string {
  const line = s.split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 3)}...` : line;
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
      return str("skill");
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
