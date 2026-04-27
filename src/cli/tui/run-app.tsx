/**
 * Solid component for the `ordin run` UI.
 *
 * Stateless against the run — all reactivity is sourced from the
 * controller passed as a prop (see controller.ts). The scrollback
 * renders one `<PhaseCard>` per phase execution (re-runs after a
 * rejected gate produce a new card so attempts stay visible). The
 * footer is a slim 3-row chrome that never expands; gate UI is
 * rendered *inside* the active phase card, not in the footer.
 *
 * Truncation rule: transcript content (tool details, notes, errors,
 * card summaries) never truncates — only word-wraps. Footer chrome
 * (status line, phase rail, key hint) truncates because it is fixed
 * to one cell row by design.
 *
 * Why no `t\`\``: @opentui/solid's reconciler stringifies the
 * `content` prop, so passing a `StyledText` becomes "[object Object]".
 * Mixed inline colour is achieved by composing multiple `<text>`
 * elements in a flex row instead.
 */
import { type ScrollBoxRenderable, SyntaxStyle, TextAttributes } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import "opentui-spinner/solid";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { GateContext } from "../../gates/types";
import { RunBanner } from "./banner";
import { formatElapsed, shortenPath, toolRowStyle } from "./format";
import { PALETTE } from "./theme";
import type {
  ControllerState,
  EditDiff,
  FeedRow,
  GateState,
  PausedState,
  PhaseRow,
  PhaseSection,
  PhaseStatus,
  RunHeader,
} from "./types";

/**
 * Shared `SyntaxStyle` for `<markdown>` (and `<diff>`-via-markdown).
 * Lazily constructed because `SyntaxStyle.create()` allocates a Zig
 * pointer; keeping it as a module-level singleton means one allocation
 * for the whole TUI lifetime instead of one per render.
 */
let _markdownSyntax: SyntaxStyle | null = null;
function markdownSyntax(): SyntaxStyle {
  if (!_markdownSyntax) _markdownSyntax = SyntaxStyle.create();
  return _markdownSyntax;
}

export interface RunAppProps {
  state: ControllerState;
}

export function RunApp(props: RunAppProps) {
  const { state } = props;
  const phases = () => state.phases();
  const sections = () => state.sections();
  const dims = useTerminalDimensions();
  const cols = () => dims().width;

  const activePhase = createMemo(() => {
    const list = phases();
    return (
      list.find((p) => p.status === "running" || p.status === "gate") ??
      [...list].reverse().find((p) => p.status === "done" || p.status === "failed") ??
      null
    );
  });

  // 1Hz tick drives live elapsed time on the active phase. Stops
  // affecting the title when no phase is running (the title accessor
  // ignores `now()` in that case), so re-rendering is cheap.
  const [now, setNow] = createSignal(Date.now());
  const tick = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(tick));

  let scrollboxEl: ScrollBoxRenderable | undefined;

  useKeyboard((key) => {
    // Gate prompt — single-key approve/reject takes priority.
    if (state.gate()) {
      if (key.name === "a") state.decideGate({ status: "approved" });
      else if (key.name === "r")
        state.decideGate({ status: "rejected", reason: "rejected at gate" });
      return;
    }
    // Paused (failed/halted) — q/esc/enter dismisses the alt-screen.
    if (state.paused() && (key.name === "q" || key.name === "escape" || key.name === "return")) {
      state.dismiss();
      return;
    }
    // Scroll keys — work any time. j/k for vim users, arrows + page
    // keys for everyone else, g/G for jump-to-top/bottom.
    if (!scrollboxEl) return;
    const viewportH = scrollboxEl.viewport.height || 10;
    switch (key.name) {
      case "down":
      case "j":
        scrollboxEl.scrollBy({ x: 0, y: 1 });
        break;
      case "up":
      case "k":
        scrollboxEl.scrollBy({ x: 0, y: -1 });
        break;
      case "pagedown":
      case "space":
        scrollboxEl.scrollBy({ x: 0, y: viewportH - 2 });
        break;
      case "pageup":
      case "b":
        scrollboxEl.scrollBy({ x: 0, y: -(viewportH - 2) });
        break;
      case "G":
        scrollboxEl.scrollTo({ x: 0, y: scrollboxEl.scrollHeight });
        break;
      case "g":
        scrollboxEl.scrollTo({ x: 0, y: 0 });
        break;
    }
  });

  return (
    <box
      width="100%"
      height="100%"
      paddingTop={0}
      paddingBottom={0}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={PALETTE.bg}
      flexDirection="column"
      gap={0}
    >
      <ScrollbackView
        header={state.header()}
        sections={sections()}
        cols={cols()}
        scrollboxRef={(el) => {
          scrollboxEl = el;
        }}
      />
      <Footer
        phases={phases()}
        active={activePhase()}
        gate={state.gate()}
        paused={state.paused()}
        hint={state.hint()}
        cols={cols()}
        now={now()}
      />
    </box>
  );
}

