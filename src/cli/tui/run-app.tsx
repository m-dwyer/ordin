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
import {
  buildRenderPlan,
  ellipsizePath,
  fileUri,
  formatElapsed,
  linkUrl,
  mix,
  NOTE_COLLAPSE_THRESHOLD,
  prettifyDetail,
  shortenPath,
  toolRowStyle,
} from "./format";
import { staticPhaseGlyph, statusColor, statusGlow } from "./phase-visual";
import { PALETTE } from "./theme";
import type {
  ControllerState,
  EditDiff,
  FeedRow,
  GateState,
  PausedState,
  PhaseRow,
  PhaseSection,
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

  /**
   * Click a phase dot in the footer rail → scroll the scrollback so
   * that phase's most recent section comes into view. Most recent
   * because re-runs after rejected gates produce multiple sections
   * per phase id; the user almost always cares about the latest.
   *
   * `scrollChildIntoView` internally calls `scrollBy`, which mutates
   * the scrollbar's position directly and bypasses ScrollBox's
   * `scrollTop` setter — the only path that flips the
   * `_hasManualScroll` flag. Without that flag, the next layout pass
   * sees us as still "stuck to bottom" and snaps us right back down.
   * We re-assign `scrollTop` to itself (through the setter) to flip
   * the flag and defeat the snap-back. Sticky resumes naturally once
   * the user scrolls back to the bottom.
   */
  const jumpToPhase = (phaseId: string) => {
    if (!scrollboxEl) return;
    const list = state.sections();
    for (let i = list.length - 1; i >= 0; i--) {
      const s = list[i];
      if (s && s.phaseId === phaseId) {
        scrollboxEl.scrollChildIntoView(phaseCardId(s.key));
        const top = scrollboxEl.scrollTop;
        scrollboxEl.scrollTop = top;
        return;
      }
    }
  };

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
    // Collapsible toggle: `e` expands the next collapsed thing in
    // scroll order; `c` collapses everything back. Two distinct keys
    // — easier to reason about than `e`/`E` shift dance. Mouse clicks
    // handle "expand this specific one".
    if (key.name === "e") {
      state.cycleNextCollapsed(scrollboxEl);
      return;
    }
    if (key.name === "c") {
      state.collapseAll();
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
        expanded={state.expanded()}
        toggleExpanded={state.toggleExpanded}
        collapsedPhases={state.collapsedPhases()}
        togglePhaseCollapsed={state.togglePhaseCollapsed}
      />
      <Footer
        phases={phases()}
        active={activePhase()}
        gate={state.gate()}
        paused={state.paused()}
        hint={state.hint()}
        cols={cols()}
        now={now()}
        onJumpToPhase={jumpToPhase}
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
  expanded: ReadonlySet<number>;
  toggleExpanded: (id: number) => void;
  collapsedPhases: ReadonlySet<string>;
  togglePhaseCollapsed: (sectionKey: string) => void;
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
      <box width="100%" flexDirection="column" gap={2}>
        <Show when={props.header} keyed>
          {(header: RunHeader) => <RunBanner header={header} />}
        </Show>
        <For each={props.sections}>
          {(section) => (
            <PhaseCard
              section={section}
              repoPath={repoPath()}
              expanded={props.expanded}
              toggleExpanded={props.toggleExpanded}
              collapsed={props.collapsedPhases.has(section.key)}
              onToggleCollapsed={() => props.togglePhaseCollapsed(section.key)}
            />
          )}
        </For>
      </box>
    </scrollbox>
  );
}

/**
 * A phase renders as a header label *above* a thin-left-border panel
 * grouping the phase's tool activity. Pulling the header out of the
 * panel chrome makes it visually distinct from the rows below — the
 * header is the section label, the panel is the work.
 */
