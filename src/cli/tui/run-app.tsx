/**
 * Solid component for the `ordin run` footer panel.
 *
 * Stateless against the run — all reactivity is sourced from the
 * controller passed as a prop (see controller.ts). The component
 * renders the live phase list and, when a gate is active, replaces
 * the hint line with an interactive gate panel. Keypresses route back
 * to the controller via `state.decideGate`.
 */
import { useKeyboard } from "@opentui/solid";
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
      backgroundColor={PALETTE.panel}
      border={["top"]}
      borderColor={PALETTE.border}
      flexDirection="column"
    >
      <For each={state.phases()} fallback={<text fg={PALETTE.hint}>preparing run…</text>}>
        {(phase) => <PhaseRowView phase={phase} />}
      </For>

      <box flexGrow={1} />

      <Show when={state.gate()} keyed>
        {(gate: GateState) => <GatePanel ctx={gate.ctx} />}
      </Show>

      <text fg={PALETTE.hint}>{state.hint() || "Ctrl+C to abort"}</text>
    </box>
  );
}

function PhaseRowView(props: { phase: PhaseRow }) {
  return (
    <text>
      <span style={{ fg: glyphColor(props.phase.status) }}>{statusGlyph(props.phase.status)}</span>
      <span style={{ fg: PALETTE.text }}> {props.phase.id.padEnd(8)}</span>
      <Show when={props.phase.iteration > 1}>
        <span style={{ fg: PALETTE.hint }}> ×{props.phase.iteration}</span>
      </Show>
      <Show when={props.phase.status === "running" && props.phase.model}>
        <span style={{ fg: PALETTE.hint }}> {props.phase.model}</span>
      </Show>
      <Show when={props.phase.activity}>
        <span style={{ fg: PALETTE.hint }}> · </span>
        <span style={{ fg: PALETTE.toolPreview }}>{props.phase.activity}</span>
      </Show>
      <Show when={props.phase.status === "done" && props.phase.durationMs !== undefined}>
        <span style={{ fg: PALETTE.hint }}>
          {" "}
          {formatDuration(props.phase.durationMs ?? 0)}
          {props.phase.tokensOut !== undefined
            ? ` · ${props.phase.tokensOut.toLocaleString()} tok`
            : ""}
        </span>
      </Show>
    </text>
  );
}

function GatePanel(props: { ctx: GateContext }) {
  return (
    <box
      paddingTop={0}
      paddingBottom={0}
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
        <span style={{ fg: PALETTE.gate }}>[a]</span>
        <span style={{ fg: PALETTE.text }}> approve </span>
        <span style={{ fg: PALETTE.gate }}>[r]</span>
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