// ── Scrollback ──────────────────────────────────────────────────────

function ScrollbackView(props: {
  header: RunHeader | null;
  sections: readonly PhaseSection[];
  cols: number;
  scrollboxRef: (el: ScrollBoxRenderable) => void;
}) {
  const repoPath = () => props.header?.repoPath;
  return (
    <scrollbox
      ref={props.scrollboxRef}
      width="100%"
      flexGrow={1}
      stickyScroll
      stickyStart="bottom"
      verticalScrollbarOptions={{ visible: false }}
      horizontalScrollbarOptions={{ visible: false }}
    >
      <box width="100%" flexDirection="column" gap={1}>
        <Show when={props.header} keyed>
          {(header: RunHeader) => <RunBanner header={header} />}
        </Show>
        <For each={props.sections}>
          {(section) => <PhaseCard section={section} cols={props.cols} repoPath={repoPath()} />}
        </For>
      </box>
    </scrollbox>
  );
}

/**
 * A phase renders as a thin left-border `│` + a darker panel
 * background. No top/bottom/right border — borrowed from OpenCode's
 * message-panel style for compact visual hierarchy.
 */
function PhaseCard(props: { section: PhaseSection; cols: number; repoPath?: string }) {
  const color = () => statusColor(props.section.status);
  const showSummary = () => props.section.status === "done" || props.section.status === "failed";

  return (
    <box
      width="100%"
      flexDirection="column"
      backgroundColor={PALETTE.panel}
      border={["left"]}
      borderColor={
        props.section.status === "running" || props.section.status === "gate"
          ? statusColor(props.section.status)
          : PALETTE.borderStrong
      }
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={1}
    >
      <PhaseHeader section={props.section} cols={props.cols} color={color()} />
      {/* Wrap the row stream in a concrete box so its position is
          anchored even when rows arrive AFTER sibling Show conditions
          have already mounted (otherwise rows append at the end of
          the parent regardless of JSX order). */}
      <box width="100%" flexDirection="column">
        <For each={props.section.rows}>{(row) => <Row row={row} repoPath={props.repoPath} />}</For>
      </box>
      <Show when={props.section.gate} keyed>
        {(gate: GateState) => <GateCard ctx={gate.ctx} repoPath={props.repoPath} />}
      </Show>
      <Show when={showSummary()}>
        <SummaryLine section={props.section} />
      </Show>
      <Show when={props.section.status === "failed" && props.section.error}>
        <text fg={PALETTE.failed} wrapMode="word" content={props.section.error ?? ""} />
      </Show>
    </box>
  );
}

/**
 * Header row for a phase card: animated spinner (when running) or
 * static status glyph (otherwise) + bold phase id with optional
 * model + iteration metadata. Replaces the `<box title>` string prop
 * approach so the running state can host a real `<spinner>`.
 */
