/**
 * OpenTUI run controller — the long-lived TUI mount that backs
 * `ordin run`'s footer experience.
 *
 * The controller owns the renderer and the reactive state stores; the
 * `<RunApp>` Solid component (in run-app.tsx) reads from `state()` and
 * routes keypresses back via `decideGate`. The CLI wires it as both
 * the orchestrator's event sink (`pushEvent`) and the gate prompter's
 * backing store (`requestGate` returns a Promise the App resolves).
 *
 * Split-footer mode keeps the streaming transcript in real terminal
 * scrollback above a fixed footer: tool calls, agent text, and phase
 * summaries are committed via `writeToScrollback`, while the phase
 * status list and gate prompt live in the footer panel.
 */
import {
  BoxRenderable,
  CliRenderEvents,
  type CliRenderer,
  createCliRenderer,
  fg as opentuiFg,
  StyledText,
  TextRenderable,
} from "@opentui/core";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { GateContext, GateDecision } from "../../gates/types";
import type { RunEvent, RunMeta } from "../../runtime/harness";
import { RunApp } from "./run-app";
import { PALETTE } from "./theme";
import type { ControllerState, GateState, PhaseRow, RunHeader } from "./types";

type RunStatus = RunMeta["status"];

export class OpenTuiRunController {
  private readonly phasesStore = createStore<{ list: PhaseRow[] }>({ list: [] });
  private readonly gateSignal = createSignal<GateState | null>(null);
  private readonly hintSignal = createSignal("");
  private readonly toolMeta = new Map<
    string,
    { name: string; preview?: string; startedAt: number }
  >();

  private renderer?: CliRenderer;
  private pendingGate: ((d: GateDecision) => void) | null = null;
  private finished = false;
  private finalSummary?: {
    runId: string;
    status: RunStatus;
    phases: PhaseRow[];
  };

  state(): ControllerState {
    const [phases] = this.phasesStore;
    const [gate] = this.gateSignal;
    const [hint] = this.hintSignal;
    return {
      phases: () => phases.list,
      gate,
      hint,
      decideGate: (d) => this.decideGate(d),
    };
  }

  async mount(header: RunHeader, phaseIds: readonly string[] = []): Promise<void> {
    if (phaseIds.length > 0) {
      this.setPhases("list", () => phaseIds.map((id) => ({ id, status: "pending", iteration: 1 })));
    }

    this.renderer = await createCliRenderer({
      targetFps: 30,
      exitOnCtrlC: true,
      useMouse: false,
      screenMode: "split-footer",
      // Baseline footer height (no gate active): outer border + summary +
      // hint with a tiny spacer, ~4 rows. The footer expands to
      // FOOTER_HEIGHT_GATE when a gate is requested and shrinks back
      // when it resolves — see requestGate / decideGate. Treating the
      // reservation as responsive (rather than always-max) keeps the
      // footer slim during the long stretches between gates.
      footerHeight: FOOTER_HEIGHT_BASE,
      externalOutputMode: "capture-stdout",
      consoleMode: "disabled",
      // Keep our scrollback writes (banner + transcript) intact when the
      // renderer tears down on Ctrl+C; the listener below releases the
      // footer reservation cleanly so it doesn't wipe what we wrote.
      clearOnShutdown: false,
    });

    this.renderer.on(CliRenderEvents.DESTROY, () => {
      if (!this.renderer || this.renderer.isDestroyed) return;
      this.renderer.externalOutputMode = "passthrough";
      this.renderer.screenMode = "main-screen";
    });

    writeBannerHeader(this.renderer, header);
    writeScrollbackLine(this.renderer, "", PALETTE.text);

    // render() returns Promise<void>; the Solid tree's lifetime is tied
    // to the renderer — `renderer.destroy()` fires CliRenderEvents.DESTROY
    // which triggers each component's onCleanup. The running-phase
    // spinner is animated by the `<spinner>` component itself
    // (opentui-spinner), no manual tick required.
    await render(() => RunApp({ state: this.state() }), this.renderer);
  }

