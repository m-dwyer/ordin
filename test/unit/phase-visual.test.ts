import { describe, expect, it } from "vitest";
import { staticPhaseGlyph, statusColor, statusGlow } from "../../src/cli/tui/phase-visual";
import { PALETTE } from "../../src/cli/tui/theme";
import type { PhaseStatus } from "../../src/cli/tui/types";

/**
 * Locks down the PhaseStatus → visual mapping. TypeScript enforces
 * exhaustiveness via the `switch`, but these tests catch the case
 * where a future palette refactor decouples a status from its
 * intended brand colour (e.g. `running` accidentally pointing at
 * `done`'s green).
 */

const ALL_STATUSES: readonly PhaseStatus[] = ["pending", "running", "gate", "done", "failed"];

describe("staticPhaseGlyph", () => {
  it("returns one glyph per status, all distinct", () => {
    const glyphs = ALL_STATUSES.map(staticPhaseGlyph);
    expect(new Set(glyphs).size).toBe(ALL_STATUSES.length);
  });

  it("maps each status to its expected glyph", () => {
    expect(staticPhaseGlyph("pending")).toBe("◌");
    expect(staticPhaseGlyph("running")).toBe("▸");
    expect(staticPhaseGlyph("gate")).toBe("◆");
    expect(staticPhaseGlyph("done")).toBe("✓");
    expect(staticPhaseGlyph("failed")).toBe("✗");
  });
});

describe("statusColor", () => {
  it("each status maps to its named PALETTE entry", () => {
    expect(statusColor("pending")).toBe(PALETTE.pending);
    expect(statusColor("running")).toBe(PALETTE.running);
    expect(statusColor("gate")).toBe(PALETTE.gate);
    expect(statusColor("done")).toBe(PALETTE.done);
    expect(statusColor("failed")).toBe(PALETTE.failed);
  });
});

describe("statusGlow", () => {
  it("active statuses map to the brighter Glow tier; pending falls back to borderStrong", () => {
    expect(statusGlow("pending")).toBe(PALETTE.borderStrong);
    expect(statusGlow("running")).toBe(PALETTE.runningGlow);
    expect(statusGlow("gate")).toBe(PALETTE.gateGlow);
    expect(statusGlow("done")).toBe(PALETTE.doneGlow);
    expect(statusGlow("failed")).toBe(PALETTE.failedGlow);
  });

  it("Glow tier values differ from their statusColor siblings — they are a brighter variant, not an alias", () => {
    for (const s of ALL_STATUSES) {
      if (s === "pending") continue; // intentionally aliased to borderStrong
      expect(statusGlow(s)).not.toBe(statusColor(s));
    }
  });
});
