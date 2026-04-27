/**
 * Pure mappings from `PhaseStatus` to the visual elements used in
 * the run UI. Extracted from `run-app.tsx` so they can be unit-tested
 * without standing up the OpenTUI/Solid render machinery.
 */
import { PALETTE } from "./theme";
import type { PhaseStatus } from "./types";

/**
 * Glyph used in the phase rail and the card title. Card titles can't
 * host an animated spinner element (they're a string prop on `<box>`),
 * so running uses a static glyph; the border colour conveys "live".
 */
export function staticPhaseGlyph(s: PhaseStatus): string {
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

/** Status → primary brand colour (rail dot, card border for past phases, header glyph). */
export function statusColor(s: PhaseStatus): string {
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

/**
 * Brighter sibling of `statusColor` used only for the active phase
 * card's heavy border + tinted bg — gives the lift effect a soft halo
 * without extra primitives. Pending falls back to `borderStrong` since
 * there is no glow tier for "haven't started".
 */
export function statusGlow(s: PhaseStatus): string {
  switch (s) {
    case "pending":
      return PALETTE.borderStrong;
    case "running":
      return PALETTE.runningGlow;
    case "gate":
      return PALETTE.gateGlow;
    case "done":
      return PALETTE.doneGlow;
    case "failed":
      return PALETTE.failedGlow;
  }
}
