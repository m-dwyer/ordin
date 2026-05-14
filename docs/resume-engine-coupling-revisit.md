# Resume: ordin-state vs engine-native primitives — revisit

**Status:** open question. v1 shipped the ordin-state path (`feat/resume-runs`); this doc captures the trade we made and the questions worth pressure-testing later.

## The choice point

Two paths for cross-process resume:

**A — Ordin-state (what we shipped).** `meta.json` is the single source of truth for "where the run is": `meta.pendingGate`, `meta.inFlight`, `meta.phases`. The engine is a stateless executor — given the meta, it slices the manifest from `nextPhase` and runs. `MastraEngine.resume` reimplements at the harness layer what Mastra's `suspend()` / `run.resume()` provide natively.

**B — Engine-native primitives.** Each engine owns its own checkpoint store. `MastraEngine.resume` calls `mastraRun.resume({stepId, resumeData})`. A future `LangGraphEngine.resume` calls `Command(resume=...)`. Same `Engine.resume(...)` contract; engines fulfil it however their underlying lib does.

Both are engine-portable; the seam exists either way.

## What we actually traded

What we **gained** by shipping (A):
- Ordin's `meta.json` stays the universal record. TUI / audit chain / future HTTP+MCP "list pending gates" all read one place, no engine-specific shims.
- `PhaseTransaction` stays engine-neutral — `await input.onGateRequested(request)` is a plain callback. No engine-supplied "suspend here" primitive.
- No second storage layer; no `@mastra/libsql` dep.
- Stateless-executor model for engines (engine-agnostic resume orchestration in the use case).

What we **gave up**:
- ~150 lines of resume code we now maintain (`MastraEngine.replayPendingGate`, the slicing logic in `MastraEngine.resume`, `PendingGateMarker` plumbing).
- Mid-step resume (Mastra's `suspend()` captures step-internal state; our model restarts the phase).
- Idiomatic Mastra usage other contributors would recognise.

## What the drift argument was actually worth

I leaned on "two storage layers risk drift" defending (A). That's weak:
- The stores cover **different concerns**. Mastra's checkpoint = execution state (which step suspended, prior step inputs/outputs). Ordin's meta = domain state (slug, bundle hash, repo, tier, sandbox mode, audit refs, tokens). Minimal overlap.
- Where they **do overlap** (status, pause point), both are written by the same engine in the same code path at the same logical boundaries. Drift would be a bug, not an inherent risk.
- Clear ownership resolves it. Mastra authoritative for execution state, ordin for domain. No conflict because no shared writers.

Discount the drift argument when revisiting.

## The actual architectural cost of switching to (B)

Not drift. The real cost is:

1. **`PhaseTransaction` takes on an engine-aware boundary.** Today it `await`s `onGateRequested` — a plain callback. To use Mastra's `suspend()`, the gate point has to flow through an engine-supplied primitive (e.g., `engineGate(ctx, request)` on the `Engine` seam) so each engine can wire its native suspend/interrupt.
2. **`Engine` seam grows by one method** (the suspend primitive).
3. **`@mastra/libsql` (or equivalent) becomes a runtime dep**, configured at composition.
4. **`meta.pendingGate` becomes a derived view** over Mastra's store, OR is removed entirely. Downstream readers (TUI, audit, transports) need the new contract.

Estimated cost of the swap: 1–2 days focused work for Mastra side; another similar effort if/when a second engine lands.

## Mid-step resume — the one capability we forfeit

Today: phase boundary granularity. Ctrl-C mid-phase means restart the phase from iteration 1. Acceptable because phases are the natural unit of declared work in ordin.

With Mastra's primitives: a phase could `suspend()` between tool calls. Resume would pick up at the exact tool boundary. Saves the LLM cost of re-running the prefix.

Whether that matters depends on how long phases get. Today they're minutes. If they grow to hours, mid-step resume becomes load-bearing.

## When to revisit

Concrete triggers worth waiting for before swapping:
- A phase that genuinely benefits from mid-step resume (multi-hour dispatch with expensive prefix).
- A second engine implementation lands (`LangGraphEngine`) and we measure how much of the resume code transfers cleanly. If it doesn't transfer, the engine-neutral story was the rationalization, not the value.
- `meta.pendingGate` consumers (HTTP `/runs/<id>/pending-gates`, MCP tool listing) hit awkward shape mismatches that engine-native state would solve.

Without one of those, the v1 ordin-state path is fine.

## Questions to pressure-test

- If we never ship a second engine, is `Engine.resume` doing real work, or is it indirection over `mastraRun.resume`?
- Would the gate-handling refactor (PhaseTransaction → engine-supplied suspend) be a net positive even *without* switching to Mastra's primitives? (It might force cleaner gate semantics regardless.)
- Is the audit chain integration a real reason to keep ordin-state, or could per-step Mastra checkpoints satisfy the same auditability with hooks?
- How much does mid-step resume actually save in the multi-hour case — full measurement or hand-wave?
- Are there other "ordin owns the state" callers (run-store-backed UIs, time-travel debugging, fixture replay) that would break or grow simpler under each path?