  pushEvent(ev: RunEvent): void {
    switch (ev.type) {
      case "run.started":
      case "run.completed":
      case "phase.completed":
      case "agent.tokens":
        return;

      case "phase.started":
        this.setPhases(
          "list",
          produce((list) => {
            const existing = list.find((p) => p.id === ev.phaseId);
            const next: PhaseRow = {
              id: ev.phaseId,
              status: "running",
              model: ev.model,
              iteration: ev.iteration,
              activity: "starting",
            };
            if (existing) Object.assign(existing, next);
            else list.push(next);
          }),
        );
        // Emit a section header in scrollback so all the tool calls
        // and prose for this phase are visually grouped underneath.
        // Iteration > 1 is added to disambiguate retries.
        this.writePhaseDivider(ev.phaseId, ev.model, ev.iteration);
        return;

      case "phase.runtime.completed":
        this.setPhase(ev.phaseId, {
          status: "done",
          activity: undefined,
          durationMs: ev.durationMs,
          tokensIn: ev.tokens.input,
          tokensOut: ev.tokens.output,
        });
        this.scrollback(
          `  ✓ ${ev.phaseId} — ${formatDuration(ev.durationMs)} · in ${ev.tokens.input.toLocaleString()} / out ${ev.tokens.output.toLocaleString()} tok`,
          PALETTE.done,
        );
        return;

      case "phase.failed":
        this.setPhase(ev.phaseId, { status: "failed", activity: undefined });
        this.scrollback(`  ✗ ${ev.phaseId} failed — ${firstLine(ev.error)}`, PALETTE.failed);
        return;

      case "agent.thinking":
        this.setPhase(ev.phaseId, { activity: "thinking…" });
        return;

      case "agent.text": {
        const text = ev.text.trim();
        if (!text) return;
        // Prose gets a left gutter so model speech is visually distinct
        // from `▸ tool` and `✓ tool` lines that share the same indent.
        for (const line of text.split("\n")) {
          this.scrollback(`  │ ${line}`, PALETTE.text);
        }
        return;
      }

      case "agent.tool.use": {
        const preview = summariseToolInput(ev.name, ev.input);
        this.toolMeta.set(ev.id, {
          name: ev.name,
          ...(preview ? { preview } : {}),
          startedAt: Date.now(),
        });
        const label = `${ev.name}${preview ? ` · ${preview}` : ""}`;
        this.setPhase(ev.phaseId, { activity: label });
        this.scrollback(`  ▸ ${label}`, PALETTE.toolName);
        return;
      }

      case "agent.tool.result": {
        const meta = this.toolMeta.get(ev.id);
        const label = meta ? `${meta.name}${meta.preview ? ` · ${meta.preview}` : ""}` : ev.id;
        if (!ev.ok) {
          const reason = ev.preview ? ` — ${firstLine(ev.preview)}` : "";
          this.scrollback(`  ✗ ${label} failed${reason}`, PALETTE.failed);
        } else if (meta && Date.now() - meta.startedAt > SLOW_TOOL_MS) {
          // Quick tools (Read/Grep) finish within a frame and would
          // double up on the ▸ line; only confirm tools whose latency
          // crosses the visibility threshold so the user knows they
          // returned.
          this.scrollback(
            `  ✓ ${label} · ${formatDuration(Date.now() - meta.startedAt)}`,
            PALETTE.done,
          );
        }
        // Don't reset activity here — for fast tools (Read/Grep) the
        // result lands within a frame of the use, and flashing back to
        // "thinking…" makes tool names unreadable. The next
        // agent.thinking event resets it explicitly.
        return;
      }

      case "agent.error":
        this.scrollback(`  ✗ ${ev.message.trim()}`, PALETTE.failed);
        return;

      case "gate.requested":
      case "gate.decided":
        // Gate presentation + decision flow goes through requestGate /
        // decideGate so the App component owns the interactive panel.
        return;

      default: {
        const _exhaustive: never = ev;
        void _exhaustive;
      }
    }
  }

