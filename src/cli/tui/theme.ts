/**
 * Shared color palette for the OpenTUI run UI. Single source of truth
 * referenced by the controller (scrollback writes), the run-app footer
 * components, and any future tooling-side rendering.
 *
 * Tuned to match the ordin logo: a near-black canvas with neon-pastel
 * accents (conductor purple, build amber, evaluate mint, output pink,
 * input cobalt). Catppuccin DNA, pushed one notch toward saturation
 * so the brand identity carries through into the run experience.
 *
 * The `*Glow` tier is intentionally small — used only for the few
 * elements that should pop (active phase strip, gate CTA chip, gate
 * card border). The body palette stays calm so the punchy variants
 * stay meaningful.
 */
export const PALETTE = {
  // status — neon-pastels, distinct against near-black
  pending: "#6c7086", // muted slate
  running: "#b58cff", // conductor purple
  done: "#7ee0a8", // mint neon
  gate: "#f5b942", // amber
  failed: "#ff7aa8", // hot pink

  // typography
  text: "#cdd6f4", // warm off-white
  hint: "#a6adc8", // quiet metadata
  muted: "#9aa0b8", // labels, dim glyphs — bumped from #7f849c so read-row glyphs stay legible against the deeper bg

  // structure
  bg: "#11111c", // canvas — near-black, lets neons glow
  panelSoft: "#171727", // a touch above bg
  panel: "#1c1c2c", // phase panel
  panelRaised: "#262638", // active phase, raised but not yelling
  border: "#2c2c44", // quiet dividers
  borderStrong: "#45475a", // emphasis (active phase outer strip)

  // accents
  accent: "#5fb1ff", // cobalt — input ghost, file-write glyph
  accent2: "#ffa8d4", // soft pink — bash glyph
  toolName: "#94e2d5", // teal — Skill glyph
  toolPreview: "#b4befe", // lavender — soft preview text

  // glow tier — reserved for active phase strip, gate CTA, gate card border
  runningGlow: "#cba6ff",
  doneGlow: "#9aeec0",
  gateGlow: "#ffcc66",
  failedGlow: "#ff9bc0",
  accentGlow: "#86c5ff",
} as const;
