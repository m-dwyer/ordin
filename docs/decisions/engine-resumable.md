# Engine seam shape — decision record

## ADR-002 — The `Engine` interface is calibrated for resumable state-machine execution, not just one-shot topology

**Status:** Accepted

**Context:** `src/orchestrator/engine.ts` is the swap interface between the orchestrator and the workflow execution backend. Today's only implementation, `MastraEngine`, runs a workflow to completion in-process and returns a `RunMeta`. A future `LangGraphEngine` is named in `docs/harness-plan.md` as a Phase 11 trigger; its value-add over Mastra isn't parallelism (Mastra already supports `.parallel()`/`.foreach()` and we don't use them) but **cross-process pause / resume** via checkpoint + `interrupt()` semantics.

Architectural audits look at the previous `run(program, input, services) → Promise<RunMeta>` shape and reflexively suggest "engines just need a one-shot run; the resume question is for the planner above." That collapses the seam back to a topology-only interface and removes the precondition that makes resume buildable later without rewriting MastraEngine.

**Decision:**

- `Engine.start(program, input, services) → Promise<RunHandle>` is the load-bearing entry point. It runs the engine until either completion or a yield point (today: completion only; tomorrow: gate yield, abort, checkpoint).
- `RunHandle` carries `runId`, `events` (async-iterable stream), `awaitCompletion()`, and `pendingGate()`. The handle is the abstraction every transport interacts with — CLI awaits completion; HTTP/MCP iterate events; resume transports inspect `pendingGate()` and call back into the engine.
- `Engine.run()` stays in the interface as `start().then(h => h.awaitCompletion())`. Convenience for tests and the single-process CLI; not where new behavior lands.
- Plan traversal is **not** on the engine. "What phase comes next given a partial RunMeta?" lives in `workflow-plan.ts` as a free function over `ExecutionPlan + RunMeta`. Engines traverse the same plan; they don't bring their own answer to that question. (A future engine whose compiled program isn't an `ExecutionPlan` can revisit, but that's a real-second-adapter scenario, not a hypothetical one.)
- `RunMeta` carries three resume-shaped fields persisted on disk: `inFlight` (set before a phase invokes, cleared at completion), `currentPhaseId`, `pendingGate`. The latter two are written null today; they exist so the resume implementation doesn't churn the persistence format later.

**Consequences:**

- The engine seam can absorb gates-as-events (Step 2.5) without changing its shape — `pendingGate()` becomes meaningful inside the same `RunHandle` interface.
- Cross-process resume can land as a follow-up plan without touching the live path. The shape is `engine.resume(checkpoint, decision?)` returning a new `RunHandle`; checkpoints can read from `RunMeta` (in-flight markers) and the audit chain (already disk-durable per-entry).
- `Engine.run()` is a thin wrapper. Removing it later is mechanical; keeping it now means no churn at call sites that don't care about resume.
- `MastraEngine.start()` runs `withSpan` around the full lifetime — the OTel trace covers everything from `run.started` to `run.completed`, same as before.

**What this rules out** (so future audits don't re-suggest):

- Collapsing back to `run(...) → Promise<RunMeta>` as the canonical interface. The whole point of `start` is that it returns control before completion; an await-only interface re-bakes the single-process assumption that the resume work is built to break.
- Putting plan traversal (`nextPhase`, "is this phase complete?", "what should run after the rejecter?") on the engine. Today's two would-be engines compile to the same plan shape; the variation is in lifecycle, not topology.
- Making `RunHandle` engine-specific (e.g. `MastraRunHandle`). One concrete interface; engines that need internal handle state hide it behind the same shape.
- Re-implementing the event stream per engine. `EventBus` lives in `src/orchestrator/` (alongside `events.ts`) and is the canonical pub/sub for `RunEvent` — Mastra uses it; future engines reuse it.

If a future engine demands a fundamentally different lifecycle (e.g. distributed workflow with separate driver process), the right cut is a new `Engine` adapter with its own internal lifecycle wired behind the same `start()` + `RunHandle` contract — not extending the interface with engine-specific knobs.
