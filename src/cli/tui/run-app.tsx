/**
 * Solid component for the `ordin run` footer panel.
 *
 * Stateless against the run — all reactivity is sourced from the
 * controller passed as a prop (see controller.ts). The footer is
 * intentionally slim: a one-line summary chain of phases (with
 * rolled-up totals) plus a single "active phase" indicator showing
 * the running phase's current activity. Tool calls and agent prose
 * stream into scrollback above, grouped under per-phase divider
 * headers emitted by the controller — so the visual hierarchy lives
 * where it belongs (the transcript), not in a fat bottom panel.
 *
 * When a gate is active, the gate panel takes the place of the
 * active-phase line + hint; keypresses route back via state.decideGate.
 */
import { useKeyboard } from "@opentui/solid";
import "opentui-spinner/solid";
import { For, Show } from "solid-js";
import type { GateContext } from "../../gates/types";
import { PALETTE } from "./theme";
import type { ControllerState, GateState, PhaseRow } from "./types";

export interface RunAppProps {
  state: ControllerState;
}

export function RunApp(props: RunAppProps) {
  const { state } = props;

  useKeyboard((key) => {
    if (!state.gate()) return;
    if (key.name === "a") state.decideGate({ status: "approved" });
    else if (key.name === "r") state.decideGate({ status: "rejected", reason: "rejected at gate" });
  });

  const activePhase = () => state.phases().find((p) => p.status === "running");

  return (
    <box
      width="100%"
      height="100%"
      paddingTop={1}
      paddingBottom={0}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor="transparent"
      border={["top"]}
      borderColor={PALETTE.border}
      flexDirection="column"
    >
      <Show
        when={state.phases().length > 0}
        fallback={<text fg={PALETTE.hint}>preparing run…</text>}
      >
        <SummaryLine phases={state.phases()} />
      </Show>

      <Show when={activePhase() && !state.gate()} keyed>
        {(phase: PhaseRow) => <ActivePhaseLine phase={phase} />}
      </Show>

      <box flexGrow={1} />

      <Show
        when={state.gate()}
        keyed
        fallback={<text fg={PALETTE.hint}>{state.hint() || "Ctrl+C to abort"}</text>}
      >
        {(gate: GateState) => <GatePanel ctx={gate.ctx} />}
      </Show>
    </box>
  );
}

function SummaryLine(props: { phases: readonly PhaseRow[] }) {
  const totals = () => {
    let durationMs = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const p of props.phases) {
      if (p.durationMs !== undefined) durationMs += p.durationMs;
      if (p.tokensIn !== undefined) tokensIn += p.tokensIn;
      if (p.tokensOut !== undefined) tokensOut += p.tokensOut;
    }
    return { durationMs, tokensIn, tokensOut };
  };

  return (
    <text>
      <For each={props.phases}>
        {(phase, i) => (
          <>
            <Show when={i() > 0}>
              <span style={{ fg: PALETTE.border }}> · </span>
            </Show>
            <span style={{ fg: glyphColor(phase.status) }}>
              {statusGlyph(phase.status)} {phase.id}
            </span>
          </>
        )}
      </For>
      <Show when={totals().durationMs > 0 || totals().tokensOut > 0}>
        <span style={{ fg: PALETTE.border }}> · </span>
        <Show when={totals().durationMs > 0}>
          <span style={{ fg: PALETTE.hint }}>{formatDuration(totals().durationMs)}</span>
        </Show>
        <Show when={totals().tokensOut > 0}>
          <span style={{ fg: PALETTE.border }}> · </span>
          <span style={{ fg: PALETTE.hint }}>
            {totals().tokensIn.toLocaleString()} in / {totals().tokensOut.toLocaleString()} out
          </span>
        </Show>
      </Show>
    </text>
  );
}

/**
 * Slim "what's happening right now" line for the running phase. Lives
 * just below the SummaryLine so the user has both bird's-eye context
 * (chain + totals) and ground-truth context (active phase, model,
 * current tool). Replaces the old per-phase rows entirely; per-phase
 * detail now lives in scrollback under the phase divider header.
 */
function ActivePhaseLine(props: { phase: PhaseRow }) {
  return (
    <box flexDirection="row">
      <spinner name="dots" color={PALETTE.running} />
      <text>
        <span style={{ fg: PALETTE.text }}> {props.phase.id}</span>
        <Show when={props.phase.iteration > 1}>
          <span style={{ fg: PALETTE.hint }}> ×{props.phase.iteration}</span>
        </Show>
        <Show when={props.phase.model}>
          <span style={{ fg: PALETTE.border }}> · </span>
          <span style={{ fg: PALETTE.hint }}>{props.phase.model}</span>
        </Show>
        <Show when={props.phase.activity}>
          <span style={{ fg: PALETTE.border }}> · </span>
          <span style={{ fg: PALETTE.toolPreview }}>{props.phase.activity}</span>
        </Show>
      </text>
    </box>
  );
}

function GatePanel(props: { ctx: GateContext }) {
  return (
    <box
      paddingTop={0}
      paddingBottom={0}
      backgroundColor="transparent"
      border={["top"]}
      borderColor={PALETTE.border}
      flexDirection="column"
    >
      <text>
        <span style={{ fg: PALETTE.gate }}>◆</span>
        <span style={{ fg: PALETTE.text }}> Gate · {props.ctx.phaseId}</span>
        <Show when={props.ctx.summary}>
          <span style={{ fg: PALETTE.hint }}> — {props.ctx.summary}</span>
        </Show>
      </text>
      <Show when={props.ctx.artefacts.length > 0}>
        <text>
          <span style={{ fg: PALETTE.hint }}>artefacts: </span>
          <span style={{ fg: PALETTE.toolPreview }}>
            {props.ctx.artefacts.map((a) => a.path).join(", ")}
          </span>
        </text>
      </Show>
      <text>
        <span style={{ fg: PALETTE.done }}>[a]</span>
        <span style={{ fg: PALETTE.text }}> approve </span>
        <span style={{ fg: PALETTE.failed }}>[r]</span>
        <span style={{ fg: PALETTE.text }}> reject</span>
      </text>
    </box>
  );
}

function statusGlyph(s: PhaseRow["status"]): string {
  switch (s) {
    case "pending":
      return "◌";
    case "running":
      return "⠋";
    case "gate":
      return "◆";
    case "done":
      return "✓";
    case "failed":
      return "✗";
  }
}

function glyphColor(s: PhaseRow["status"]): string {
  return s === "pending"
    ? PALETTE.pending
    : s === "running"
      ? PALETTE.running
      : s === "gate"
        ? PALETTE.gate
        : s === "done"
          ? PALETTE.done
          : PALETTE.failed;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}
