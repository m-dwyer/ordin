# Resume implementation plan

Cross-process resume for ordin runs. The engine seam (`docs/decisions/engine-resumable.md` / Track 2 of `architecture-cleanup-roadmap.md`) is shaped for this; this plan ships the actual `ordin resume <runId>` capability.

## Scope

**In:** in-process resume on the same machine. User Ctrl-C's, the harness crashes, or the run is killed; `ordin resume <runId>` picks up from the persisted state on disk.

**Out (for now):**
- True cross-machine resume (any host with access to `<root>/runs/<runId>/` resumes). Achievable on top of this plan with no engine changes; not required for the in-process use case.
- Mastra-native suspend / resume (`@mastra/libsql` storage + `suspend()` / `run.resume()`). Lets the engine yield mid-step instead of restarting from the phase top. Layer later if mid-phase restart cost becomes painful; engine-specific.
- Resuming a run on a different bundle, slug, or workspace than it started with.

## Decisions (settled)

1. **Engine-neutral.** Resume reads `RunMeta` from disk and constructs a fresh engine run sliced to start at the right phase. Engines don't expose pause/resume APIs of their own; they're constructed fresh, fed a sliced workflow, and don't know they're a resume.
2. **Persisted state is the source of truth.** `meta.inFlight` and `meta.pendingGate` (written by Steps 2.3 / 2.5) drive re-entry. Live engine state is irrelevant — the process that wrote the markers is gone.
3. **No separate "pause" verb.** Pause = process exits. Whatever's on disk when it exits is the recovery state. The existing AbortSignal path handles in-flight cancellation; persistence is what makes the cancellation recoverable.
4. **Bundle / slug / workspace are fixed.** `ordin resume <runId>` reconstructs them from `RunMeta`. No CLI flags override; flag-driven changes would change the run's identity and should be a fresh run instead.

## Where we are

- `RunMeta` carries `inFlight: { phaseId, iteration, startedAt } | null` and `pendingGate: { phaseId, gateKind, requestedAt } | null`. Both written when the engine enters those windows; both cleared after.
- `nextPhase(plan, runMeta)` in `src/orchestrator/workflow-plan.ts` answers "first phase in plan order not yet completed in `meta.phases`." Engine-neutral.
- `RunHandle.pendingGate(): GateRequest | undefined` exposes the live in-memory gate request from the engine. The handle is the engine-side surface; `session.pendingGates()` / `session.resolveGate()` is the transport-side surface.
- `Engine.start(program, input, services)` returns a `RunHandle`. `Engine.run()` is `start() + awaitCompletion()`.
- `RunStore` writes / reads `meta.json`. Audit chain (`<runId>/audit.jsonl`) is disk-durable per-entry with fsync.

## Re-entry rules

Three mutually-exclusive cases driven by `RunMeta`:

| Persisted state | What happened | Resume action |
|---|---|---|
| `pendingGate != null` | Phase finished its runtime invocation, `PhaseMeta` written, engine was awaiting a gate decision | Re-emit `gate.requested` on the new run's event stream. Transport (CLI prompter, HTTP poll, MCP tool) collects the decision via the same path as a fresh gate. Apply decision; continue from `nextPhase`. |
| `inFlight != null` (and `pendingGate == null`) | A phase was mid-invocation; no `PhaseMeta` was ever written for it (`recordRunResult` clears `inFlight` and pushes meta in the same write) | Clear `meta.inFlight`. Compute `startAt = nextPhase(plan, meta)` — which will be the previously-in-flight phase, since no completed entry exists for it in `meta.phases`. Re-run from iteration 1. Phases produce artefacts as their contract; idempotent re-run is part of the design. |
| Both null | The run completed cleanly (or crashed at a clean boundary). | Nothing to resume. CLI prints the run's final status and exits 0. |