  requestGate(ctx: GateContext): Promise<GateDecision> {
    const [, setGate] = this.gateSignal;
    const [, setHint] = this.hintSignal;
    this.setPhase(ctx.phaseId, { status: "gate", activity: undefined });
    setGate({ ctx });
    // Grow the footer to make room for the 3-line gate panel —
    // mirrors a responsive web layout where a sticky toolbar
    // expands to fit its content.
    if (this.renderer && !this.renderer.isDestroyed) {
      this.renderer.footerHeight = FOOTER_HEIGHT_GATE;
    }
    // Clear the hint while the gate is active — the gate panel
    // already shows the [a]/[r] keys, and rendering them again at
    // the bottom of the footer would print the same text twice.
    setHint("");
    return new Promise<GateDecision>((resolve) => {
      this.pendingGate = resolve;
    });
  }

  /**
   * Stash final summary state for later printing. We can't write the
   * final block via `writeToScrollback` here because OpenTUI's destroy
   * path force-flushes pending scrollback content into the terminal
   * AFTER the live render loop has already committed it — so anything
   * written between "last render" and "destroy" gets duplicated.
   *
   * Instead `finish()` just records the data; `dispose()` tears down
   * the renderer; then the CLI calls `printFinalSummary()` which
   * emits the block to plain stdout (now in passthrough mode) exactly
   * once. Order in run.ts: finish → dispose → printFinalSummary.
   */
  finish(summary: { runId: string; status: RunStatus }): void {
    if (this.finished) return;
    this.finished = true;
    this.finalSummary = {
      runId: summary.runId,
      status: summary.status,
      phases: this.phasesStore[0].list.map((p) => ({ ...p })),
    };
    const [, setHint] = this.hintSignal;
    setHint("");
  }

  /**
   * Tear down the renderer cleanly.
   *
   * OpenTUI's destroy flow flushes any pending split-footer commits
   * and bakes the footer's last visible frame into terminal
   * scrollback (so it persists past renderer exit). If we destroy
   * mid-state — phases still listed, hint still shown — that
   * leftover frame and any in-flight late writes both end up in the
   * scrollback. To avoid both: blank the reactive state so the
   * footer renders empty, give the render loop a frame to commit
   * that empty state, *then* destroy.
   */
  async dispose(): Promise<void> {
    if (this.renderer && !this.renderer.isDestroyed) {
      this.setPhases("list", () => []);
      this.hintSignal[1]("");
      this.gateSignal[1](null);
      // ~2 frames at 30fps gives the renderer time to commit the
      // blank footer state before we tear down.
      await new Promise((resolve) => setTimeout(resolve, 80));
      this.renderer.destroy();
    }
    this.renderer = undefined;
  }

  /**
   * Emit the final run summary to plain stdout. Called *after*
   * dispose() so the renderer is gone and we're back to passthrough
   * mode — no double-flush risk. Returns silently if finish() was
   * never called or recorded no phases.
   */
  printFinalSummary(): void {
    const final = this.finalSummary;
    if (!final) return;
    const cols = process.stdout.columns ?? 80;
    const statusColor =
      final.status === "completed"
        ? PALETTE.done
        : final.status === "halted"
          ? PALETTE.gate
          : PALETTE.failed;

    process.stdout.write("\n");
    const lead = "── ";
    const titleText = ` run ${final.status} `;
    const trail = "─".repeat(Math.max(3, cols - lead.length - titleText.length));
    process.stdout.write(
      `${plainStyled(lead, PALETTE.border)}${plainStyled(titleText, statusColor)}${plainStyled(trail, PALETTE.border)}\n`,
    );

    const idWidth = Math.max(...final.phases.map((p) => p.id.length), 4);
    for (const phase of final.phases) {
      const glyph = statusToGlyph(phase.status);
      const color = statusToColor(phase.status);
      const parts: string[] = [];
      if (phase.durationMs !== undefined) parts.push(formatDuration(phase.durationMs));
      if (phase.tokensIn !== undefined || phase.tokensOut !== undefined) {
        parts.push(
          `in ${(phase.tokensIn ?? 0).toLocaleString()} / out ${(phase.tokensOut ?? 0).toLocaleString()} tok`,
        );
      }
      const tail = parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
      process.stdout.write(
        `  ${plainStyled(`${glyph} ${phase.id.padEnd(idWidth)}${tail}`, color)}\n`,
      );
    }

    process.stdout.write("\n");
    const totalDuration = final.phases.reduce((a, p) => a + (p.durationMs ?? 0), 0);
    const totalIn = final.phases.reduce((a, p) => a + (p.tokensIn ?? 0), 0);
    const totalOut = final.phases.reduce((a, p) => a + (p.tokensOut ?? 0), 0);
    const totalParts: string[] = [];
    if (totalDuration > 0) totalParts.push(formatDuration(totalDuration));
    if (totalIn > 0 || totalOut > 0) {
      totalParts.push(`${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out tok`);
    }
    const totalsLine =
      totalParts.length > 0 ? `  ${totalParts.join(" · ")}` : "  (no work recorded)";
    process.stdout.write(`${plainStyled(totalsLine, PALETTE.hint)}\n`);
    process.stdout.write(`${plainStyled(`  ${final.runId}`, PALETTE.hint)}\n`);
  }