function PhaseHeader(props: { section: PhaseSection; cols: number; color: string }) {
  const text = () => {
    const id = props.section.phaseId;
    const iter = props.section.iteration > 1 ? ` · iter ${props.section.iteration}` : "";
    if (props.cols < 80) return `${id}${iter}`;
    const model = props.section.model ? ` · ${props.section.model}` : "";
    return `${id}${model}${iter}`;
  };
  return (
    <box flexDirection="row" width="100%" gap={1} height={1}>
      <Show
        when={props.section.status === "running"}
        fallback={
          <text
            width={1}
            flexShrink={0}
            fg={props.color}
            wrapMode="none"
            content={staticPhaseGlyph(props.section.status)}
          />
        }
      >
        <box width={1} height={1} overflow="hidden">
          <spinner name="dots" color={props.color} />
        </box>
      </Show>
      <text
        flexShrink={1}
        fg={props.color}
        attributes={TextAttributes.BOLD}
        wrapMode="none"
        truncate
        content={text()}
      />
    </box>
  );
}

// ── Rows ────────────────────────────────────────────────────────────

const NAME_COL = 12;
const GLYPH_COL = 2;

function Row(props: { row: FeedRow; repoPath?: string }) {
  const kind = () => props.row.kind;
  return (
    <Show
      when={kind() === "tool"}
      fallback={
        <Show
          when={kind() === "edit"}
          fallback={
            <Show
              when={kind() === "result"}
              fallback={
                <Show when={kind() === "note"} fallback={<ErrorRow row={props.row} />}>
                  <NoteRow row={props.row} />
                </Show>
              }
            >
              <ResultRow row={props.row} repoPath={props.repoPath} />
            </Show>
          }
        >
          <EditRow row={props.row} repoPath={props.repoPath} />
        </Show>
      }
    >
      <ToolRow row={props.row} repoPath={props.repoPath} />
    </Show>
  );
}

function ToolRow(props: { row: FeedRow; repoPath?: string }) {
  const style = () => toolRowStyle(props.row.tool ?? "");
  const nameAttr = () => {
    const w = style().nameWeight;
    if (w === "bold") return TextAttributes.BOLD;
    if (w === "dim") return TextAttributes.DIM;
    return TextAttributes.NONE;
  };
  const detail = () => prettifyDetail(props.row.tool, props.row.detail, props.repoPath);
  return (
    <box flexDirection="row" width="100%">
      <text
        width={GLYPH_COL}
        flexShrink={0}
        fg={style().glyphColor}
        wrapMode="none"
        content={style().glyph}
      />
      <text
        width={NAME_COL}
        flexShrink={0}
        fg={style().glyphColor}
        attributes={nameAttr()}
        wrapMode="none"
        truncate
        content={props.row.tool ?? ""}
      />
      <text
        flexGrow={1}
        flexShrink={1}
        fg={style().detailColor}
        wrapMode="word"
        content={detail()}
      />
    </box>
  );
}

/**
 * Edit / MultiEdit / NotebookEdit — render the regular tool row plus
 * a truncated unified diff underneath it (indented to the detail
 * column). The diff payload is built in `controller.pushEvent` via
 * `buildEditDiff` and passed through on `row.edit`.
 */
function EditRow(props: { row: FeedRow; repoPath?: string }) {
  return (
    <box flexDirection="column" width="100%">
      <ToolRow row={props.row} repoPath={props.repoPath} />
      <Show when={props.row.edit} keyed>
        {(e: EditDiff) => (
          <box flexDirection="column" width="100%" marginLeft={GLYPH_COL + NAME_COL}>
            <diff
              diff={e.diff}
              view="unified"
              filetype={e.filetype}
              wrapMode="word"
              showLineNumbers={false}
              addedSignColor={PALETTE.done}
              removedSignColor={PALETTE.failed}
              addedBg="transparent"
              removedBg="transparent"
              addedContentBg="transparent"
              removedContentBg="transparent"
              contextBg="transparent"
              contextContentBg="transparent"
            />
            <Show when={e.truncated}>
              <text fg={PALETTE.hint} wrapMode="none" content="…" />
            </Show>
          </box>
        )}
      </Show>
    </box>
  );
}

