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
 * `ordin run` uses the alternate screen so resize / terminal zoom
 * events redraw one coherent frame instead of baking partial footer
 * frames into scrollback. On exit, `printFinalSummary()` emits a
 * compact plain-stdout summary back on the main screen.
 */
import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { GateContext, GateDecision } from "../../gates/types";
import type { RunEvent, RunMeta } from "../../runtime/harness";
import { ansiStyled, firstLine, formatDuration, summariseToolInput } from "./format";
import { RunApp } from "./run-app";
import { PALETTE } from "./theme";
import type { ControllerState, FeedItem, GateState, PhaseRow, RunHeader } from "./types";

type RunStatus = RunMeta["status"];

export class OpenTuiRunController {
  private readonly phasesStore = createStore<{ list: PhaseRow[] }>({ list: [] });
  private readonly feedStore = createStore<{ items: FeedItem[] }>({ items: [] });
  private readonly gateSignal = createSignal<GateState | null>(null);
  private readonly hintSignal = createSignal("");
  private readonly toolMeta = new Map<
    string,
    { name: string; preview?: string; startedAt: number }
  >();

  private renderer?: CliRenderer;
  private pendingGate: ((d: GateDecision) => void) | null = null;
  private finished = false;
  private nextFeedId = 1;
  private finalSummary?: {
    runId: string;
    status: RunStatus;
    phases: PhaseRow[];
  };

  state(): ControllerState {
    const [phases] = this.phasesStore;
    const [feed] = this.feedStore;
    const [gate] = this.gateSignal;
    const [hint] = this.hintSignal;
    return {
      phases: () => phases.list,
      feed: () => feed.items,
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
      screenMode: "alternate-screen",
      externalOutputMode: "passthrough",
      consoleMode: "disabled",
      clearOnShutdown: true,
    });

    this.writeBannerHeader(header);

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
        this.writePhaseDivider(ev.phaseId, ev.model, ev.iteration);
        return;

      case "phase.runtime.completed":
        this.setPhase(ev.phaseId, {
          status: "running",
          activity: "validating outputs",
          durationMs: ev.durationMs,
          tokensIn: ev.tokens.input,
          tokensOut: ev.tokens.output,
        });
        return;

      case "phase.completed":
        this.setPhase(ev.phaseId, {
          status: "done",
          activity: undefined,
          durationMs: ev.durationMs,
          tokensIn: ev.tokens.input,
          tokensOut: ev.tokens.output,
          error: undefined,
        });
        this.appendFeed({
          glyph: "✓",
          label: ev.phaseId,
          detail: `${formatDuration(ev.durationMs)} · in ${ev.tokens.input.toLocaleString()} / out ${ev.tokens.output.toLocaleString()} tok`,
          color: PALETTE.done,
        });
        return;

      case "phase.failed":
        this.setPhase(ev.phaseId, {
          status: "failed",
          activity: undefined,
          error: firstLine(ev.error),
        });
        this.appendFeed({
          glyph: "✗",
          label: ev.phaseId,
          detail: firstLine(ev.error),
          color: PALETTE.failed,
        });
        return;

      case "agent.thinking":
        this.setPhase(ev.phaseId, { activity: "thinking…" });
        return;

      case "agent.text": {
        this.appendAgentText(ev.text);
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
        this.appendFeed({
          glyph: "▸",
          label: ev.name,
          ...(preview ? { detail: preview } : {}),
          color: PALETTE.toolName,
        });
        return;
      }

      case "agent.tool.result": {
        const meta = this.toolMeta.get(ev.id);
        if (!ev.ok) {
          const reason = ev.preview ? ` — ${firstLine(ev.preview)}` : "";
          this.appendFeed({
            glyph: "✗",
            label: meta?.name ?? ev.id,
            detail: `${meta?.preview ?? ""}${meta?.preview ? " · " : ""}failed${reason}`,
            color: PALETTE.failed,
          });
        } else if (meta && Date.now() - meta.startedAt > SLOW_TOOL_MS) {
          // Quick tools (Read/Grep) finish within a frame and would
          // double up on the ▸ line; only confirm tools whose latency
          // crosses the visibility threshold so the user knows they
          // returned.
          this.appendFeed({
            glyph: "✓",
            label: meta.name,
            detail: `${meta.preview ? `${meta.preview} · ` : ""}${formatDuration(Date.now() - meta.startedAt)}`,
            color: PALETTE.done,
          });
        }
        // Don't reset activity here — for fast tools (Read/Grep) the
        // result lands within a frame of the use, and flashing back to
        // "thinking…" makes tool names unreadable. The next
        // agent.thinking event resets it explicitly.
        return;
      }