  private decideGate(decision: GateDecision): void {
    const [gate, setGate] = this.gateSignal;
    const [, setHint] = this.hintSignal;
    const g = gate();
    if (!g) return;
    setGate(null);
    setHint("");
    // Gate panel is gone — shrink the footer back to baseline so the
    // long stretches of phase work get their scrollback real estate.
    if (this.renderer && !this.renderer.isDestroyed) {
      this.renderer.footerHeight = FOOTER_HEIGHT_BASE;
    }
    this.setPhase(g.ctx.phaseId, {
      status: decision.status === "approved" ? "done" : "failed",
      activity: undefined,
    });
    this.scrollback(
      `  ${decision.status === "approved" ? "✓" : "✗"} gate · ${g.ctx.phaseId} ${decision.status}`,
      decision.status === "approved" ? PALETTE.done : PALETTE.failed,
    );
    const resolve = this.pendingGate;
    this.pendingGate = null;
    resolve?.(decision);
  }

  private setPhase(id: string, patch: Partial<PhaseRow>): void {
    this.setPhases(
      "list",
      produce((list) => {
        const p = list.find((x) => x.id === id);
        if (p) Object.assign(p, patch);
      }),
    );
  }

  private get setPhases() {
    return this.phasesStore[1];
  }

  private scrollback(text: string, fg: string): void {
    if (!this.renderer || this.renderer.isDestroyed) return;
    writeScrollbackLine(this.renderer, text, fg);
  }

  /**
   * Emit a `── plan · qwen3.6:latest ─────…` divider in scrollback so
   * all the tool calls and prose that follow until the next phase
   * start are visually grouped under this phase.
   *
   * Implementation: a single TextRenderable with a StyledText body
   * (chunks for lead-rule / title / trail-rule, each with their own
   * fg). Going through one renderable avoids the flex-row width
   * arithmetic that wrapped the trail to a second line — Yoga only
   * has one child to lay out, so there's nothing to misallocate.
   */
  private writePhaseDivider(phaseId: string, model: string, iteration: number): void {
    if (!this.renderer || this.renderer.isDestroyed) return;
    // A blank line above keeps the divider from sitting right under
    // the previous phase's ✓ summary line — visual breathing room.
    writeScrollbackLine(this.renderer, "", PALETTE.text);
    this.renderer.writeToScrollback((ctx) => {
      const cols = ctx.width;
      const lead = "── ";
      const titleText = ` ${phaseId}${iteration > 1 ? ` ×${iteration}` : ""} · ${model} `;
      const trail = "─".repeat(Math.max(3, cols - lead.length - titleText.length));
      const styled = new StyledText([
        opentuiFg(PALETTE.border)(lead),
        opentuiFg(PALETTE.text)(titleText),
        opentuiFg(PALETTE.border)(trail),
      ]);
      const node = new TextRenderable(ctx.renderContext, {
        id: `phase-divider-${phaseId}-${iteration}`,
        content: styled,
        width: cols,
        height: 1,
        // Default TextBuffer wrap is on — without "none" the trailing
        // run of `─` characters gets wrapped to a second line even
        // though height:1 should clip. Force single-line.
        wrapMode: "none",
      });
      return { root: node, width: cols, height: 1, startOnNewLine: true, trailingNewline: true };
    });
  }
}

