/**
 * Solid-component banner for `ordin run --dry-run` (TTY path).
 *
 * Uses `@opentui/solid`'s `testRender` to render `<RunBanner/>` into
 * an in-memory frame buffer with no terminal probing, captures the
 * resulting cell bytes as an ANSI string, and writes that to stdout.
 * No live renderer mount, no terminal-capability queries, no risk of
 * escape-response leaks.
 *
 * The phase previews themselves are plain text and stay in
 * `dry-run.ts` via the `print.ts` helpers — TSX layout buys us
 * nothing for "section header + key/value rows + multi-line body."
 */

import { testRender } from "@opentui/solid";
import { BANNER_HEIGHT, RunBanner } from "./banner";
import { frameToAnsi } from "./format";

export async function renderBanner(): Promise<void> {
  const { renderOnce, captureSpans } = await testRender(() => <RunBanner />, {
    width: process.stdout.columns ?? 80,
    height: BANNER_HEIGHT,
  });
  await renderOnce();
  process.stdout.write(`${frameToAnsi(captureSpans())}\n`);
}
