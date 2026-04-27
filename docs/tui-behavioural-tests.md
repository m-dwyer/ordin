# TUI behavioural tests — deferred

Trigger: a `<RunApp/>` regression slips past unit tests, OR we touch the `jumpToPhase` sticky-scroll workaround without breaking it (i.e. we want guardrails before the next refactor).

## Infra

- Add `vite-plugin-solid` as devDep + wire into `vitest.config.ts` (Solid JSX transform).
- Vite plugin to stub `.scm` imports so `@opentui/core` loads in vitest:
  ```ts
  { name: "stub-scm", load(id) { if (id.endsWith(".scm")) return 'export default "";'; } }
  ```
- Verify native binding (`@opentui/core-darwin-arm64`) doesn't break vitest's node env. If it does, may need to `vi.mock` selective sub-modules or run these tests via `bun test` instead.
- Test setup uses `testRender()` from `@opentui/solid` — already imported in `src/cli/tui/preview.tsx`. Returns `{renderer, mockInput, mockMouse, renderOnce, captureCharFrame, captureSpans, resize}`.

## Tests to land once infra is in

### Behaviour (interaction)

- `jumpToPhase` defeats sticky-bottom snap: populate enough sections to overflow viewport, `mockMouse.click()` on a rail dot, `renderOnce()`, assert `scrollTop < scrollHeight - viewport.height`. Render again → assert it stayed (didn't snap back). Guards the `scrollTop = scrollTop` workaround in `run-app.tsx:114-116`.
- Phase header click toggles collapse: click the header, assert collapsed-state class/glyph (`▶` vs `▼`).
- Disclosure click expands/collapses tool groups: click the `▶ explored N files` row, assert child rows mount.
- Keyboard `e`/`c` collapsible cycling: press `e` repeatedly, assert each collapsed item expands in scroll order.
- Keyboard scroll keys (`j`/`k`/`g`/`G`/`space`/`b`): each fires the expected `scrollBy` / `scrollTo`.
- Gate keypress `a`/`r`: pushes gate state, presses `a`, assert `decideGate({status: "approved"})` was called; same for `r` → "rejected".
- Paused `q`/`esc`/`enter`: in failed/halted state, asserts `dismiss()` is called.
- Sticky-scroll auto-stick: scroll to bottom, append new section via state mutation, render, assert still at bottom.
- Sticky-scroll yields to manual: scroll up via mockMouse wheel, append new section, render, assert scrollTop did NOT snap back.

### Render (snapshots)

Use `captureCharFrame()` (plain text grid) for structural snapshots; `captureSpans()` for color-aware spot checks on a few specific cells (status chip bg, phase rail dot, gate border).

- Idle (header only, no phases).
- Single running phase mid-tools (exploration group, note, edit-with-diff).
- Multi-phase: one done past + one running active (active vs past visual rules).
- Gate state with summary + artefacts (markdown summary, `a · approve` / `r · reject` chips).
- Failed phase (coral pinks, error row).
- Active-phase visual lift: assert `┃` heavy border in `runningGlow`, assert active card bg is tinted version of `panelRaised`.
- Banner gradient: assert each of the 5 `ordin` letters renders in interpolated stops of `BRAND_GRADIENT`.
- Tool row alignment: durations right-aligned in 7-cell slot — assert column position consistent across rows.

## Notes

- Snapshot tests catch *what's drawn*, behavioural tests catch *what happens when you interact*. Both are needed; neither replaces the other.
- Snapshots are width-sensitive — pin a fixed `width × height` per test (e.g. 100×40).
- Update snapshots with `vitest -u` when changes are intentional. Diffs in PR review become the visual change record.
- Do NOT add behavioural tests for things TypeScript already enforces (status switch exhaustiveness, prop types).
