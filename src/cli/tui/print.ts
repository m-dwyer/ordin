/**
 * Plain-stdout print helpers that share the OpenTUI run UI's color
 * language (`PALETTE` from theme.ts) without spinning up a renderer.
 * Used for non-interactive output paths — `ordin run --dry-run`, the
 * non-TTY plain sink — where mounting the live TUI is wrong but we
 * still want consistent visual identity with the live experience.
 *
 * Output is plain text + 24-bit ANSI escapes. TTY shows colors; piping
 * to a file preserves the box-drawing characters and drops the colors
 * (most pagers handle this; `cat`/`tee` capture the raw escapes).
 */
import { PALETTE } from "./theme";

const ESC = "\x1b";
const RESET_RAW = `${ESC}[0m`;

/**
 * Honor `NO_COLOR` and the TTY-vs-pipe distinction. When stdout isn't
 * a TTY (piped to a file, captured in CI logs, less/cat) ANSI escapes
 * just become noise in the output — emit plain text instead.
 */
function colorEnabled(): boolean {
  if (process.env["NO_COLOR"]) return false;
  return process.stdout.isTTY === true;
}

const RESET = colorEnabled() ? RESET_RAW : "";

export function fg(hex: string): string {
  if (!colorEnabled()) return "";
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `${ESC}[38;2;${r};${g};${b}m`;
}

/**
 * Horizontal divider with an inline title, full terminal width.
 * Color-graded across the run UI's gradient stops so it visually
 * echoes the `ordin` banner without re-rendering it.
 */
export function printSectionDivider(title: string): void {
  const cols = process.stdout.columns ?? 80;
  const lead = "─── ";
  const titleSegment = ` ${title} `;
  const tail = "─".repeat(Math.max(3, cols - lead.length - titleSegment.length));
  const stops = ["#7AB8FF", "#A28BFF", "#D77CC8"];
  process.stdout.write(
    `${fg(stops[0] ?? PALETTE.border)}${lead}${RESET}` +
      `${fg(PALETTE.text)}${titleSegment}${RESET}` +
      `${fg(stops[2] ?? PALETTE.border)}${tail}${RESET}\n`,
  );
}

/** Subheader for grouped content under a section (e.g. "▸ system prompt"). */
export function printSubheader(label: string): void {
  process.stdout.write(`  ${fg(PALETTE.toolName)}▸ ${label}${RESET}\n`);
}

/** A `key:   value` row inside a section, with the key dimmed. */
export function printKeyValue(key: string, value: string, keyWidth = 9): void {
  const paddedKey = key.padEnd(keyWidth);
  process.stdout.write(
    `  ${fg(PALETTE.hint)}${paddedKey}${RESET}${fg(PALETTE.text)}${value}${RESET}\n`,
  );
}

/** Multi-line body text, indented and colored as muted body copy. */
export function printIndented(text: string, indent = "    "): void {
  for (const line of text.split("\n")) {
    process.stdout.write(`${indent}${fg(PALETTE.toolPreview)}${line}${RESET}\n`);
  }
}

/** Blank line, no color codes. */
export function printBlank(): void {
  process.stdout.write("\n");
}

/** Single-line note in muted hint color. */
export function printHint(text: string): void {
  process.stdout.write(`${fg(PALETTE.hint)}${text}${RESET}\n`);
}
