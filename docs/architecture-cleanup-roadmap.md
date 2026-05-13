# Architectural cleanup roadmap

North-star roadmap for tightening the harness's layering and evolving the `Engine` seam to be ready for cross-process pause/resume in a follow-up plan. Each numbered step is its own PR.

## Decisions (settled during planning)

- Workflow shape stays sequential here. The independent `dag-workflow-plan.md` ships separately.
- Pause/resume seams are designed in this roadmap; the implementation is a follow-up plan.
- Runtime split (collapse `ClaudeCliRuntime` vs. keep both) is parked. No forcing function yet.

## Where we are

- CLI → Harness rule honored everywhere except `src/cli/doctor.ts` (one composition import).
- `RunService`, HTTP, MCP, client all route through `Harness`.
- Domain and `infrastructure/` are clean leaves; no upstream leakage.
- Engine interface is engine-neutral: `WorkflowProgram = { manifest, plan: ExecutionPlan }`. No Mastra types leak past `src/orchestrator/mastra/`.
- `onGateRequested` is already async-by-contract — engine docs comment says the callback may "take arbitrary time, persist state, resume from elsewhere."
- `executePhase()` at `src/orchestrator/phase-transaction.ts:255` is already the engine-neutral per-phase entry point.
- One load-bearing layering violation: `src/orchestrator/phase-transaction.ts:5` imports `ArtefactManager` from `infrastructure/`.

## Ordered improvements

Suggested order: **1.1 → 1.2 → 1.3 → 1.4 → 2.1 → 2.2 → 2.3 → 2.4 → 2.5 → Track 3 (as demand appears).**

### Track 1 — Layering cleanup (no behavior change)

**1.1. Split `ToolAuthority` into catalog/parsing + `ToolPolicy` class.**

- New `src/domain/tool-policy.ts`: `class ToolPolicy` with `static from(input)` and `decide(intent) → PolicyDecision`. Owns glob matching (`globMatches`/`globRegex` move out of `broker/dispatch.ts`).
- `src/domain/tool-authority.ts` keeps catalog, `parseToolSpec`, `isKnownToolName`, `knownToolNames`, `toolMatchValue`, `normalizeToolMatchValue`.
- `src/broker/dispatch.ts`: ACL miss + unknown-tool stay broker-side; pattern matching delegates to `policy.decide(intent)`. The ACL map becomes `Map<aclKey, ToolPolicy>`.
- Tests: move pattern-matching cases to `tool-policy.test.ts`; broker keeps ACL/audit assertions.

**1.2. Collapse hypothetical `application/ports/` into `composition/`.**

- Move `start-run.ts`, `preview-run.ts`, `run-queries.ts`, `workspace-resolver.ts`, `types.ts`, `workflow-slice.ts` from `src/application/` into `src/composition/`.
- Delete `src/application/ports/*`. Use cases depend on `DefaultHarnessStateLoader` and `DefaultRunExecution` directly.
- Update `bun run deps:check` rules. `Engine` remains the canonical real-two-adapter seam.

**1.3. Resolve `orchestrator/phase-transaction.ts → infrastructure/artefact-manager` violation.**

- New `ArtefactStore` interface in `src/domain/` (read-existence + declared inputs/outputs validation).
- Composition root injects an `ArtefactManager`-backed implementation through `EngineServices` or `PhaseRunner` (Step 2.1).

**1.4. Move `cli/doctor.ts → composition/resolve-claude-bin` import.**

- Re-export via `Harness.paths()` or a `Harness.runtimeDiagnostics()` accessor so doctor goes through the facade.

### Track 2 — Engine seam evolution (Mastra-only impl)

**2.1. Extract `PhaseRunner` as the engine-neutral per-phase service.**

