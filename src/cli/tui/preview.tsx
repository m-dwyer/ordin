/**
 * Solid-component banner for `ordin run --dry-run` (TTY path).
 *
 * Uses `@opentui/solid`'s `testRender` to render `<Banner/>` into an
 * in-memory frame buffer with no terminal probing, captures the
 * resulting cell bytes as an ANSI string, and writes that to stdout.
 * No live renderer mount, no terminal-capability queries, no risk of
 * escape-response leaks.
 *
 * The phase previews themselves are plain text and stay in
 * `dry-run.ts` via the `print.ts` helpers — TSX layout buys us
 * nothing for "section header + key/value rows + multi-line body."
 */

import type { CapturedFrame } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { For } from "solid-js";

const GRADIENT = ["#7AB8FF", "#A28BFF", "#D77CC8"] as const;
const BANNER_HEIGHT = 6; // matches the `block` ASCII font's row count
const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const COLOR_TAG_DEFAULT = 257;

export async function renderBanner(): Promise<void> {
  const { renderOnce, captureSpans } = await testRender(() => <Banner />, {
    width: process.stdout.columns ?? 80,
    height: BANNER_HEIGHT,
  });
  await renderOnce();
  process.stdout.write(`${frameToAnsi(captureSpans())}\n`);
}

/**
 * Convert OpenTUI's CapturedFrame (per-span fg/bg/text) to an ANSI
 * escape string. `captureCharFrame()` would drop the colors; we want
 * the gradient. Trailing blank spans get trimmed so the banner hugs
 * the left edge instead of leaving a wide painted background.
 */
function frameToAnsi(frame: CapturedFrame): string {
  const lines: string[] = [];
  for (const line of frame.lines) {
    let rendered = "";
    for (const span of line.spans) {
      rendered += colorize(span.fg, span.text);
    }
    lines.push(`${rendered.trimEnd()}${RESET}`);
  }
  return lines.join("\n");
}

function colorize(
  fg: { r: number; g: number; b: number; buffer: Float32Array },
  text: string,
): string {
  // RGBA components are 0..1 floats; the colour tag lives at buffer[4].
  // tag === COLOR_TAG_DEFAULT means "use terminal default" — emit no
  // fg escape so the cell falls through to the user's terminal colors.
  const tag = fg.buffer[4];
  if (tag === COLOR_TAG_DEFAULT) return text;
  const r = Math.round(fg.r * 255);
  const g = Math.round(fg.g * 255);
  const b = Math.round(fg.b * 255);
  return `${ESC}[38;2;${r};${g};${b}m${text}`;
}

function Banner() {
  const word = "ordin";
  const letters = word.split("");
  const palette = letters.map((_, i) =>
    interpolateStops([...GRADIENT], letters.length <= 1 ? 0 : i / (letters.length - 1)),
  );
  return (
    <box flexDirection="row" gap={1} backgroundColor="transparent">
      <For each={letters}>
        {(ch, i) => (
          <ascii_font text={ch} font="block" color={palette[i()]} backgroundColor="transparent" />
        )}
      </For>
    </box>
  );
}

function interpolateStops(stops: readonly string[], t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  const last = stops.length - 1;
  if (last <= 0) return stops[0] ?? "#FFFFFF";
  const scaled = clamped * last;
  const lo = Math.floor(scaled);
  const hi = Math.min(last, lo + 1);
  return mixHex(stops[lo] ?? "#FFFFFF", stops[hi] ?? "#FFFFFF", scaled - lo);
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