// ── Module helpers ────────────────────────────────────────────────────

const SLOW_TOOL_MS = 1_000;

/**
 * Split-footer height in rows. Baseline = outer border + paddingTop +
 * summary + flex spacer + hint. Gate-active = baseline rows + 3-line
 * gate panel (header / artefacts / approve-reject keys). We expand /
 * shrink at gate boundaries so the footer is slim outside of gates
 * and large enough not to clip the gate panel rows when one fires.
 */
const FOOTER_HEIGHT_BASE = 4;
const FOOTER_HEIGHT_GATE = 7;

const GRADIENT = ["#7AB8FF", "#A28BFF", "#D77CC8"] as const;

/**
 * One-line gradient banner + run header. The big block-font banner
 * rendered on every `ordin run` invocation costs ~7 vertical lines of
 * scrollback; this compact form keeps the brand identity (per-letter
 * gradient on `ordin`) while leaving room for the actual transcript
 * above the footer.
 *
 * Layout: a horizontal flex row of one TextRenderable per gradient
 * letter, then a single muted TextRenderable for the run metadata.
 * The dry-run path keeps the full ASCII banner via preview.tsx — that
 * output is one-shot and gets the brand moment instead.
 */
function writeBannerHeader(renderer: CliRenderer, header: RunHeader): void {
  const word = "ordin";
  const letters = word.split("");
  const stops = [...GRADIENT];
  const palette = letters.map((_, i) =>
    interpolateStops(stops, letters.length <= 1 ? 0 : i / (letters.length - 1)),
  );
  const meta = ` · ${header.task} · tier ${header.tier}`;
  const totalWidth = letters.length + meta.length;

  renderer.writeToScrollback((ctx) => {
    const row = new BoxRenderable(ctx.renderContext, {
      id: "ordin-banner-row",
      flexDirection: "row",
      width: Math.max(totalWidth, ctx.width),
      height: 1,
      backgroundColor: "transparent",
    });
    for (const [i, ch] of letters.entries()) {
      row.add(
        new TextRenderable(ctx.renderContext, {
          id: `ordin-banner-${i}`,
          content: ch,
          width: 1,
          height: 1,
          fg: palette[i],
        }),
      );
    }
    row.add(
      new TextRenderable(ctx.renderContext, {
        id: "ordin-banner-meta",
        content: meta,
        width: meta.length,
        height: 1,
        fg: PALETTE.hint,
      }),
    );
    return {
      root: row,
      width: ctx.width,
      height: 1,
      startOnNewLine: true,
      trailingNewline: true,
    };
  });
}

function writeScrollbackLine(renderer: CliRenderer, text: string, fg: string): void {
  renderer.writeToScrollback((ctx) => {
    const node = new TextRenderable(ctx.renderContext, {
      id: `ordin-line-${Math.random().toString(36).slice(2, 8)}`,
      content: text,
      width: Math.max(1, ctx.width),
      height: 1,
      fg,
    });
    return {
      root: node,
      width: ctx.width,
      height: 1,
      startOnNewLine: true,
      trailingNewline: true,
    };
  });
}

function interpolateStops(stops: string[], t: number): string {
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

function summariseToolInput(name: string, input: unknown): string | undefined {
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
      return cmd ? firstLine(cmd) : undefined;
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

function firstLine(s: string): string {
  const line = s.split("\n", 1)[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function statusToGlyph(status: PhaseRow["status"]): string {
  switch (status) {
    case "pending":
      return "◌";
    case "running":
      return "·";
    case "gate":
      return "◆";
    case "done":
      return "✓";
    case "failed":
      return "✗";
  }
}

function plainStyled(text: string, hex: string): string {
  if (process.env["NO_COLOR"] || process.stdout.isTTY !== true) return text;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function statusToColor(status: PhaseRow["status"]): string {
  switch (status) {
    case "pending":
      return PALETTE.pending;
    case "running":
      return PALETTE.running;
    case "gate":
      return PALETTE.gate;
    case "done":
      return PALETTE.done;
    case "failed":
      return PALETTE.failed;
  }
}
