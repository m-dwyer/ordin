# Sandboxing roadmap

Forward-looking plan for ordin's sandbox boundary. Empirical findings live in [`sandboxing-findings.md`](./sandboxing-findings.md). Architecture diagram source: [`sandboxing-architecture.md`](./sandboxing-architecture.md). Past ADR-style decisions live in [`decisions/sandboxing.md`](./decisions/sandboxing.md).

## Where we are

Parent owns the engine, phase loop, gate prompters, broker, audit chain, and TUI. Each phase runs in a fresh sandboxed worker (srt-wrapped via `Sandbox.spawnWorker`) that exits when its single `runtime.invoke()` completes. Egress is mediated by the broker: srt's `sandboxAskCallback` routes through `Broker.askApproval`, which surfaces unmapped hosts as a CLI gate card; decisions are sticky for the run. Telemetry credentials and `LITELLM_MASTER_KEY` never enter the worker. Network egress denied by default. macOS only today; Linux comes for free via srt.

Verifier: `ordin audit verify <runId>`.

## Threat model

The agent (LLM-driven, runtime-executed) is the untrusted code. Sandbox protects:

1. **Filesystem** — agent writes only the workspace, run store, temp; reads denied for credential dirs.
2. **Network egress** — explicit allowlist; everything else denied at the proxy.
3. **Credentials** — secrets the agent shouldn't see live parent-side.
4. **Audit/integrity** — run history can't be tampered with by agent code.

Out of scope: kernel-level sandbox-exec bugs (defended by microVM at L0; not practical on macOS).

## Active work: shrink the worker

L2 shipped. Worker today is ~1k LoC of harness code + the runtime adapter. Goal is to push the worker toward "the runtime adapter and nothing else" — every line of TS in the sandbox is attack surface that doesn't need to be there.

**Phase A (shipped): folder reorg + isolation contract.**

- All worker-side modules under `src/worker/` (entry, runtimes, prepare, locator).
- Dependency-cruiser rule: `src/worker/**` may import only from `src/worker/**`, externals, and `type`-only from elsewhere. Value-imports across the boundary are a build error.
- `HarnessConfigLoader` dropped from the worker. Parent extracts the runtime's config slice and ships it in `plan.json`; worker calls `Runtime.fromConfig(slice, ctx)`. No Zod + YAML parser in the sandbox.
- Lazy `import()` per runtime in the registry so unused adapters don't ship.

**Phase B (shipped): lift bookkeeping out of the worker.**

- `PhaseRunner` and `promoteRuntimeEvent` moved to `src/orchestrator/`. Parent emits `phase.started`/`phase.runtime.completed`/`phase.failed` and tags runtime events with run/phase identity.
- Worker writes raw `RuntimeEvent`s as JSONL on stdout; parent reads via `readline` and dispatches. `AuditEmitter` (HTTP POSTs to broker) deleted; `AuditService.asInternalService()` and the broker's audit endpoint removed.
- Tracing now parent-only. Worker no longer calls `startTracing()`. Worker-isolation deps rule tightened to drop the observability allowance.

Worker is now `entry.ts` (~70 lines) + `prepare.ts` (5 lines) + `locator.ts` + the runtime adapter. The next reductions live in Phase C/D.

**Phase C: per-runtime sandboxing.**

The minimum sandboxable unit differs per runtime:

- **`ClaudeCliRuntime`**: the agent is the `claude` binary. Adapter is just a streaming-JSON parser around `spawn`. Parent could wrap `claude -p` directly under sandbox-exec and parse its stdout parent-side — *zero* TS in the sandbox for this runtime. Generalise `Sandbox.spawnWorker(plan)` to `Sandbox.spawnSandboxed(argv, env)` and let the adapter live parent-side.
- **`AiSdkRuntime`**: the decision loop is the Vercel AI SDK in our process. Has to stay in a TS worker.
- **`ScriptedRuntime`**: TS dispatch loop. Has to stay in a TS worker.

Honest asymmetry: the sandbox boundary lives wherever "untrusted execution" actually starts. For claude-cli that's the `claude` binary itself; for the others it's the SDK loop.

**Phase D: bundle + monorepo.**

- `bun build --compile src/worker/entry.ts` produces a single binary. Tree-shakes everything unused; drops the `node_modules` and source-tree dependency at runtime; shrinks srt's filesystem `allowRead` set.
- Promote `src/worker/` → `packages/ordin-worker/` (Bun workspace) when there's a distribution need (versioned releases, downstream pinning). Trivial directory move once the deps-cruiser rule is in place — the boundary is already enforced.

**Out of scope (still):**

- **Per-phase profile narrowing** (different `allowedDomains` / `allowWrite` per phase from `allowed_tools`). Real feature; needs Tools-as-domain. Separate work.
- **Phase-to-phase artefact handoff over IPC.** Workspace is shared between workers (it's a directory); declared outputs from phase N are visible to phase N+1 by reading the disk.

## Sandbox levels (glossary)

Each level moves the process boundary closer to the agent loop.

| Level | What's in the inner | What's in the parent | Status |
|---|---|---|---|
| L4 | Everything (engine, runtime, agent, broker if any) | Nothing | Passthrough mode |
| L3a | Engine, runtime, agent | Broker (credentials + audit) | Shipped (steps 1, 1.5, 2) |
| L2 | Runtime adapter + agent (one phase per worker) | Engine, phase loop, broker, gates, TUI | **Shipped** — see "shrink the worker" above |
| L3 | Engine, runtime, agent (one worker per run) | Broker, RunStore, gates over IPC | Skipped (collapsed into L2) |
| L1 | One tool call per worker | Tool dispatcher, everything else | Future opt-in (`--paranoid`) |
| L0 | One tool call per microVM | Everything | Aspirational; needs Linux + Firecracker/gVisor |

L2 is the default. L1/L0 are opt-in modes for security-sensitive runs.

## Independent improvements (any order, any level)

- **Bundle the inner** (`bun build` or `bun build --compile`). Removes runtime dependency on harness's `node_modules` / tsconfig / source tree. Drops the dev-mode `<harnessRoot>/.env.local` denyRead. Shrinks sandbox surface dramatically. Doubles as the distribution story.
- **Captive workflow + adversarial probes** (ADR-011). LLM-driven agent attempts documented escape categories; humans review.
- **Profile-level probe tests.** Deterministic vitest probes asserting denied operations are denied.
- **Linux bwrap support** (ADR-004 v2). Inherited via srt; needs Linux contributor to verify.
- **Pre-flight documentation** (ADR-007). README sections on macOS Full Disk Access, choosing sandbox mode, configuring `local_services`.
- **Out-of-band gate approval channels** (ADR-013). Broker / parent extension: Signal/SMS/push so gates can be answered remotely.

## Out of scope for the sandbox roadmap

- **Per-MCP-server sandbox isolation.** MCP servers inherit the harness sandbox today; per-server profiles need worker-per-MCP plumbing. Defer until concrete need.
- **Skill signing** (Ed25519 manifest authentication). Supply-chain protection; activates if/when ordin ships a skill registry.
- **Pre-execution command pattern scanner** (ADR-012). Defense-in-depth; orthogonal to the level ladder.
