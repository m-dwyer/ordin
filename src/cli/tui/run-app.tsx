/**
 * Solid component for the `ordin run` footer panel.
 *
 * Stateless against the run — all reactivity is sourced from the
 * controller passed as a prop (see controller.ts). The footer is
 * intentionally slim: a single one-line phase chain with rolled-up
 * totals, an animated `<spinner>` in place of the running phase's
 * glyph, and the Ctrl+C hint at the bottom. Tool calls and agent
 * prose stream into scrollback above, grouped under per-phase
 * divider headers emitted by the controller — so all per-phase
 * detail lives in the transcript, not in the footer.
 *
 * When a gate is active the gate panel takes the hint slot;
 * keypresses route back via state.decideGate.
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

      {/* Only push the hint to the bottom when there's no gate.
          When the gate panel is active it needs every available row;
          a flexGrow spacer was stealing one row and the gate header
          line was getting clipped into the artefacts line. */}
      <Show when={!state.gate()}>
        <box flexGrow={1} />
      </Show>

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

/**
 * One-line phase chain in the footer. Built as a flex row of mixed
 * children (text spans + an animated <spinner> for the running phase)
 * because the `<spinner>` is its own renderable — it can't sit inside
 * a `<text>` as a span. Using a row Box lets the spinner animate in
 * place between the previous phase's glyph and the running phase's
 * name, with phases joined by ▸ connectors.
 */
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
    <box flexDirection="row">
      <For each={props.phases}>
        {(phase, i) => (
          <box flexDirection="row">
            <Show when={i() > 0}>
              <text fg={PALETTE.border}> ▸ </text>
            </Show>
            <Show
              when={phase.status === "running"}
              fallback={<text fg={glyphColor(phase.status)}>{statusGlyph(phase.status)}</text>}
            >
              <spinner name="dots" color={PALETTE.running} />
            </Show>
            <text fg={glyphColor(phase.status)}> {phase.id}</text>
          </box>
        )}
      </For>
      <Show when={totals().durationMs > 0 || totals().tokensOut > 0}>
        <text fg={PALETTE.border}> · </text>
        <Show when={totals().durationMs > 0}>
          <text fg={PALETTE.hint}>{formatDuration(totals().durationMs)}</text>
        </Show>
        <Show when={totals().tokensOut > 0}>
          <text fg={PALETTE.border}> · </text>
          <text fg={PALETTE.hint}>
            {totals().tokensIn.toLocaleString()} in / {totals().tokensOut.toLocaleString()} out
          </text>
        </Show>
      </Show>
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
