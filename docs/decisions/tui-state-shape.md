# TUI state shape — decision record

## ADR-001 — `OpenTuiRunController` keeps signals + stores split; `state()` projection stays

**Status:** Accepted

**Context:** `src/cli/tui/controller.ts` (~677 lines) holds 6 `createSignal` pairs (atomic values: header, gate, egressGate, hint, paused, expanded set, collapsedPhases set), 2 `createStore`s (`phasesStore`, `sectionsStore` for arrays mutated via `produce()`), a non-reactive `Map` for tool bookkeeping, and Promise-resolver refs (`pendingGate`, `pendingEgressGate`, `pendingDismiss`). A manual `state(): ControllerState` getter re-bundles the reactive surfaces into a 14-property object that `<RunApp>` consumes.

Architectural audits look at this and reflexively suggest "collapse the signals into one `createStore<ControllerState>`" or "make the controller directly implement `ControllerState`." Neither is right.

**Decision:**

- Keep the signals + stores split. `createStore` for collections mutated in place (`produce()`); `createSignal` for atomic values replaced whole. This is idiomatic Solid.
- Keep `ReadonlySet<>` values (`expandedSignal`, `collapsedPhasesSignal`) as signals replaced by new instances — Set membership doesn't track reactively inside Solid stores without ceremony, and the replace-whole semantic is what the consumers want anyway.
- Keep the `state()` projection. It's a **capability cut**, not redundant indirection: `<RunApp>` gets the read accessors + decision callbacks it needs (`phases`, `sections`, `gate`, `decideGate`, …) without the lifecycle methods (`mount`, `dispose`, `pushEvent`) that only the CLI session factory should call. Dropping the projection would expose the full controller surface to the renderer.

**Consequences:**

- `controller.ts` stays long (~677 lines). The size is doing real work — there's a lot of event types to handle and a lot of UI state to manage — not bad design.
- Adding a new piece of state touches three places: signal/store definition, `ControllerState` interface in `types.ts`, and `state()` bundle. Mild friction; accepted trade for the capability cut.
- Mutation patterns mix (raw signal calls, `setPhases("list", produce(...))` via helpers, Set replacement) — readers of `controller.ts` need to know which surface uses which pattern. Mitigated by helper methods (`setPhase`, `patchActiveSection`, `appendRow`, etc.).

**What this rules out** (so future audits don't re-suggest):

- Collapsing all reactive surfaces into a single `createStore<ControllerState>`. Trades real cost (Set ceremony, primitive paths) for no win over the current `state()` adapter.
- Making `OpenTuiRunController` directly implement `ControllerState`. Loses the lifecycle/view capability cut.
- Extracting an inner `ControllerStore` class. Relocates the three-place-touch friction without removing it; organizational, not structural.

If the controller grows enough to warrant a real split, the right cut is along behaviour (e.g. extract gate-prompt orchestration as its own collaborator, similar to `GateCoordinator` in the orchestrator) rather than along state shape.
