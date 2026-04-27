/**
 * Shared `ordin` brand banner. Used both by the live `ordin run`
 * scrollback (top of the run) and the `--dry-run` preview so they
 * inherit one visual identity.
 */
import { For, Show } from "solid-js";
import { BRAND_GRADIENT, interpolateStops } from "./format";
import { PALETTE } from "./theme";
import type { RunHeader } from "./types";

/**
 * `tiny` font is ~3 rows tall — small enough to leave most of the
 * scrollback for content. The dry-run preview also uses this same
 * component so live + preview stay visually in sync.
 */
export const BANNER_HEIGHT = 3;

export interface RunBannerProps {
  header?: RunHeader;
}

export function RunBanner(props: RunBannerProps) {
  const subtitle = () => {
    const h = props.header;
    if (!h?.task) return null;
    return `${h.task}  ·  tier ${h.tier}`;
  };
  const meta = () => {
    const h = props.header;
    if (!h) return null;
    const parts: string[] = [];
    if (h.workflow) parts.push(h.workflow);
    if (h.project) parts.push(h.project);
    if (h.runId) parts.push(h.runId);
    return parts.length > 0 ? parts.join("  ·  ") : null;
  };
  return (
    <box flexDirection="column" backgroundColor="transparent">
      <BrandWord />
      <Show when={subtitle()} keyed>
        {(s: string) => <text fg={PALETTE.text} wrapMode="word" content={s} />}
      </Show>
      <Show when={meta()} keyed>
        {(m: string) => <text fg={PALETTE.hint} wrapMode="none" truncate content={m} />}
      </Show>
    </box>
  );
}

function BrandWord() {
  const word = "ordin";
  const letters = word.split("");
  const palette = letters.map((_, i) =>
    interpolateStops(BRAND_GRADIENT, letters.length <= 1 ? 0 : i / (letters.length - 1)),
  );
  return (
    <box flexDirection="row" gap={1} backgroundColor="transparent">
      <For each={letters}>
        {(ch, i) => (
          <ascii_font text={ch} font="tiny" color={palette[i()]} backgroundColor="transparent" />
        )}
      </For>
    </box>
  );
}
