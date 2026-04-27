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
import { type CliRenderer, createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { GateContext, GateDecision } from "../../gates/types";
import type { RunEvent, RunMeta } from "../../runtime/harness";
import { ansiStyled, buildEditDiff, firstLine, formatDuration, summariseToolInput } from "./format";
import { RunApp } from "./run-app";
import { PALETTE } from "./theme";
import type {
  ControllerState,
  FeedRow,
  GateState,
  PhaseRow,
  PhaseSection,
  PhaseStatus,
  RunHeader,
} from "./types";

type RunStatus = RunMeta["status"];

export class OpenTuiRunController {
  private readonly headerSignal = createSignal<RunHeader | null>(null);
  private readonly phasesStore = createStore<{ list: PhaseRow[] }>({ list: [] });
  private readonly sectionsStore = createStore<{ list: PhaseSection[] }>({ list: [] });
  private readonly gateSignal = createSignal<GateState | null>(null);
  private readonly hintSignal = createSignal("");
  private readonly toolMeta = new Map<
    string,
    { name: string; preview?: string; startedAt: number; phaseId: string }
  >();

  private renderer?: CliRenderer;
  private pendingGate: ((d: GateDecision) => void) | null = null;
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
    const [hint] = this.hintSignal;
    const [header] = this.headerSignal;
    return {
      header,
      phases: () => phases.list,
      sections: () => sections.list,
      gate,
      hint,
      decideGate: (d) => this.decideGate(d),
    };
  }

  async mount(header: RunHeader, phaseIds: readonly string[] = []): Promise<void> {
    this.headerSignal[1](header);
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
      backgroundColor: PALETTE.bg,
    });

    // render() returns Promise<void>; the Solid tree's lifetime is tied
    // to the renderer — `renderer.destroy()` fires CliRenderEvents.DESTROY
    // which triggers each component's onCleanup.
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
        this.toolMeta.set(ev.id, {
          name: ev.name,
          ...(preview ? { preview } : {}),
          startedAt: Date.now(),
          phaseId: ev.phaseId,
        });
        const label = `${ev.name}${preview ? ` · ${preview}` : ""}`;
        this.setPhase(ev.phaseId, { activity: label });
        const edit =
          ev.name === "Edit" || ev.name === "MultiEdit" || ev.name === "NotebookEdit"
            ? buildEditDiff(ev.name, ev.input)
            : undefined;
        if (edit) {
          this.appendRow(ev.phaseId, {
            kind: "edit",
            tool: ev.name,
            detail: edit.filePath,
            edit,
          });
        } else {
          this.appendRow(ev.phaseId, {
            kind: "tool",
            tool: ev.name,
            ...(preview ? { detail: preview } : {}),
          });
        }
        return;
      }

      case "agent.tool.result": {
        const meta = this.toolMeta.get(ev.id);
        if (!meta) return;
        if (!ev.ok) {
          const reason = ev.preview ? ` — ${firstLine(ev.preview)}` : "";
          this.appendRow(meta.phaseId, {
            kind: "error",
            tool: meta.name,
            detail: `${meta.preview ? `${meta.preview} · ` : ""}failed${reason}`,
          });
        } else if (Date.now() - meta.startedAt > SLOW_TOOL_MS) {
          // Quick tools (Read/Grep) finish within a frame and would
          // double up on the ▸ line; only confirm tools whose latency
          // crosses the visibility threshold so the user knows they
          // returned.
          this.appendRow(meta.phaseId, {
            kind: "result",
            tool: meta.name,
            ...(meta.preview ? { detail: meta.preview } : {}),
            extra: formatDuration(Date.now() - meta.startedAt),
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

  private appendRow(phaseId: string, row: Omit<FeedRow, "id">): void {
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
  }

  private appendNotes(phaseId: string, text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.appendRow(phaseId, { kind: "note", detail: trimmed });
  }
}

// ── Module helpers ────────────────────────────────────────────────────

const SLOW_TOOL_MS = 1_000;

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