function ResultRow(props: { row: FeedRow; repoPath?: string }) {
  const detail = () => {
    const parts: string[] = [];
    if (props.row.detail)
      parts.push(prettifyDetail(props.row.tool, props.row.detail, props.repoPath));
    if (props.row.extra) parts.push(props.row.extra);
    return parts.join(" · ");
  };
  return (
    <box flexDirection="row" width="100%">
      <text width={GLYPH_COL} flexShrink={0} fg={PALETTE.done} wrapMode="none" content="✓" />
      <text
        width={NAME_COL}
        flexShrink={0}
        fg={PALETTE.muted}
        attributes={TextAttributes.DIM}
        wrapMode="none"
        truncate
        content={props.row.tool ?? ""}
      />
      <text flexGrow={1} flexShrink={1} fg={PALETTE.hint} wrapMode="word" content={detail()} />
    </box>
  );
}

/**
 * Agent prose. Renders the body via OpenTUI `<markdown>` so the
 * agent's `**bold**` / `- bullets` / `` `code` `` shows styled.
 * The `│` glyph stays as the column marker so notes stay aligned
 * with tool rows; we drop the redundant "note" label since the
 * markdown's own visual structure does the heavy lifting.
 */
function NoteRow(props: { row: FeedRow }) {
  return (
    <box flexDirection="row" width="100%">
      <text width={GLYPH_COL} flexShrink={0} fg={PALETTE.muted} wrapMode="none" content="│" />
      <box flexGrow={1} flexShrink={1}>
        <markdown content={props.row.detail ?? ""} syntaxStyle={markdownSyntax()} />
      </box>
    </box>
  );
}

function ErrorRow(props: { row: FeedRow }) {
  const label = () => props.row.tool ?? "error";
  return (
    <box flexDirection="row" width="100%">
      <text width={GLYPH_COL} flexShrink={0} fg={PALETTE.failed} wrapMode="none" content="✗" />
      <text
        width={NAME_COL}
        flexShrink={0}
        fg={PALETTE.failed}
        wrapMode="none"
        truncate
        content={label()}
      />
      <text
        flexGrow={1}
        flexShrink={1}
        fg={PALETTE.failed}
        wrapMode="word"
        content={props.row.detail ?? ""}
      />
    </box>
  );
}

function SummaryLine(props: { section: PhaseSection }) {
  const text = () => {
    const parts: string[] = [];
    if (props.section.durationMs !== undefined) parts.push(formatElapsed(props.section.durationMs));
    if (props.section.tokensIn !== undefined || props.section.tokensOut !== undefined) {
      parts.push(
        `${(props.section.tokensIn ?? 0).toLocaleString()} in / ${(props.section.tokensOut ?? 0).toLocaleString()} out tok`,
      );
    }
    return parts.join(" · ");
  };
  const glyph = () => (props.section.status === "failed" ? "✗" : "✓");
  const color = () => (props.section.status === "failed" ? PALETTE.failed : PALETTE.done);
  return (
    <box flexDirection="row" width="100%" marginTop={1}>
      <text width={GLYPH_COL} flexShrink={0} fg={color()} wrapMode="none" content={glyph()} />
      <text flexGrow={1} flexShrink={1} fg={color()} wrapMode="word" content={text()} />
    </box>
  );
}

// ── Inline gate card ────────────────────────────────────────────────

/**
 * Slim gate panel — the action moment, inside the active phase card.
 * Carries only the call-to-action info: the workflow author's summary
 * (rendered as markdown) and the artefacts list. Phase id, duration,
 * tokens, and the [a]/[r] chips all live in the footer; duplicating
 * them here just puffed the panel up.
 */
