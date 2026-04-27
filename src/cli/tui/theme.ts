/**
 * Shared color palette for the OpenTUI run UI. Single source of truth
 * referenced by the controller (scrollback writes), the run-app footer
 * components, and any future tooling-side rendering.
 */
export const PALETTE = {
  pending: "#697286",
  running: "#9D8CFF",
  done: "#79D58C",
  gate: "#FFD166",
  failed: "#FF6B86",
  text: "#EDF3FF",
  hint: "#98A9C7",
  muted: "#65738D",
  border: "#38557A",
  borderStrong: "#5978A6",
  bg: "#0B1020",
  panel: "#121A2A",
  panelRaised: "#172338",
  accent: "#7AB8FF",
  accent2: "#D77CC8",
  toolName: "#6EDFF6",
  toolPreview: "#B5C7E6",
} as const;
