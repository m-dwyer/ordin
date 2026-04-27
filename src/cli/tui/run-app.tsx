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
        <text fg={PALETTE.border}> </text>
      </Show>
      <For each={state.phases()}>{(phase) => <PhaseRowView phase={phase} />}</For>

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
              <span style={{ fg: PALETTE.border }}> ▸ </span>
            </Show>
            <span style={{ fg: glyphColor(phase.status) }}>{phase.id}</span>
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

const PHASE_ID_WIDTH = 8;
const ACTIVITY_INDENT = " ".repeat(PHASE_ID_WIDTH + 3);

function PhaseRowView(props: { phase: PhaseRow }) {
  const showActivityBelow = () => props.phase.status === "running" && Boolean(props.phase.activity);

  return (
    <box flexDirection="column">
      <box flexDirection="row">
        <Show
          when={props.phase.status === "running"}
          fallback={
            <text>
              <span style={{ fg: glyphColor(props.phase.status) }}>
                {statusGlyph(props.phase.status)}
              </span>
            </text>
          }
        >
          <spinner name="dots" color={PALETTE.running} />
        </Show>
        <text>
          <span style={{ fg: PALETTE.text }}> {props.phase.id.padEnd(PHASE_ID_WIDTH)}</span>
          <Show when={props.phase.iteration > 1}>
            <span style={{ fg: PALETTE.hint }}> ×{props.phase.iteration}</span>
          </Show>
          <Show when={props.phase.status === "running" && props.phase.model}>
            <span style={{ fg: PALETTE.hint }}> {props.phase.model}</span>
          </Show>
          <Show
            when={
              props.phase.status !== "running" &&
              props.phase.status !== "pending" &&
              props.phase.activity
            }
          >
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
      </box>
      <Show when={showActivityBelow()}>
        <text>
          <span style={{ fg: PALETTE.hint }}>{ACTIVITY_INDENT}▸ </span>
          <span style={{ fg: PALETTE.toolPreview }}>{props.phase.activity}</span>
        </text>
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
