/**
 * `ordin run` masthead. Mirrors the single-line breadcrumb pattern
 * `printCommandHeader` uses for the read-only commands (`runs`,
 * `status`, `doctor`) — gradient `ordin` + `· run · <task>` — so the
 * whole CLI shares one visual identity.
 *
 * `--dry-run` reuses this component too via `preview.tsx`.
 */
import { For, Show } from "solid-js";
import { BRAND_GRADIENT, interpolateStops } from "./format";
import { PALETTE } from "./theme";
import type { RunHeader } from "./types";

/** Brand line + subtitle + optional metadata = 3 rows max. */
export const BANNER_HEIGHT = 3;

export interface RunBannerProps {
  header?: RunHeader;
}

export function RunBanner(props: RunBannerProps) {
  return (
    <box flexDirection="column" backgroundColor="transparent">
      <BreadcrumbLine header={props.header} />
      <Show when={metaLine(props.header)} keyed>
        {(m: string) => <text fg={PALETTE.hint} wrapMode="none" truncate content={m} />}
      </Show>
    </box>
  );
}

function BreadcrumbLine(props: { header?: RunHeader }) {
  const word = "ordin";
  const letters = word.split("");
  const palette = letters.map((_, i) =>
    interpolateStops(BRAND_GRADIENT, letters.length <= 1 ? 0 : i / (letters.length - 1)),
  );
  return (
    <box flexDirection="row" width="100%" backgroundColor="transparent" height={1}>
      <For each={letters}>
        {(ch, i) => <text flexShrink={0} fg={palette[i()]} wrapMode="none" content={ch} />}
      </For>
      <text flexShrink={0} fg={PALETTE.border} wrapMode="none" content=" · " />
      <text flexShrink={0} fg={PALETTE.text} wrapMode="none" content="run" />
      <Show when={props.header?.task} keyed>
        {(task: string) => (
          <>
            <text flexShrink={0} fg={PALETTE.border} wrapMode="none" content=" · " />
            <text flexShrink={1} fg={PALETTE.text} wrapMode="none" truncate content={task} />
          </>
        )}
      </Show>
      <Show when={props.header?.tier} keyed>
        {(tier: string) => (
          <>
            <text flexShrink={0} fg={PALETTE.border} wrapMode="none" content=" · " />
            <text flexShrink={0} fg={PALETTE.hint} wrapMode="none" content={`tier ${tier}`} />
          </>
        )}
      </Show>
    </box>
  );
}

function metaLine(header?: RunHeader): string | null {
  if (!header) return null;
  const parts: string[] = [];
  if (header.workflow) parts.push(header.workflow);
  if (header.project) parts.push(header.project);
  // runId is `<timestamp>_<slug>` — slug duplicates the task already
  // in the breadcrumb above; display only the timestamp portion.
  if (header.runId) parts.push(shortRunId(header.runId));
  return parts.length > 0 ? parts.join("  ·  ") : null;
}

function shortRunId(runId: string): string {
  const segments = runId.split("_");
  return segments.length >= 2 ? segments.slice(0, 2).join("_") : runId;
}
