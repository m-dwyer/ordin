/**
 * Shared color palette for the OpenTUI run UI. Single source of truth
 * referenced by the controller (scrollback writes), the run-app footer
 * components, and any future tooling-side rendering.
 *
 * Built around Catppuccin Mocha — soft pastel palette designed for
 * dark backgrounds, low-saturation accents, no deep contrasts.
 */
export const PALETTE = {
  // status — soft pastels, distinguishable but never punchy
  pending: "#6c7086", // overlay0 — muted slate
  running: "#cba6f7", // mauve — soft purple
  done: "#a6e3a1", // green — sage mint
  gate: "#f9e2af", // yellow — butter peach
  failed: "#f38ba8", // red — coral rose

  // typography
  text: "#cdd6f4", // text — warm off-white
  hint: "#a6adc8", // subtext0 — quiet metadata
  muted: "#7f849c", // overlay1 — labels, dim glyphs

  // structure
  bg: "#1e1e2e", // base — alt-screen canvas
  panelSoft: "#242436", // a touch above bg
  panel: "#313244", // surface0 — phase panel (raises off bg)
  panelRaised: "#45475a", // surface1 — interactive elements
  border: "#45475a", // surface1 — quiet dividers
  borderStrong: "#585b70", // surface2 — phase bar

  // accents
  accent: "#89b4fa", // blue — soft sky
  accent2: "#f5c2e7", // pink — dusty rose
  toolName: "#94e2d5", // teal — Skill glyph
  toolPreview: "#b4befe", // lavender — soft preview text
} as const;
