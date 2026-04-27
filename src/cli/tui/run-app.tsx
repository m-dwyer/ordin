/**
 * Solid component for the `ordin run` footer panel.
 *
 * Stateless against the run — all reactivity is sourced from the
 * controller passed as a prop (see controller.ts). In split-footer
 * mode this component owns only the live footer; the persistent run
 * log is written to real terminal scrollback by the controller.
 *
 * When a gate is active the gate panel takes the hint slot;
 * keypresses route back via state.decideGate.
 */
import { useKeyboard } from "@opentui/solid";
import "opentui-spinner/solid";
import { createMemo, For, Show } from "solid-js";
import type { GateContext } from "../../gates/types";
import { formatDuration } from "./format";
import { PALETTE } from "./theme";
import type { ControllerState, FeedItem, GateState, PhaseRow } from "./types";

export interface RunAppProps {
  state: ControllerState;
}

export function RunApp(props: RunAppProps) {
  const { state } = props;
  const phases = () => state.phases();
  const activePhase = createMemo(() => {
    const list = phases();
    return (
      list.find((p) => p.status === "running" || p.status === "gate") ??
      [...list].reverse().find((p) => p.status === "done" || p.status === "failed") ??
      null
    );
  });

  useKeyboard((key) => {
    if (!state.gate()) return;
    if (key.name === "a") state.decideGate({ status: "approved" });
    else if (key.name === "r") state.decideGate({ status: "rejected", reason: "rejected at gate" });
  });

  return (
    <box
      width="100%"
      height="100%"
      paddingTop={0}
      paddingBottom={0}
      paddingLeft={2}
      paddingRight={2}
      backgroundColor="transparent"
      flexDirection="column"
      gap={0}
    >
      <FeedView items={state.feed()} />
      <Footer phases={phases()} active={activePhase()} gate={state.gate()} hint={state.hint()} />
    </box>
  );
}

function FeedView(props: { items: readonly FeedItem[] }) {
  return (
    <scrollbox width="100%" flexGrow={1} stickyScroll stickyStart="bottom">
      <box width="100%" flexDirection="column">
        <For each={props.items}>
          {(item) => (
            <box width="100%" flexDirection="row">
              <text width={3} fg={item.color} wrapMode="none" truncate content={item.glyph} />
              <text width={10} fg={item.color} wrapMode="none" truncate content={item.label} />
              <text flexGrow={1} fg={item.color} wrapMode="word" content={item.detail ?? ""} />
            </box>
          )}
        </For>
      </box>
    </scrollbox>
  );
}

function Footer(props: {
  phases: readonly PhaseRow[];
  active: PhaseRow | null;
  gate: GateState | null;
  hint: string;
}) {
  return (
    <box height={props.gate ? 8 : 5} flexShrink={0} flexDirection="column">
      <text
        height={1}
        width="100%"
        fg={PALETTE.border}
        wrapMode="none"
        truncate
        content="────────────────────────────────────────────────────────────────────────────────"
      />
      <Show
        when={props.phases.length > 0}
        fallback={
          <>
            <text
              height={1}
              fg={PALETTE.hint}
              wrapMode="none"
              truncate
              content="preparing run..."
            />
            <text height={1} content="" />
            <text height={1} content="" />
          </>
        }
      >
        <StatusStrip phases={props.phases} active={props.active} showTotals={!props.gate} />
        <PhaseRail phases={props.phases} />
      </Show>

      <Show when={props.gate} keyed fallback={<HintLine hint={props.hint} />}>
        {(gate: GateState) => <GatePanel ctx={gate.ctx} />}
      </Show>
    </box>
  );
}

function HintLine(props: { hint: string }) {
  return (
    <text
      height={1}
      width="100%"
      fg={PALETTE.hint}
      wrapMode="none"
      truncate
      content={props.hint || "Ctrl+C to abort"}
    />
  );
}

/**
 * One-line phase chain in the footer. It is intentionally a single
 * text renderable so OpenTUI can truncate it as one row at narrow
 * widths instead of wrapping each phase segment independently.
 */
