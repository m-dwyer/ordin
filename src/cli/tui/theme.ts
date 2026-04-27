/**
 * Shared color palette for the OpenTUI run UI. Single source of truth
 * referenced by the controller (scrollback writes), the run-app footer
 * components, and any future tooling-side rendering.
 */
export const PALETTE = {
  pending: "#5A6478",
  running: "#A28BFF",
  done: "#7AD18C",
  gate: "#FFD580",
  failed: "#FF7A8A",
  text: "#E6EDF3",
  hint: "#8BA6CD",
  border: "#3B5B82",
  bg: "#0B1220",
  panel: "#101A2D",
  toolName: "#66D9EF",
  toolPreview: "#A8C0E4",
} as const;