function PhaseCard(props: {
  section: PhaseSection;
  repoPath?: string;
  expanded: ReadonlySet<number>;
  toggleExpanded: (id: number) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const isActive = () => props.section.status === "running" || props.section.status === "gate";
  // "Past" phases drop bg to a half-mix toward canvas — still visible
  // as a card, just less raised. Chrome colours mix 65% toward bg so
  // the active phase pops without finished work disappearing.
  //
  // Active phase glow: instead of a 2-cell strip (which read as two
  // muddled stripes, not glow), we wash the active card's bg toward
  // its status colour at ~6% and use a HEAVY single bar in the GLOW
  // tier. Tinted bg sells "lit from within"; heavy bar gives the rim.
  const activeBg = () => mix(PALETTE.panelRaised, statusGlow(props.section.status), 0.06);
  const cardBg = () => (isActive() ? activeBg() : mix(PALETTE.panel, PALETTE.bg, 0.5));
  const dim = (hex: string, amount = 0.65): string =>
    isActive() ? hex : mix(hex, PALETTE.bg, amount);
  const barColor = () => (isActive() ? statusGlow(props.section.status) : PALETTE.border);
  const barStyle = (): "heavy" | "single" => (isActive() ? "heavy" : "single");
  const headerColor = () => dim(statusColor(props.section.status));

  // Convert the flat row stream into a render plan: standalone rows
  // and tool-groups (Read/Glob/Grep ≥3 adjacent). Memoised on the row
  // array reference so it only recomputes when rows change.
  const grouped = createMemo(() => buildRenderPlan(props.section.rows));

  const header = () => (
    <PhaseHeader
      section={props.section}
      color={headerColor()}
      dim={!isActive()}
      active={isActive()}
      collapsed={props.collapsed}
      onToggle={props.onToggleCollapsed}
    />
  );

  return (
    // Stable id per section so the phase rail at the bottom can
    // scroll into view via `scrollChildIntoView(phaseCardId(...))`.
    <box id={phaseCardId(props.section.key)} width="100%" flexDirection="column">
      <Show
        when={!props.collapsed}
        fallback={
          /* Collapsed: header + footer wrapped in chrome together so
             they read as one anchored unit, not two floating lines. */
          <box
            width="100%"
            flexDirection="column"
            backgroundColor={isActive() ? activeBg() : mix(PALETTE.panel, PALETTE.bg, 0.5)}
            border={["left"]}
            borderColor={barColor()}
            borderStyle={barStyle()}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={0}
            paddingBottom={0}
          >
            {header()}
            <PhaseFooter section={props.section} dim={!isActive()} />
          </box>
        }
      >
        {/* Expanded: header sits OUTSIDE the panel chrome so it reads
            as a section label, distinct from the dense rows below. */}
        {header()}
        <box
          width="100%"
          flexDirection="column"
          backgroundColor={cardBg()}
          border={["left"]}
          borderColor={barColor()}
          borderStyle={barStyle()}
          paddingLeft={1}
          paddingRight={1}
          paddingTop={0}
          paddingBottom={1}
        >
          {/* Concrete wrapper so the For's anchor stays put even when
              sibling Show conditions mount/unmount around it. */}
          <box width="100%" flexDirection="column">
            <For each={grouped()}>
              {(item) =>
                item.kind === "group" ? (
                  <ToolGroupRow
                    group={item}
                    repoPath={props.repoPath}
                    expanded={props.expanded.has(item.id)}
                    onToggle={() => props.toggleExpanded(item.id)}
                  />
                ) : (
                  <Row
                    row={item.row}
                    repoPath={props.repoPath}
                    expanded={props.expanded.has(item.row.id)}
                    onToggle={() => props.toggleExpanded(item.row.id)}
                  />
                )
              }
            </For>
          </box>
          <Show when={props.section.gate} keyed>
            {(gate: GateState) => <GateCard ctx={gate.ctx} repoPath={props.repoPath} />}
          </Show>
          <Show when={props.section.status === "failed" && props.section.error}>
            <text fg={PALETTE.failed} wrapMode="word" content={props.section.error ?? ""} />
          </Show>
          <PhaseFooter section={props.section} dim={!isActive()} />
        </box>
      </Show>
    </box>
  );
}

/** Element id used by `scrollChildIntoView` from the phase rail. */
function phaseCardId(sectionKey: string): string {
  return `phase-card-${sectionKey}`;
}

/**
 * Section label that sits ABOVE the phase panel. Layout: status glyph
 * (or animated spinner for running) + bold phase id on the left;
 * model on the right + a `▼` / `▶` chevron indicating expand/collapse
 * state. Click anywhere on the row to toggle the card body.
 */
function PhaseHeader(props: {
  section: PhaseSection;
  color: string;
  dim: boolean;
  active: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const iterSuffix = () =>
    props.section.iteration > 1 ? ` · iter ${props.section.iteration}` : "";
  const modelColor = () => (props.dim ? mix(PALETTE.hint, PALETTE.bg, 0.65) : PALETTE.hint);
  const chevron = () => (props.collapsed ? "▶" : "▼");
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: <box> is an OpenTUI renderable, not a DOM element; ARIA roles don't apply
    <box
      flexDirection="row"
      width="100%"
      gap={1}
      height={1}
      justifyContent="space-between"
      onMouseDown={props.onToggle}
    >
      <box flexDirection="row" gap={1} flexShrink={1}>
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
        <Show
          when={props.active}
          fallback={
            <text
              flexShrink={1}
              fg={props.color}
              attributes={TextAttributes.BOLD}
              wrapMode="none"
              truncate
              content={`${props.section.phaseId}${iterSuffix()}`}
            />
          }
        >
          <Chip
            label={` ${props.section.phaseId} `}
            bg={statusColor(props.section.status)}
            fg={PALETTE.bg}
          />
          <Show when={iterSuffix()}>
            <text flexShrink={1} fg={props.color} wrapMode="none" truncate content={iterSuffix()} />
          </Show>
        </Show>
      </box>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <Show when={props.section.model} keyed>
          {(model: string) => (
            <text flexShrink={1} fg={modelColor()} wrapMode="none" truncate content={model} />
          )}
        </Show>
        <text flexShrink={0} fg={PALETTE.muted} wrapMode="none" content={chevron()} />
      </box>
    </box>
  );
}

// ── Rows ────────────────────────────────────────────────────────────

const GLYPH_COL = 1;
const EXTRA_COL = 7;

function Row(props: { row: FeedRow; repoPath?: string; expanded: boolean; onToggle: () => void }) {
  const kind = () => props.row.kind;
  return (
    <Show
      when={kind() === "tool"}
      fallback={
        <Show
          when={kind() === "edit"}
          fallback={
            <Show when={kind() === "note"} fallback={<ErrorRow row={props.row} />}>
              <NoteRow row={props.row} expanded={props.expanded} onToggle={props.onToggle} />
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

/**
 * One tool call rendered as `▸ Read · /path/foo.ts          12ms`.
 * Drops the rigid 12-char NAME_COL: glyph + name + " · " + detail
 * flow inline; `extra` (duration, populated by the result event)
 * sticks to the right with `justify-between`. Failed tools (failed
 * flag set on the row) tint glyph + detail coral and drop the dim
 * separator.
 */
function ToolRow(props: { row: FeedRow; repoPath?: string }) {
  const style = () => toolRowStyle(props.row.tool ?? "");
  const failed = () => props.row.failed === true;
  const glyphColor = () => (failed() ? PALETTE.failed : style().glyphColor);
  const detailColor = () => (failed() ? PALETTE.failed : style().detailColor);
  const glyph = () => (failed() ? "✗" : style().glyph);
  const nameAttr = () => {
    if (failed()) return TextAttributes.NONE;
    const w = style().nameWeight;
    if (w === "bold") return TextAttributes.BOLD;
    if (w === "dim") return TextAttributes.DIM;
    return TextAttributes.NONE;
  };
  const detail = () => prettifyDetail(props.row.tool, props.row.detail, props.repoPath);
  return (
    <box flexDirection="row" width="100%" gap={1}>
      <box flexDirection="row" flexShrink={1} flexGrow={1} gap={1}>
        <text
          width={GLYPH_COL}
          flexShrink={0}
          fg={glyphColor()}
          wrapMode="none"
          content={glyph()}
        />
        <text
          flexShrink={0}
          fg={glyphColor()}
          attributes={nameAttr()}
          wrapMode="none"
          truncate
          content={props.row.tool ?? ""}
        />
        <Show when={detail()}>
          <text flexShrink={0} fg={PALETTE.muted} wrapMode="none" content="·" />
          {/* wrapMode="none" + truncate keeps the OSC 8 link as one
              continuous chunk (wrapping breaks the underline + click
              target across lines). Detail is pre-ellipsized to the
              basename so what gets shown is always the diagnostic
              part of the path. */}
          <text flexGrow={1} flexShrink={1} fg={detailColor()} wrapMode="none" truncate>
            <Show when={linkUrl(props.row.tool, props.row.detail)} keyed fallback={detail()}>
              {(href: string) => <a href={href}>{detail()}</a>}
            </Show>
          </text>
        </Show>
      </box>
      <Show when={props.row.extra}>
        <text
          width={EXTRA_COL}
          flexShrink={0}
          fg={failed() ? PALETTE.failed : PALETTE.muted}
          wrapMode="none"
          content={(props.row.extra ?? "").padStart(EXTRA_COL)}
        />
      </Show>
    </box>
  );
}

/**
 * Edit / MultiEdit / NotebookEdit — render the regular tool row plus
 * a truncated unified diff underneath it (indented to the glyph
 * column). The diff payload is built in `controller.pushEvent` via
 * `buildEditDiff` and passed through on `row.edit`.
 */
function EditRow(props: { row: FeedRow; repoPath?: string }) {
  return (
    <box flexDirection="column" width="100%">
      <ToolRow row={props.row} repoPath={props.repoPath} />
      <Show when={props.row.edit} keyed>
        {(e: EditDiff) => (
          <box flexDirection="column" width="100%" marginLeft={GLYPH_COL + 1}>
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

/**
 * Tool group — collapses 3+ adjacent Read/Glob/Grep calls under a
 * single disclosure header. The header sits at the top in BOTH states
 * (`▶ explored 5 files` collapsed, `▼ explored 5 files` expanded), so
 * the click target doesn't move and you can re-collapse without
 * scrolling back.
 */
function ToolGroupRow(props: {
  group: { id: number; rows: readonly FeedRow[] };
  repoPath?: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const fileCount = () => {
    const seen = new Set<string>();
    for (const r of props.group.rows) {
      if (r.detail) seen.add(r.detail);
    }
    return seen.size || props.group.rows.length;
  };
  return (
    <box flexDirection="column" width="100%">
      <DisclosureRow
        expanded={props.expanded}
        label={`explored ${fileCount()} files`}
        onToggle={props.onToggle}
      />
      <Show when={props.expanded}>
        <For each={props.group.rows}>
          {(row) => <ToolRow row={row} repoPath={props.repoPath} />}
        </For>
      </Show>
    </box>
  );
}

/**
 * Section disclosure: leading chunky triangle (`▶` collapsed / `▼`
 * expanded) in the active accent colour. Lead position + bright tint
 * + hover via mouse make it read clearly as "click to toggle".
 */
function DisclosureRow(props: { expanded: boolean; label: string; onToggle: () => void }) {
  const glyph = () => (props.expanded ? "▼" : "▶");
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: <box> is an OpenTUI renderable, not a DOM element; ARIA roles don't apply
    <box flexDirection="row" width="100%" gap={1} onMouseDown={props.onToggle}>
      <text
        width={GLYPH_COL}
        flexShrink={0}
        fg={PALETTE.toolPreview}
        wrapMode="none"
        content={glyph()}
      />
      <text
        flexGrow={1}
        flexShrink={1}
        fg={PALETTE.toolPreview}
        wrapMode="word"
        content={props.label}
      />
    </box>
  );
}

/**
 * Agent prose. Renders the body via OpenTUI `<markdown>` so the
 * agent's `**bold**` / `- bullets` / `` `code` `` shows styled.
 * The `│` glyph + extra marginTop differentiate "agent talking"
 * from the dense tool-call rows above. When a note exceeds
 * NOTE_COLLAPSE_THRESHOLD source lines, it collapses to the first 4
 * lines + a clickable `… +N more lines  ⊕` footer; click or press
 * `e` to expand.
 */
function NoteRow(props: { row: FeedRow; expanded: boolean; onToggle: () => void }) {
  const fullText = () => props.row.detail ?? "";
  const lines = () => fullText().split("\n");
  const isLong = () => lines().length > NOTE_COLLAPSE_THRESHOLD;
  const collapsedText = () => lines().slice(0, 4).join("\n");
  const hiddenCount = () => Math.max(0, lines().length - 4);
  return (
    <box flexDirection="column" width="100%" marginTop={1}>
      <box flexDirection="row" width="100%">
        <text width={GLYPH_COL} flexShrink={0} fg={PALETTE.muted} wrapMode="none" content="│" />
        <box flexGrow={1} flexShrink={1}>
          <markdown
            content={isLong() && !props.expanded ? collapsedText() : fullText()}
            syntaxStyle={markdownSyntax()}
            fg={PALETTE.text}
          />
        </box>
      </box>
      <Show when={isLong()}>
        <DisclosureRow
          expanded={props.expanded}
          label={props.expanded ? "collapse" : `show ${hiddenCount()} more lines`}
          onToggle={props.onToggle}
        />
      </Show>
    </box>
  );
}

function ErrorRow(props: { row: FeedRow }) {
  const label = () => props.row.tool ?? "error";
  return (
    <box flexDirection="row" width="100%" gap={1}>
      <text width={GLYPH_COL} flexShrink={0} fg={PALETTE.failed} wrapMode="none" content="✗" />
      <text flexShrink={0} fg={PALETTE.failed} wrapMode="none" truncate content={label()} />
      <Show when={props.row.detail}>
        <text flexShrink={0} fg={PALETTE.muted} wrapMode="none" content="·" />
        <text
          flexGrow={1}
          flexShrink={1}
          fg={PALETTE.failed}
          wrapMode="word"
          content={props.row.detail ?? ""}
        />
      </Show>
    </box>
  );
}

/**
 * Soft per-phase signature line at the bottom of every card. Always
 * present (running phases get live token counts; finished phases
 * freeze) so each phase block has a consistent metadata footer —
 * borrowed from OpenCode's per-message signature pattern.
 */
function PhaseFooter(props: { section: PhaseSection; dim: boolean }) {
  const text = () => {
    const parts: string[] = [];
    if (props.section.durationMs !== undefined) {
      parts.push(formatElapsed(props.section.durationMs));
    } else if (props.section.startedAt !== undefined) {
      parts.push(formatElapsed(Date.now() - props.section.startedAt));
    }
    if (props.section.tokensIn !== undefined || props.section.tokensOut !== undefined) {
      parts.push(
        `${(props.section.tokensIn ?? 0).toLocaleString()} in / ${(props.section.tokensOut ?? 0).toLocaleString()} out`,
      );
    }
    return parts.join(" · ");
  };
  const glyph = () => {
    switch (props.section.status) {
      case "done":
        return "✓";
      case "failed":
        return "✗";
      case "gate":
        return "◆";
      default:
        return "·";
    }
  };
  const color = () => {
    const base =
      props.section.status === "failed"
        ? PALETTE.failed
        : props.section.status === "done"
          ? PALETTE.done
          : PALETTE.hint;
    return props.dim ? mix(base, PALETTE.bg, 0.65) : base;
  };
  return (
    <box flexDirection="row" width="100%" gap={1} marginTop={1}>
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
      borderColor={PALETTE.gateGlow}
      title=" approval required "
      titleAlignment="left"
      paddingLeft={1}
      paddingRight={1}
      paddingTop={1}
      paddingBottom={0}
      marginTop={1}
    >
      <Show when={props.ctx.summary} keyed>
        {(summary: string) => (
          <markdown content={summary} syntaxStyle={markdownSyntax()} fg={PALETTE.text} />
        )}
      </Show>
      <Show when={props.ctx.artefacts.length > 0}>
        <box width="100%" flexDirection="column" marginTop={1}>
          <For each={props.ctx.artefacts}>
            {(a) => (
              <box flexDirection="row" width="100%" gap={1}>
                <text
                  width={GLYPH_COL}
                  flexShrink={0}
                  fg={PALETTE.muted}
                  wrapMode="none"
                  content="•"
                />
                <text flexGrow={1} flexShrink={1} fg={PALETTE.text} wrapMode="none" truncate>
                  <a href={fileUri(a.path)}>{ellipsizePath(shortenPath(a.path, props.repoPath))}</a>
                </text>
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
  onJumpToPhase: (phaseId: string) => void;
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
        onJumpToPhase={props.onJumpToPhase}
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
  onJumpToPhase: (phaseId: string) => void;
}) {
  return (
    <box flexDirection="row" width="100%" justifyContent="space-between" gap={2} height={1}>
      <PhaseRail phases={props.phases} onJumpToPhase={props.onJumpToPhase} />
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
        <Chip label=" a · approve " bg={PALETTE.gateGlow} fg={PALETTE.bg} />
        <Chip label=" r · reject " bg={PALETTE.failedGlow} fg={PALETTE.bg} />
      </box>
    </Show>
  );
}

/**
 * Workflow progress strip — `● plan ━━ ● build ━━ ○ review`. Filled
 * dots for any non-pending phase coloured by status; open dots for
 * pending. Connectors between phases take the prior phase's status
 * colour, so the line "fills in" left-to-right as work flows
 * through (sage when it completed, muted when it hasn't yet).
 *
 * No animated spinner here — color alone signals the active phase.
 * The spinner lives in the active phase card's header so we don't
 * have two moving things competing for attention.
 */
function PhaseRail(props: {
  phases: readonly PhaseRow[];
  onJumpToPhase: (phaseId: string) => void;
}) {
  return (
    <box flexDirection="row" flexShrink={1} height={1}>
      <For each={props.phases}>
        {(phase, i) => (
          <box flexDirection="row" flexShrink={1}>
            <Show when={i() > 0} keyed>
              <PhaseConnector prior={props.phases[i() - 1]} />
            </Show>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: <box> is an OpenTUI renderable, not a DOM element; ARIA roles don't apply */}
            <box
              flexDirection="row"
              flexShrink={1}
              onMouseDown={() => props.onJumpToPhase(phase.id)}
            >
              <text
                width={1}
                flexShrink={0}
                fg={statusColor(phase.status)}
                wrapMode="none"
                content={phase.status === "pending" ? "○" : "●"}
              />
              <text
                flexShrink={1}
                fg={phase.status === "pending" ? PALETTE.pending : PALETTE.text}
                wrapMode="none"
                truncate
                content={` ${phase.id}`}
              />
            </box>
          </box>
        )}
      </For>
    </box>
  );
}

function PhaseConnector(props: { prior?: PhaseRow }) {
  const color = () => {
    const s = props.prior?.status;
    if (s === "done") return PALETTE.done;
    if (s === "failed") return PALETTE.failed;
    return PALETTE.muted;
  };
  return <text flexShrink={0} fg={color()} wrapMode="none" content=" ━━ " />;
}

// ── Helpers ─────────────────────────────────────────────────────────

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
