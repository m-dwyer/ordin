/**
 * Dry-run output dispatcher. Mirrors the TTY-branch pattern in
 * `ordinRunSession`: TTY path mounts the OpenTUI preview renderer
 * via a dynamic import (keeping the native renderer out of cold
 * paths like tests + --help); non-TTY falls back to plain stdout
 * via the `print.ts` helpers.
 */
import type { PhasePreview } from "../../runtime/harness";
import {
  printBlank,
  printHint,
  printIndented,
  printKeyValue,
  printSectionDivider,
  printSubheader,
} from "./print";

export async function renderDryRun(previews: readonly PhasePreview[], task: string): Promise<void> {
  if (process.stdout.isTTY === true) {
    // Banner via TSX (in-memory testRender → captureCharFrame, no
    // live renderer mount); previews via plain print helpers since
    // they're text-shaped and TSX layout adds nothing.
    const { renderBanner } = await import("./preview");
    await renderBanner();
  }
  renderPreviewsPlain(previews, task);
}

/**
 * Plain-stdout dry-run renderer for non-TTY environments (CI logs,
 * `| tee out.log`, redirected stdout). Same color language as the
 * TTY path via `print.ts` helpers, but `print.ts` already gates ANSI
 * on `process.stdout.isTTY` + `NO_COLOR`, so the output is plain
 * text when piped.
 */
function renderPreviewsPlain(previews: readonly PhasePreview[], task: string): void {
  printBlank();
  printHint(
    `ordin dry-run · ${task} · ${previews.length} phase${previews.length === 1 ? "" : "s"} composed — no runtime invoked`,
  );
  printBlank();

  for (const preview of previews) {
    const { phase, runtimeName, prompt } = preview;
    const tools = prompt.tools.length > 0 ? prompt.tools.join(", ") : "(none)";
    printSectionDivider(`Phase ─ ${phase.id}`);
    printBlank();
    printKeyValue("agent:", phase.agent);
    printKeyValue("runtime:", runtimeName);
    printKeyValue("model:", prompt.model);
    printKeyValue("tools:", tools);
    printKeyValue("cwd:", prompt.cwd);
    printBlank();
    printSubheader("system prompt");
    printIndented(prompt.systemPrompt);
    printBlank();
    printSubheader("user prompt");
    printIndented(prompt.userPrompt);
    printBlank();
  }

  printHint(`${previews.length} phase${previews.length === 1 ? "" : "s"} previewed`);
}