- New `src/orchestrator/phase-runner.ts`. `PhaseRunner.runPhase(phase, ctx) → PhaseInvocationResult` wraps today's `executePhase()`.
- `MastraEngine` calls `PhaseRunner.runPhase` instead of `executePhase` directly (today's call sites: `src/orchestrator/mastra/index.ts:206, 230`).
- `PhaseRunner` is also the injection point for the `ArtefactStore` from Step 1.3.

**2.2. Refactor `DefaultRunExecution` to a single `create()` factory.**

- Replace `new DefaultRunExecution(opts)` + `await prepareInfra()` with `static async create(opts) → DefaultRunExecution`.
- Construction-order constraints (audit → brokerDispatch → broker → sandbox) documented inline.
- `Harness.preflight()` calls `create()` and discards the instance.

**2.3. Add per-phase in-flight markers to `RunMeta`.**

- New `RunMeta.inFlight: { phaseId, startedAt } | null` written before phase invocation, cleared at completion.
- New `currentPhaseId` and `pendingGate` fields stay null until resume work needs them.
- Files: `src/orchestrator/run-store.ts`, `src/orchestrator/phase-transaction.ts`.

**2.4. Grow the `Engine` interface to be resume-shaped (no implementation yet).**

- Add `Engine.nextPhase(program, runMeta) → PhaseId | undefined`.
- Add `Engine.start(program, input, services) → Promise<RunHandle>` where `RunHandle` exposes `events`, `awaitCompletion()`, `pendingGate()`.
- Keep `run() → Promise<RunMeta>` as a thin wrapper around `start() + awaitCompletion()`.
- `MastraEngine` implements `start()` and `nextPhase()`. Resume across processes is *not* implemented — the seam is shaped for it.
- ADR `docs/decisions/engine-resumable.md` lands with this PR.

**2.5. Flip gates from blocking callback to engine event + resume (internal contract change).**

- Gate requests surfaced via `RunHandle.pendingGate()`.
- `DefaultRunSession.gateResolver()` / `DeferredGatePrompter` becomes the canonical pattern (already exists; elevated, not invented).
- `onGateRequested` callback preserved as a convenience for in-process callers.

### Track 3 — Phase schema additions (interleave with demand)

Each ships independently. Schema in `src/domain/workflow.ts`, composer pass-through in `src/worker/composer.ts`, runtime translation per `src/worker/runtimes/*`.

**3.1. `Phase.effort`** — Claude CLI `--effort <level>`; AiSdkRuntime translates to provider reasoning hints, silent no-op for providers without one.

**3.2. `Phase.output_schema`** — Claude CLI `--json-schema <path>`; AiSdkRuntime validates with N-retry. New `src/infrastructure/schema-loader.ts`.

**3.3. `Phase.mcp`** — new `src/domain/mcp.ts` + `src/infrastructure/mcp-loader.ts`. Claude CLI `--mcp-config`; AiSdkRuntime `experimental_createMCPClient`.

**3.4. `Phase.max_budget_usd`** — Claude CLI `--max-budget-usd`; AiSdkRuntime post-invocation usage check.

**3.5. `Phase.permission_mode`** — Claude CLI `--permission-mode`; AiSdkRuntime tool-loop filter.

## Parked (do not fold in)

- **DAG workflow shape** — see `dag-workflow-plan.md`. Independent PR. Designed to compose with Track 2 (unified `ExecutionPlan` does not change the `Engine` interface).
- **Runtime split** — see `docs/workflow-runtime-thinking.md` §6, §13. No forcing function. Track 3 changes apply to either outcome.
- **`LangGraphEngine`** — Phase 11 trigger unmoved in `docs/harness-plan.md`. Track 2 is the precondition; no implementation in this roadmap.
- **Resume implementation** — separate follow-up plan after Step 2.4 lands.

## Verification per step

- `bun run typecheck`, `bun run lint`, `bun run deps:check`, `bun run test` green.
- Track 1 + 2.1 / 2.2 / 2.5: existing `software-delivery` smoke run against the fixture project produces an equivalent `meta.json` (modulo timestamps).
- 2.3: kill the harness mid-phase; on-disk `meta.json` shows the in-flight phase marker.
- 2.4: new unit test — `engine.start()` returns a handle; `handle.awaitCompletion()` resolves to the same `RunMeta` as today's `run()`.
- Track 3: per-step golden-file test against a fixture workflow exercising the new field.
