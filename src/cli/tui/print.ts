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
import { ansiEnabled, ansiFg, ansiStyled, BRAND_GRADIENT, interpolateStops } from "./format";
import { PALETTE } from "./theme";

/**
 * Honor `NO_COLOR` and the TTY-vs-pipe distinction. When stdout isn't
 * a TTY (piped to a file, captured in CI logs, less/cat) ANSI escapes
 * just become noise in the output — emit plain text instead.
 */
function colorEnabled(): boolean {
  return ansiEnabled();
}

const RESET = colorEnabled() ? "\x1b[0m" : "";

export function fg(hex: string): string {
  return ansiFg(hex);
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

/**
 * A `key:   value` row inside a section, with the key dimmed.
 * `keyWidth` is the column the value starts at — must exceed the
 * longest key in the group, otherwise long keys collapse against the
 * value with no space.
 */
export function printKeyValue(key: string, value: string, keyWidth = 11): void {
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

/**
 * ✓/✗ status row used by `doctor`. Glyph and label colored by outcome,
 * optional detail in muted hint.
 */
export function printStatusLine(ok: boolean, label: string, detail?: string): void {
  const glyph = ok ? "✓" : "✗";
  const color = ok ? PALETTE.done : PALETTE.failed;
  const tail = detail ? `${fg(PALETTE.hint)}  — ${detail}${RESET}` : "";
  process.stdout.write(
    `${fg(color)}${glyph}${RESET}  ${fg(PALETTE.text)}${label}${RESET}${tail}\n`,
  );
}

/**
 * Color a run-meta status string the same way the run UI does.
 * `halted` maps to gate-orange because it always means "human paused
 * the run at a gate" — same semantic as the live gate panel, so it
 * reads as "needs attention" rather than blending into metadata.
 * Unknown states render in PALETTE.hint as a safe fallback.
 */
export function colorForRunStatus(status: string): string {
  switch (status) {
    case "completed":
      return PALETTE.done;
    case "failed":
    case "aborted":
    case "rejected":
      return PALETTE.failed;
    case "running":
      return PALETTE.running;
    case "pending":
      return PALETTE.pending;
    case "halted":
      return PALETTE.gate;
    default:
      return PALETTE.hint;
  }
}

/** Concatenate a styled segment without writing — composer for table rows. */
export function styled(text: string, hex: string): string {
  return ansiStyled(text, hex);
}

export function writeLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

/**
 * Width of styled text, ignoring ANSI escape sequences. Needed for
 * any layout that pads or right-aligns content built with `styled()`
 * — `string.length` would count the escape bytes and over-pad.
 */
export function visibleWidth(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI CSI on purpose
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Universal command header: gradient `ordin` lowercase + breadcrumb
 * + version pinned right, with a full-width divider underneath.
 *
 * Renders identically across `runs`, `status`, `doctor`, etc., so the
 * whole CLI shares one masthead pattern. The gradient mirrors the
 * run-time TUI's banner so the static commands inherit ordin's visual
 * identity for free.
 *
 *   ordin · runs · 5 most recent                              v0.1.0
 *   ────────────────────────────────────────────────────────────────
 */
export function printCommandHeader(command: string, subtitle?: string): void {
  const cols = process.stdout.columns ?? 80;
  const word = "ordin";
  const letters = word.split("");
  const palette = letters.map((_, i) =>
    interpolateStops(BRAND_GRADIENT, letters.length <= 1 ? 0 : i / (letters.length - 1)),
  );
  const brand = letters.map((ch, i) => styled(ch, palette[i] ?? PALETTE.text)).join("");
  const breadcrumb =
    `${styled(" · ", PALETTE.border)}${styled(command, PALETTE.text)}` +
    (subtitle ? `${styled(" · ", PALETTE.border)}${styled(subtitle, PALETTE.hint)}` : "");
  const version = styled("v0.1.0", PALETTE.hint);

  const leftWidth = letters.length + visibleWidth(breadcrumb);
  const rightWidth = visibleWidth(version);
  const gap = Math.max(2, cols - leftWidth - rightWidth);

  process.stdout.write(`${brand}${breadcrumb}${" ".repeat(gap)}${version}\n`);
  process.stdout.write(`${styled("─".repeat(cols), PALETTE.border)}\n`);
}