The cases are mutually exclusive by construction:
- `inFlight` is set before `dispatchPhase` and cleared in `recordRunResult` before `PhaseMeta` is pushed.
- `pendingGate` is set inside `PhaseTransaction.execute` *after* `recordRunResult` returns, so by definition `inFlight` is already null when `pendingGate` becomes non-null.
- After `gate.decide` returns, `pendingGate` is cleared before the next phase iterates.

## Plumbing changes

Mostly additive — Track 2 left the seams ready. Concrete files:

### 1. `src/composition/harness.ts`

New facade method: `Harness.resumeRun(runId: string, opts?: ResumeRunOptions): Promise<RunSession>`. Mirrors `prepareRun`'s session-returning shape so callers (CLI, HTTP, MCP) use the same handle either way.

```ts
async resumeRun(runId: string, opts?: ResumeRunOptions): Promise<RunSession> {
  const state = await this.loader.load();
  const meta = await state.runStore.readMeta(runId);
  // assemble StartRunInput from meta; thread session + execution through StartRunUseCase.executeResume(...)
}
```

### 2. `src/composition/start-run.ts`

Add `StartRunUseCase.resume(meta, ...)` (or a sibling `ResumeRunUseCase`). It re-derives `EngineRunInput` from `meta`:

- `task`, `slug`, `tier`, `workspaceRoot` — from `meta` fields.
- `startAt` — derived from `nextPhase(program.plan, meta)` after clearing `inFlight`.
- `onlyPhases`, `phaseSlicing` — copied from `meta.phaseSlicing`.
- `sandboxMode` — from `meta.sandboxMode` (falls back to factory default).
- `onEvent`, `gateResolver`, `dispatchPhase`, `abortSignal` — from the caller, same as start.

If `meta.pendingGate` is set: pass an additional flag (e.g. `replayPendingGate: true`) into `EngineRunInput`. The engine surfaces the gate before any phase runs.

### 3. `src/orchestrator/run-store.ts`

Add a small helper: `clearInFlight(runId): Promise<void>` (or extend the existing in-flight write surface). The resume planner uses this once before kicking off the engine.

### 4. `src/orchestrator/mastra-engine.ts`

`start()` accepts an optional `replayPendingGate: PendingGateMarker` on `EngineRunInput`. If present, the engine emits `gate.requested` for that phase before running any phase, then awaits `onGateRequested` like normal. The decision threads back into `meta.phases[<that phase>].gateDecision` for the phase that's already in `meta.phases`. After the gate, `nextPhase()` advances the run.

This is the only non-trivial engine change. Everything else is "compile workflow sliced to start-at, run normally."

### 5. `src/orchestrator/workflow-plan.ts`

`nextPhase()` already handles the linear case correctly. Sanity-check the loop case: if a rejecter rejected the run on its last iteration and the process died before the loop rerun finished, `nextPhase` should return the goto-target phase, not the rejecter. Confirm + add a unit test.

### 6. CLI command — `src/cli/resume.ts` (new)

```
ordin resume <runId> [--sandbox <mode>]
```

Mirrors `ordin run`'s session construction (TUI / non-TTY split) and calls `harness.resumeRun(runId, opts)`. Same gate prompter wiring as `ordin run`. Reuses `OrdinRunSession`.

### 7. HTTP / MCP

`RunService.resumeRun(runId)` mirrors the start path. Out of scope for this plan beyond surfacing the method — wire when the transports actually need it.

## Failure modes worth thinking through

