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

import { testRender } from "@opentui/solid";
import { For } from "solid-js";
import { BRAND_GRADIENT, frameToAnsi, interpolateStops } from "./format";

const BANNER_HEIGHT = 6; // matches the `block` ASCII font's row count

export async function renderBanner(): Promise<void> {
  const { renderOnce, captureSpans } = await testRender(() => <Banner />, {
    width: process.stdout.columns ?? 80,
    height: BANNER_HEIGHT,
  });
  await renderOnce();
  process.stdout.write(`${frameToAnsi(captureSpans())}\n`);
}

function Banner() {
  const word = "ordin";
  const letters = word.split("");
  const palette = letters.map((_, i) =>
    interpolateStops(BRAND_GRADIENT, letters.length <= 1 ? 0 : i / (letters.length - 1)),
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