function GateCard(props: { ctx: GateContext; repoPath?: string }) {
  return (
    <box
      width="100%"
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={PALETTE.gate}
      title=" approval required "
      titleAlignment="left"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={0}
      paddingBottom={0}
      marginTop={1}
    >
      <Show when={props.ctx.summary}>
        <markdown content={props.ctx.summary ?? ""} syntaxStyle={markdownSyntax()} />
      </Show>
      <Show when={props.ctx.artefacts.length > 0}>
        <box width="100%" flexDirection="column" marginTop={1}>
          <For each={props.ctx.artefacts}>
            {(a) => (
              <box flexDirection="row" width="100%">
                <text
                  width={GLYPH_COL}
                  flexShrink={0}
                  fg={PALETTE.muted}
                  wrapMode="none"
                  content="•"
                />
                <text
                  flexGrow={1}
                  flexShrink={1}
                  fg={PALETTE.text}
                  wrapMode="word"
                  content={shortenPath(a.path, props.repoPath)}
                />
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  );
}

function Chip(props: { label: string; bg: string; fg: string }) {
  return (
    <text
      flexShrink={0}
      bg={props.bg}
      fg={props.fg}
      attributes={TextAttributes.BOLD}
      wrapMode="none"
      content={props.label}
    />
  );
}

// ── Footer ──────────────────────────────────────────────────────────

function Footer(props: {
  phases: readonly PhaseRow[];
  active: PhaseRow | null;
  gate: GateState | null;
  paused: PausedState | null;
  hint: string;
  cols: number;
  now: number;
}) {
  const totals = createMemo(() => phaseTotals(props.phases));
  const showRight = () => props.cols >= 60;

  return (
    <box height={3} flexShrink={0} flexDirection="column" width="100%">
      <text
        height={1}
        width="100%"
        fg={PALETTE.border}
        wrapMode="none"
        truncate
        content={"─".repeat(Math.max(8, props.cols - 2))}
      />
      <Show
        when={props.phases.length > 0}
        fallback={
          <text height={1} fg={PALETTE.hint} wrapMode="none" truncate content="preparing run…" />
        }
      >
        <FooterTopRow
          active={props.active}
          totals={totals()}
          showRight={showRight()}
          now={props.now}
        />
      </Show>
      <FooterBottomRow
        phases={props.phases}
        gate={!!props.gate}
        paused={props.paused}
        hint={props.hint}
        showRight={showRight()}
      />
    </box>
  );
}

function FooterTopRow(props: {
  active: PhaseRow | null;
  totals: { durationMs: number; tokensIn: number; tokensOut: number };
  showRight: boolean;
  now: number;
}) {
  const titleColor = () => (props.active ? statusColor(props.active.status) : PALETTE.accent);
  const titleText = () => {
    const base = `ordin · run${props.active ? ` · ${props.active.id}` : ""}`;
    if (!props.active || props.active.status !== "running") return base;
    const startedAt = props.active.startedAt;
    if (!startedAt) return base;
    return `${base} · ${formatElapsed(props.now - startedAt)}`;
  };
  const totalsText = () => formatTotals(props.totals);
  return (
    <box flexDirection="row" width="100%" justifyContent="space-between" gap={2} height={1}>
      <text flexShrink={1} fg={titleColor()} wrapMode="none" truncate content={titleText()} />
      <Show when={props.showRight && totalsText().length > 0}>
        <text flexShrink={0} fg={PALETTE.hint} wrapMode="none" truncate content={totalsText()} />
      </Show>
    </box>
  );
}

function FooterBottomRow(props: {
  phases: readonly PhaseRow[];
  gate: boolean;
  paused: PausedState | null;
  hint: string;
  showRight: boolean;
}) {
  return (
    <box flexDirection="row" width="100%" justifyContent="space-between" gap={2} height={1}>
      <PhaseRail phases={props.phases} />
      <Show when={props.showRight}>
        <KeyHint gate={props.gate} paused={props.paused} hint={props.hint} />
      </Show>
    </box>
  );
}

function KeyHint(props: { gate: boolean; paused: PausedState | null; hint: string }) {
  return (
    <Show
      when={props.gate}
      fallback={
        <Show
          when={props.paused}
          keyed
          fallback={
            <text
              flexShrink={0}
              fg={PALETTE.hint}
              wrapMode="none"
              truncate
              content={props.hint || "↑↓ scroll · Ctrl+C abort"}
            />
          }
        >
          {(p: PausedState) => (
            <box flexDirection="row" flexShrink={0} gap={1}>
              <text
                flexShrink={0}
                fg={p.status === "halted" ? PALETTE.gate : PALETTE.failed}
                attributes={TextAttributes.BOLD}
                wrapMode="none"
                content={p.status === "halted" ? "✗ run halted" : "✗ run failed"}
              />
              <text flexShrink={0} fg={PALETTE.muted} wrapMode="none" content="·" />
              <text
                flexShrink={0}
                fg={PALETTE.hint}
                wrapMode="none"
                content="↑↓ scroll · q to exit"
              />
            </box>
          )}
        </Show>
      }
    >
      <box flexDirection="row" flexShrink={0} gap={1}>
        <Chip label=" a " bg={PALETTE.gate} fg={PALETTE.bg} />
        <text flexShrink={0} fg={PALETTE.text} wrapMode="none" content="approve" />
        <Chip label=" r " bg={PALETTE.failed} fg={PALETTE.bg} />
        <text flexShrink={0} fg={PALETTE.text} wrapMode="none" content="reject" />
      </box>
    </Show>
  );
}

/**
 * One-line phase chain. Shows progress through the workflow
 * (`◌ plan ▸ ⠋ build ▸ ◌ review`). Active phase uses an animated
 * spinner; others use a static glyph in their status colour.
 */
function PhaseRail(props: { phases: readonly PhaseRow[] }) {
  return (
    <box flexDirection="row" flexShrink={1} height={1}>
      <For each={props.phases}>
        {(phase, i) => (
          <box flexDirection="row" flexShrink={1}>
            <Show when={i() > 0}>
              <text width={3} flexShrink={0} fg={PALETTE.muted} wrapMode="none" content=" ▸ " />
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

function PhaseGlyph(props: { phase: PhaseRow }) {
  return (
    <Show
      when={props.phase.status === "running"}
      fallback={
        <text
          width={1}
          flexShrink={0}
          fg={statusColor(props.phase.status)}
          wrapMode="none"
          content={staticPhaseGlyph(props.phase.status)}
        />
      }
    >
      <box width={1} height={1} overflow="hidden">
        <spinner name="dots" color={PALETTE.running} />
      </box>
    </Show>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * For tools whose `detail` is a file path (Read/Write/Edit/Glob/etc.),
 * render the path repo-relative so the same `.scratch/target-repo/`
 * prefix doesn't burn a line per row.
 */
function prettifyDetail(
  tool: string | undefined,
  detail: string | undefined,
  repoPath?: string,
): string {
  if (!detail) return "";
  if (!tool) return detail;
  if (
    tool === "Read" ||
    tool === "Write" ||
    tool === "Edit" ||
    tool === "MultiEdit" ||
    tool === "NotebookEdit"
  ) {
    return shortenPath(detail, repoPath);
  }
  return detail;
}

function phaseTotals(phases: readonly PhaseRow[]) {
  let durationMs = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const p of phases) {
    if (p.durationMs !== undefined) durationMs += p.durationMs;
    if (p.tokensIn !== undefined) tokensIn += p.tokensIn;
    if (p.tokensOut !== undefined) tokensOut += p.tokensOut;
  }
  return { durationMs, tokensIn, tokensOut };
}

function formatTotals(totals: { durationMs: number; tokensIn: number; tokensOut: number }): string {
  const parts: string[] = [];
  if (totals.durationMs > 0) parts.push(formatElapsed(totals.durationMs));
  if (totals.tokensIn > 0) parts.push(`${totals.tokensIn.toLocaleString()} in`);
  if (totals.tokensOut > 0) parts.push(`${totals.tokensOut.toLocaleString()} out`);
  return parts.join(" · ");
}

/**
 * Glyph used in the phase rail and the card title. Card titles can't
 * host an animated spinner element (they're a string prop on `<box>`),
 * so running uses a static glyph; the border colour conveys "live".
 */
function staticPhaseGlyph(s: PhaseStatus): string {
  switch (s) {
    case "pending":
      return "◌";
    case "running":
      return "▸";
    case "gate":
      return "◆";
    case "done":
      return "✓";
    case "failed":
      return "✗";
  }
}

function statusColor(s: PhaseStatus): string {
  switch (s) {
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
