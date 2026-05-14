/**
 * OpenTUI run controller — the long-lived TUI mount that backs
 * `ordin run`'s scrollback experience.
 *
 * The controller owns the renderer and the reactive state stores; the
 * `<RunApp>` Solid component (in run-app.tsx) reads from `state()` and
 * routes keypresses back via `decideGate`. The CLI wires it as both
 * the orchestrator's event sink (`pushEvent`) and the gate prompter's
 * backing store (`requestGate` returns a Promise the App resolves).
 *
 * Scrollback is structured as a list of phase sections — one per
 * `phase.started` event — so re-runs after a rejected gate produce a
 * new card alongside the original (audit trail). `phasesStore` is a
 * flat per-phase-id view used by the footer rail and the final
 * summary; `sectionsStore` is the per-execution log with rows.
 *
 * `ordin run` uses the alternate screen so resize / terminal zoom
 * events redraw one coherent frame instead of baking partial frames
 * into scrollback. On exit, `printFinalSummary()` emits a compact
 * plain-stdout summary back on the main screen.
 */
import { applyGain, type CliRenderer, createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { RunEvent, RunMeta } from "../../composition/harness";
import type { GateContext, GateDecision } from "../../gates/types";
import {
  ansiStyled,
  buildEditDiff,
  findCollapsibles,
  firstLine,
  formatDuration,
  summariseToolInput,
} from "./format";
import { PALETTE } from "./theme";
import type {
  ControllerState,
  EgressGateState,
  FeedRow,
  GateState,
  PhaseRow,
  PhaseSection,
  PhaseStatus,
  RunHeader,
  ScrollLike,
} from "./types";

type RunStatus = RunMeta["status"];

export class OpenTuiRunController {
  private readonly headerSignal = createSignal<RunHeader | null>(null);
  private readonly phasesStore = createStore<{ list: PhaseRow[] }>({ list: [] });
  private readonly sectionsStore = createStore<{ list: PhaseSection[] }>({ list: [] });
  private readonly gateSignal = createSignal<GateState | null>(null);
  private readonly egressGateSignal = createSignal<EgressGateState | null>(null);
  private readonly hintSignal = createSignal("");
  private readonly toolMeta = new Map<
    string,
    { name: string; preview?: string; startedAt: number; phaseId: string; rowId: number }
  >();
  private readonly expandedSignal = createSignal<ReadonlySet<number>>(new Set());
  private readonly collapsedPhasesSignal = createSignal<ReadonlySet<string>>(new Set());

  private readonly pausedSignal = createSignal<{ status: RunStatus } | null>(null);

  private renderer?: CliRenderer;
  private pendingGate: {
    resolve: (d: GateDecision) => void;
    reject: (err: Error) => void;
  } | null = null;
  private pendingEgressGate: {
    resolve: (approved: boolean) => void;
    reject: (err: Error) => void;
  } | null = null;
  private pendingDismiss: (() => void) | null = null;
  private abortSignal: AbortSignal | undefined;
  private finished = false;
  private nextRowId = 1;
  private nextSectionKey = 1;
  private currentPhaseId: string | null = null;
  private finalSummary?: {
    runId: string;
    status: RunStatus;
    phases: PhaseRow[];
  };

  state(): ControllerState {
    const [phases] = this.phasesStore;
    const [sections] = this.sectionsStore;
    const [gate] = this.gateSignal;
    const [egressGate] = this.egressGateSignal;
    const [hint] = this.hintSignal;
    const [header] = this.headerSignal;
    const [paused] = this.pausedSignal;
    const [expanded] = this.expandedSignal;
    const [collapsedPhases] = this.collapsedPhasesSignal;
    return {
      header,
      phases: () => phases.list,
      sections: () => sections.list,
      gate,
      egressGate,
      hint,
      paused,
      expanded,
      collapsedPhases,
      decideGate: (d) => this.decideGate(d),
      decideEgressGate: (a) => this.decideEgressGate(a),
      dismiss: () => this.dismiss(),
      toggleExpanded: (id) => this.toggleExpanded(id),
      collapseAll: () => this.collapseAll(),
      togglePhaseCollapsed: (key) => this.togglePhaseCollapsed(key),
      cycleNextCollapsed: (scroll) => this.cycleNextCollapsed(scroll),
    };
  }

  private togglePhaseCollapsed(sectionKey: string): void {
    const [get, set] = this.collapsedPhasesSignal;
    const next = new Set(get());
    if (next.has(sectionKey)) next.delete(sectionKey);
    else next.add(sectionKey);
    set(next);
  }

  async mount(header: RunHeader, phaseIds: readonly string[] = []): Promise<void> {
    this.headerSignal[1](header);
    if (phaseIds.length > 0) {
      this.setPhases("list", () => phaseIds.map((id) => ({ id, status: "pending", iteration: 1 })));
    }

    this.renderer = await createCliRenderer({
      targetFps: 30,
      // The CLI's installAbortHandler owns SIGINT — it triggers
      // cooperative abort, lets the engine unwind, and runs
      // session.dispose() (which destroys this renderer). Letting
      // OpenTUI also exit on Ctrl-C races our handler and skips the
      // unwind.
      exitOnCtrlC: false,
      useMouse: true,
      screenMode: "alternate-screen",
      externalOutputMode: "passthrough",
      consoleMode: "disabled",
      clearOnShutdown: true,
      backgroundColor: PALETTE.bg,
    });

    installPostProcess(this.renderer);

    // render() returns Promise<void>; the Solid tree's lifetime is tied
    // to the renderer — `renderer.destroy()` fires CliRenderEvents.DESTROY
    // which triggers each component's onCleanup.
    const { RunApp } = await import("./run-app");
    await render(() => RunApp({ state: this.state() }), this.renderer);
  }

  pushEvent(ev: RunEvent): void {
    switch (ev.type) {
      case "run.started":
        this.headerSignal[1]((h) => (h ? { ...h, runId: ev.runId } : h));
        return;
      case "run.completed":
      case "agent.tokens":
        return;

      case "phase.started": {
        const startedAt = Date.now();
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
              startedAt,
            };
            if (existing) Object.assign(existing, next);
            else list.push(next);
          }),
        );
        this.openSection(ev.phaseId, ev.model, ev.iteration, startedAt);
        return;
      }

      case "phase.runtime.completed":
        this.setPhase(ev.phaseId, {
          status: "running",
          activity: "validating outputs",
          durationMs: ev.durationMs,
          tokensIn: ev.tokens.input,
          tokensOut: ev.tokens.output,
        });
        this.patchActiveSection(ev.phaseId, {
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
        this.patchActiveSection(ev.phaseId, {
          status: "done",
          durationMs: ev.durationMs,
          tokensIn: ev.tokens.input,
          tokensOut: ev.tokens.output,
        });
        if (this.currentPhaseId === ev.phaseId) this.currentPhaseId = null;
        return;

      case "phase.failed":
        this.setPhase(ev.phaseId, {
          status: "failed",
          activity: undefined,
          error: firstLine(ev.error),
        });
        this.patchActiveSection(ev.phaseId, {
          status: "failed",
          error: firstLine(ev.error),
        });
        if (this.currentPhaseId === ev.phaseId) this.currentPhaseId = null;
        return;

      case "agent.thinking":
        this.setPhase(ev.phaseId, { activity: "thinking…" });
        return;

      case "agent.text": {
        this.appendNotes(ev.phaseId, ev.text);
        return;
      }

      case "agent.tool.use": {
        const preview = summariseToolInput(ev.name, ev.input);
        const label = `${ev.name}${preview ? ` · ${preview}` : ""}`;
        this.setPhase(ev.phaseId, { activity: label });
        const edit =
          ev.name === "Edit" || ev.name === "MultiEdit" || ev.name === "NotebookEdit"
            ? buildEditDiff(ev.name, ev.input)
            : undefined;
        const rowId = edit
          ? this.appendRow(ev.phaseId, {
              kind: "edit",
              tool: ev.name,
              detail: edit.filePath,
              edit,
            })
          : this.appendRow(ev.phaseId, {
              kind: "tool",
              tool: ev.name,
              ...(preview ? { detail: preview } : {}),
            });
        this.toolMeta.set(ev.id, {
          name: ev.name,
          ...(preview ? { preview } : {}),
          startedAt: Date.now(),
          phaseId: ev.phaseId,
          rowId,
        });
        return;
      }

      case "agent.tool.result": {
        const meta = this.toolMeta.get(ev.id);
        if (!meta) return;
        const elapsed = Date.now() - meta.startedAt;
        // Mutate the originating tool row in place — adds duration on
        // the right and (on failure) the failed flag + a reason note.
        // Avoids stacking a separate ResultRow under every tool call.
        if (!ev.ok) {
          const reason = ev.result ? firstLine(ev.result) : "failed";
          this.mutateRow(meta.phaseId, meta.rowId, {
            failed: true,
            extra: `${formatDuration(elapsed)} · ${reason}`,
            ...(ev.result ? { result: ev.result } : {}),
          });
        } else {
          this.mutateRow(meta.phaseId, meta.rowId, {
            extra: formatDuration(elapsed),
            ...(ev.result ? { result: ev.result } : {}),
          });
        }
        return;
      }

      case "agent.error":
        if (this.currentPhaseId) {
          this.appendRow(this.currentPhaseId, {
            kind: "error",
            detail: ev.message.trim(),
          });
        }
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
    const gate: GateState = { ctx };
    setGate(gate);
    this.patchActiveSection(ctx.phaseId, { status: "gate", gate });
    setHint("");
    if (this.abortSignal?.aborted) return Promise.reject(new Error("Run aborted"));
    return new Promise<GateDecision>((resolve, reject) => {
      this.pendingGate = { resolve, reject };
    });
  }

  /**
   * Egress gate: surfaced when srt's askCallback (via the broker) wants
   * the user's decision before allowing the inner to reach an
   * unallowlisted host. Independent of phase gates — fires mid-phase
   * during agent tool use. The promise resolves to true (allow + cache
   * for this run) or false (deny).
   */
  requestEgressGate(host: string, port: number | undefined): Promise<boolean> {
    const [, setEgress] = this.egressGateSignal;
    setEgress({ host, port });
    if (this.abortSignal?.aborted) return Promise.reject(new Error("Run aborted"));
    return new Promise<boolean>((resolve, reject) => {
      this.pendingEgressGate = { resolve, reject };
    });
  }

  /**
   * Bind the run's abort signal so Ctrl-C wakes up any pending gate
   * waits — otherwise the engine would block forever inside
   * `onGateRequested`. Idempotent; called once after construction.
   */
  bindAbortSignal(signal: AbortSignal): void {
    this.abortSignal = signal;
    signal.addEventListener("abort", () => this.cancelPendingGates());
  }

  private cancelPendingGates(): void {
    if (this.pendingGate) {
      const { reject } = this.pendingGate;
      this.pendingGate = null;
      reject(new Error("Run aborted"));
    }
    if (this.pendingEgressGate) {
      const { reject } = this.pendingEgressGate;
      this.pendingEgressGate = null;
      reject(new Error("Run aborted"));
    }
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
    // Pause the UI on every terminal status so the user can review
    // final state (artefacts, tool sequence, token usage, failure
    // context) before being thrown back to the shell. The alt-screen
    // TUI is a takeover UX — exiting it should be a deliberate
    // keypress, not silent teardown. Press `q` (handled in <RunApp>)
    // to dismiss.
    this.pausedSignal[1]({ status: summary.status });
  }

  /**
   * Tear down the alternate-screen renderer cleanly. Nothing from the
   * live app is meant to remain in scrollback; final durable output is
   * printed after teardown. If the run is paused (failed/halted),
   * blocks until the user dismisses so they can scroll the failure
   * context before being thrown back to the shell.
   */
  async dispose(): Promise<void> {
    if (this.pausedSignal[0]() && this.renderer && !this.renderer.isDestroyed) {
      await new Promise<void>((resolve) => {
        this.pendingDismiss = resolve;
      });
    }
    if (this.renderer && !this.renderer.isDestroyed) {
      this.hintSignal[1]("");
      this.gateSignal[1](null);
      this.egressGateSignal[1](null);
      this.renderer.destroy();
    }
    this.renderer = undefined;
  }

  /**
   * Called by the keyboard handler in `<RunApp>` when the user
   * dismisses a paused (failed/halted) run.
   */
  private dismiss(): void {
    if (!this.pausedSignal[0]()) return;
    this.pausedSignal[1](null);
    const resolve = this.pendingDismiss;
    this.pendingDismiss = null;
    resolve?.();
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

  private decideEgressGate(approved: boolean): void {
    const [, setEgress] = this.egressGateSignal;
    setEgress(null);
    const pending = this.pendingEgressGate;
    this.pendingEgressGate = null;
    pending?.resolve(approved);
  }

  private decideGate(decision: GateDecision): void {
    const [gate, setGate] = this.gateSignal;
    const [, setHint] = this.hintSignal;
    const g = gate();
    if (!g) return;
    setGate(null);
    setHint("");
    const newStatus: PhaseStatus = decision.status === "approved" ? "done" : "failed";
    this.setPhase(g.ctx.phaseId, {
      status: newStatus,
      activity: undefined,
      ...(decision.status === "rejected" ? { error: decision.reason } : {}),
    });
    this.patchActiveSection(g.ctx.phaseId, {
      status: newStatus,
      gate: undefined,
      ...(decision.status === "rejected" ? { error: decision.reason } : {}),
    });
    const pending = this.pendingGate;
    this.pendingGate = null;
    pending?.resolve(decision);
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

  private get setSections() {
    return this.sectionsStore[1];
  }

  private openSection(phaseId: string, model: string, iteration: number, startedAt: number): void {
    this.currentPhaseId = phaseId;
    const key = `${phaseId}#${this.nextSectionKey++}`;
    this.setSections(
      "list",
      produce((list) => {
        list.push({
          key,
          phaseId,
          status: "running",
          model,
          iteration,
          rows: [],
          startedAt,
        });
      }),
    );
  }

  /**
   * Patch the most recent section for `phaseId`. Older sections from
   * earlier iterations stay frozen — they are an audit trail.
   */
  private patchActiveSection(phaseId: string, patch: Partial<PhaseSection>): void {
    this.setSections(
      "list",
      produce((list) => {
        for (let i = list.length - 1; i >= 0; i--) {
          const section = list[i];
          if (section && section.phaseId === phaseId) {
            Object.assign(section, patch);
            return;
          }
        }
      }),
    );
  }

  private appendRow(phaseId: string, row: Omit<FeedRow, "id">): number {
    const id = this.nextRowId++;
    this.setSections(
      "list",
      produce((list) => {
        for (let i = list.length - 1; i >= 0; i--) {
          const section = list[i];
          if (section && section.phaseId === phaseId) {
            section.rows.push({ id, ...row });
            return;
          }
        }
      }),
    );
    return id;
  }

  /** Patch a row's mutable fields in place (extra, failed, etc.). The
   * row's identity is `(phaseId, rowId)` — phaseId narrows the search
   * to the matching section so we don't scan every section's rows. */
  private mutateRow(phaseId: string, rowId: number, patch: Partial<FeedRow>): void {
    this.setSections(
      "list",
      produce((list) => {
        for (let i = list.length - 1; i >= 0; i--) {
          const section = list[i];
          if (!section || section.phaseId !== phaseId) continue;
          const row = section.rows.find((r) => r.id === rowId);
          if (row) Object.assign(row, patch);
          return;
        }
      }),
    );
  }

  private toggleExpanded(id: number): void {
    const [get, set] = this.expandedSignal;
    const next = new Set(get());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set(next);
  }

  private collapseAll(): void {
    this.expandedSignal[1](new Set<number>());
  }

  /**
   * Walk every phase's collapsibles in order and expand the first one
   * not already expanded. Returns true if a row was expanded.
   * Optionally scrolls the scrollbox so the new content is visible —
   * we just jump to bottom for simplicity since notes/groups expand
   * "downward" (showing more rows where their stub used to be).
   */
  private cycleNextCollapsed(scroll?: ScrollLike): boolean {
    const [get, set] = this.expandedSignal;
    const expanded = get();
    for (const section of this.sectionsStore[0].list) {
      for (const c of findCollapsibles(section.rows)) {
        if (!expanded.has(c.id)) {
          const next = new Set(expanded);
          next.add(c.id);
          set(next);
          if (scroll) scroll.scrollTo({ x: 0, y: scroll.scrollHeight });
          return true;
        }
      }
    }
    return false;
  }

  private appendNotes(phaseId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.appendRow(phaseId, { kind: "note", detail: trimmed });
  }
}

// ── Module helpers ────────────────────────────────────────────────────

function statusToGlyph(status: PhaseStatus): string {
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

function statusToColor(status: PhaseStatus): string {
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

/**
 * Post-processing pipeline for the run UI.
 *
 * Currently a single one-shot 250ms gain ramp from black on first
 * paint — gives the alt-screen a smooth reveal instead of pop-in.
 * Self-disables once the ramp completes so there's zero per-frame
 * cost after.
 *
 * BloomEffect was tried and pulled: in a text-dense layout it lifts
 * dark bg cells (which sit next to many bright text cells) more than
 * it haloes the brights themselves (already near the 1.0 cap), so
 * the panel bg washed grey while the chip didn't get any noticeable
 * extra glow. A focused glow would need a targeted cellMask approach
 * (active-phase region only) instead of a global pass.
 */
function installPostProcess(renderer: CliRenderer): void {
  const fadeStart = Date.now();
  const fadeMs = 250;
  let faded = false;
  renderer.addPostProcessFn((buf) => {
    if (faded) return;
    const elapsed = Date.now() - fadeStart;
    if (elapsed >= fadeMs) {
      faded = true;
      return;
    }
    applyGain(buf, elapsed / fadeMs);
  });
}