      case "agent.error":
        this.appendFeed({
          glyph: "✗",
          label: "error",
          detail: ev.message.trim(),
          color: PALETTE.failed,
        });
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
    // Clear the hint while the gate is active — the gate panel
    // already shows the [a]/[r] keys, and rendering them again at
    // the bottom of the footer would print the same text twice.
    setHint("");
    return new Promise<GateDecision>((resolve) => {
      this.pendingGate = resolve;
    });
  }

  /**
   * Stash final summary state for later printing. `dispose()` exits
   * the alternate screen; then `printFinalSummary()` appends to the
   * user's normal terminal scrollback exactly once.
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
   * Tear down the alternate-screen renderer cleanly. Nothing from the
   * live app is meant to remain in scrollback; final durable output is
   * printed after teardown.
   */
  async dispose(): Promise<void> {
    if (this.renderer && !this.renderer.isDestroyed) {
      this.hintSignal[1]("");
      this.gateSignal[1](null);
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
      `${ansiStyled(lead, PALETTE.border)}${ansiStyled(titleText, statusColor)}${ansiStyled(trail, PALETTE.border)}\n`,
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
        `  ${ansiStyled(`${glyph} ${phase.id.padEnd(idWidth)}${tail}`, color)}\n`,
      );
      if (phase.error) {
        process.stdout.write(`    ${ansiStyled(phase.error, PALETTE.failed)}\n`);
      }
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
    process.stdout.write(`${ansiStyled(totalsLine, PALETTE.hint)}\n`);
    process.stdout.write(`${ansiStyled(`  ${final.runId}`, PALETTE.hint)}\n`);
  }

  private decideGate(decision: GateDecision): void {
    const [gate, setGate] = this.gateSignal;
    const [, setHint] = this.hintSignal;
    const g = gate();
    if (!g) return;
    setGate(null);
    setHint("");
    this.setPhase(g.ctx.phaseId, {
      status: decision.status === "approved" ? "done" : "failed",
      activity: undefined,
      ...(decision.status === "rejected" ? { error: decision.reason } : {}),
    });
    this.appendFeed({
      glyph: decision.status === "approved" ? "✓" : "✗",
      label: "gate",
      detail: `${g.ctx.phaseId} ${decision.status}`,
      color: decision.status === "approved" ? PALETTE.done : PALETTE.failed,
    });
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

  private appendFeed(item: Omit<FeedItem, "id">): void {
    const feedItem = { id: this.nextFeedId++, ...item };
    this.feedStore[1](
      "items",
      produce((items) => {
        items.push(feedItem);
        if (items.length > MAX_FEED_ITEMS) {
          items.splice(0, items.length - MAX_FEED_ITEMS);
        }
      }),
    );
    this.writeFeedItem(feedItem);
  }

  /**
   * Emit a compact phase marker in the persistent log.
   */
  private writePhaseDivider(phaseId: string, model: string, iteration: number): void {
    this.appendFeed({
      glyph: "─",
      label: phaseId,
      detail: `${model}${iteration > 1 ? ` · iteration ${iteration}` : ""}`,
      color: PALETTE.text,
    });
  }

  private writeBannerHeader(header: RunHeader): void {
    this.appendFeed({
      glyph: "",
      label: "ordin",
      detail: `${header.task} · tier ${header.tier}`,
      color: PALETTE.accent,
    });
  }

  private appendAgentText(text: string): void {
    const lines = text
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length > 0);
    for (const line of lines) {
      this.appendFeed({
        glyph: "│",
        label: "note",
        detail: line,
        color: PALETTE.text,
      });
    }
  }

  private writeFeedItem(_item: FeedItem): void {}
}

// ── Module helpers ────────────────────────────────────────────────────

const SLOW_TOOL_MS = 1_000;
const MAX_FEED_ITEMS = 120;

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