- **Run was already complete.** `pendingGate == null && inFlight == null && nextPhase == undefined`. CLI prints the final status (read from `meta.status`) and exits 0.
- **Run failed terminally.** `meta.status == "failed"`. Don't resume; print failure summary. (User can start a fresh run via `--again <runId>` to re-derive the same input.)
- **Workspace path no longer exists.** `meta.repo` references a directory that was deleted. Fail fast with a clear error pointing at `--repo` (but the bundle-conflict rule means we don't actually accept `--repo` on resume; user has to recreate or restore).
- **Bundle version changed since the run was last touched.** `meta.bundle.hash` doesn't match the current bundle. Decide: refuse, warn-and-continue, or fail with `--allow-bundle-drift` flag. Default to refuse for safety — the workflow / agents / skills may differ. The `--again` path (different code path) doesn't have this constraint because it's a *new* run.
- **Concurrent resume of the same `runId`.** Two processes both try to resume R1. Either: (a) cooperate via a `<root>/runs/<runId>/.lock` file with PID, fail second invocation; (b) accept it and let the broker-side ACL collisions surface (unlikely to be clean). Default to (a).
- **Mid-resume crash.** The resume process itself crashes. Re-running `ordin resume <runId>` reads the same on-disk state and tries again. Idempotent. The first resume attempt may have left a `PhaseMeta` for a phase it started; the second resume sees it as completed and moves on (or treats as in-flight if it never finished).

## Verification plan

- **Unit:** `nextPhase` against a manually-constructed `meta.phases` for linear, looped, and edge cases.
- **Unit / integration:** `Harness.resumeRun` against a synthesized `meta.json` with each marker state (inFlight set, pendingGate set, neither set, completed).
- **End-to-end smoke:**
  - Run sandbox-validation; Ctrl-C immediately after the gate panel appears; `ordin resume` and confirm it picks up at the gate.
  - Run sandbox-validation; Ctrl-C during the phase's invocation window; `ordin resume` and confirm the phase restarts from iteration 1.
- **Crash-recovery probe** (reusing the marker-probe pattern from Step 2.3 / 2.5): kill mid-phase, inspect `meta.inFlight`, resume, assert completion.

## What this plan does not unlock

- Cross-machine resume (covered by the design but not the CLI; HTTP/MCP layer needs auth + session-ownership semantics).
- Mid-phase resume (engine-native suspend). Requires layering Mastra's `suspend()` + storage adapter; engine-specific.
- Branching / forking from a prior run (different code path; closer to `--again` than resume).
- Modifying the run shape on resume (no `--task`, `--bundle`, etc. flags; those are run-identity).

## Critical files

| File | Change |
|---|---|
| `src/composition/harness.ts` | New `resumeRun(runId, opts?)` facade method |
| `src/composition/start-run.ts` | New `resume(...)` use case method or sibling `ResumeRunUseCase` |
| `src/orchestrator/mastra-engine.ts` | `start()` accepts `replayPendingGate` in `EngineRunInput`; emits the buffered gate request before running phases |
| `src/orchestrator/workflow-plan.ts` | Confirm `nextPhase` correctness for loop case |
| `src/orchestrator/run-store.ts` | Small helper (`clearInFlight`) if convenient; not strictly required |
| `src/cli/resume.ts` (new) | `ordin resume <runId>` command; wires the TUI/non-TTY session like `ordin run` |
| `src/cli/index.ts` | Register the new command |

## Reuse pointers (don't re-implement)

- `OrdinRunSession` (`src/cli/common.ts`) — already wraps the TUI/non-TTY session and gate-prompter wiring; the resume CLI builds the same.
- `DefaultRunSession` (`src/composition/run-session.ts`) — already has `pendingGates()` / `resolveGate()`; the resume's gate replay flows through this path.
- `nextPhase()` (`src/orchestrator/workflow-plan.ts`) — engine-neutral plan traversal already exists.
- `createInitialRunMeta()` (`src/orchestrator/run-store.ts`) — *don't* use this for resume; the meta already exists on disk.
- `Engine.start()` (`src/orchestrator/engine.ts`) — handle the resume case via an optional `replayPendingGate` on `EngineRunInput`; no new engine method needed.

## Estimated effort

Three or four PRs:

1. `nextPhase` loop-case correctness + unit tests. Small. (Possibly a no-op if the existing logic is already correct; verify.)
2. `Harness.resumeRun` + `StartRunUseCase.resume` + `MastraEngine.start()` accepting `replayPendingGate`. Core of the work.
3. `src/cli/resume.ts` + CLI integration. Mostly mirrors `ordin run`.
4. (Optional) `RunService.resumeRun` + HTTP/MCP wiring. Defer until a transport actually needs it.