function PhaseRail(props: { phases: readonly PhaseRow[] }) {
  return (
    <box height={1} width="100%" flexDirection="row">
      <For each={props.phases}>
        {(phase, i) => (
          <box flexDirection="row" flexShrink={1}>
            <Show when={i() > 0}>
              <text width={3} fg={PALETTE.muted} wrapMode="none" truncate content=" ▸ " />
            </Show>
            <PhaseGlyph phase={phase} />
            <text
              flexShrink={1}
              fg={phase.status === "pending" ? PALETTE.pending : PALETTE.text}
              wrapMode="none"
              truncate
              content={` ${phase.id}`}
            />
          </box>
        )}
      </For>
    </box>
  );
}

function StatusStrip(props: {
  phases: readonly PhaseRow[];
  active: PhaseRow | null;
  showTotals: boolean;
}) {
  const totals = phaseTotals(() => props.phases);
  const title = () => `ordin · run${props.active ? ` · ${props.active.id}` : ""}`;
  return (
    <>
      <text
        height={1}
        width="100%"
        fg={props.active ? glyphColor(props.active.status) : PALETTE.accent}
        wrapMode="none"
        truncate
        content={title()}
      />
      <Show when={props.showTotals && (totals().durationMs > 0 || totals().tokensOut > 0)}>
        <text
          height={1}
          width="100%"
          fg={PALETTE.hint}
          wrapMode="none"
          truncate
          content={formatTotals(totals())}
        />
      </Show>
      <Show when={!props.showTotals || (totals().durationMs === 0 && totals().tokensOut === 0)}>
        <text height={1} width="100%" content="" />
      </Show>
    </>
  );
}

function phaseTotals(phases: () => readonly PhaseRow[]) {
  const totals = () => {
    let durationMs = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const p of phases()) {
      if (p.durationMs !== undefined) durationMs += p.durationMs;
      if (p.tokensIn !== undefined) tokensIn += p.tokensIn;
      if (p.tokensOut !== undefined) tokensOut += p.tokensOut;
    }
    return { durationMs, tokensIn, tokensOut };
  };
  return totals;
}

function GatePanel(props: { ctx: GateContext }) {
  const artefactText = () => props.ctx.artefacts.map((a) => a.path).join(", ");

  return (
    <box
      height={5}
      paddingTop={0}
      paddingBottom={0}
      backgroundColor="transparent"
      flexDirection="column"
    >
      <text
        height={1}
        width="100%"
        fg={PALETTE.gate}
        wrapMode="none"
        truncate
        content="◆ approval required"
      />
      <text
        height={1}
        width="100%"
        fg={PALETTE.text}
        wrapMode="none"
        truncate
        content={`phase · ${props.ctx.phaseId}`}
      />
      <Show when={props.ctx.summary} keyed>
        {(summary: string) => (
          <text
            height={1}
            width="100%"
            fg={PALETTE.hint}
            wrapMode="none"
            truncate
            content={summary}
          />
        )}
      </Show>
      <Show when={!props.ctx.summary}>
        <text height={1} width="100%" content="" />
      </Show>
      <Show when={props.ctx.artefacts.length > 0}>
        <text
          height={1}
          width="100%"
          fg={PALETTE.toolPreview}
          wrapMode="none"
          truncate
          content={`artefacts · ${artefactText()}`}
        />
      </Show>
      <Show when={props.ctx.artefacts.length === 0}>
        <text height={1} width="100%" content="" />
      </Show>
      <text
        height={1}
        width="100%"
        fg={PALETTE.text}
        wrapMode="none"
        truncate
        content="a approve   r reject"
      />
    </box>
  );
}

function formatTotals(totals: { durationMs: number; tokensIn: number; tokensOut: number }): string {
  const parts: string[] = [];
  if (totals.durationMs > 0) parts.push(formatDuration(totals.durationMs));
  if (totals.tokensIn > 0) parts.push(`${totals.tokensIn.toLocaleString()} in`);
  if (totals.tokensOut > 0) parts.push(`${totals.tokensOut.toLocaleString()} out`);
  return parts.join(" · ");
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

function PhaseGlyph(props: { phase: PhaseRow }) {
  return (
    <Show
      when={props.phase.status === "running"}
      fallback={
        <text
          width={1}
          fg={glyphColor(props.phase.status)}
          wrapMode="none"
          truncate
          content={statusGlyph(props.phase.status)}
        />
      }
    >
      <box width={1} height={1} overflow="hidden">
        <spinner name="dots" color={PALETTE.running} />
      </box>
    </Show>
  );
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
