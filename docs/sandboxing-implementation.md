# Sandboxing roadmap

Forward-looking plan for ordin's sandbox boundary. Empirical findings live in [`sandboxing-findings.md`](./sandboxing-findings.md). Architecture diagram source: [`sandboxing-architecture.md`](./sandboxing-architecture.md). Past ADR-style decisions live in [`decisions/sandboxing.md`](./decisions/sandboxing.md).

## Where we are

Inner ordin process sandboxed via `@anthropic-ai/sandbox-runtime` (srt). Parent-side **broker** (`src/broker/`) is srt's `parentProxy`: it forwards approved egress to mapped local services (Langfuse, LiteLLM) with auth injection, hosts a hash-chained per-run audit log at `~/.ordin/runs/<runId>/audit.jsonl`, and authenticates every request via `Proxy-Authorization`. Telemetry credentials and `LITELLM_MASTER_KEY` never enter the inner. Network egress denied by default. macOS only today; Linux comes for free via srt.

Current shape: **inner runs the engine + phase loop + agent**; broker handles credentials and audit. Verifier: `ordin audit verify <runId>`.

## Threat model

The agent (LLM-driven, runtime-executed) is the untrusted code. Sandbox protects:

1. **Filesystem** — agent writes only the workspace, run store, temp; reads denied for credential dirs.
2. **Network egress** — explicit allowlist; everything else denied at the proxy.
3. **Credentials** — secrets the agent shouldn't see live parent-side.
4. **Audit/integrity** — run history can't be tampered with by agent code.

Out of scope: kernel-level sandbox-exec bugs (defended by microVM at L0; not practical on macOS).

## Active work: L2 — worker-per-phase

**Goal:** parent owns the phase loop. Each phase runs in its own sandboxed worker; the worker exits between phases. Gate decisions are made inline in the parent — the inner literally cannot fabricate them because the inner's process is gone by the time the parent decides.

**Why now:** the L3a sequence's remaining steps (gates / OOB / auto-approve) collapse into this — once the parent owns the loop, gates are just local function calls instead of HTTP-mediated decisions. Skipping ahead saves ~3 incremental steps' worth of design + plumbing.

**Constraints (load-bearing):**

- **Sandbox-swappable.** New `Sandbox.spawnWorker(plan): WorkerHandle` method; impls handle their own profile/env/cwd. Future Docker / bwrap impls slot in without touching parent code.
- **Engine-swappable.** Parent doesn't drive the phase DAG itself — it passes an `executePhase` hook to `Engine.run`, alongside today's `onGateRequested`. Engine retains DAG-traversal agency (loops, branches, parallel). Mastra refactors to use the hook; future LangGraph impl does the same.

**Concrete plan:**

1. Add `Sandbox.spawnWorker(plan): WorkerHandle`. SrtSandbox spawns srt-wrapped child with the existing per-run profile; PassthroughSandbox uses `Bun.spawn`. WorkerHandle exposes an `exit` promise.
2. Add `executePhase` hook to `Engine.run`. MastraEngine calls the hook instead of dispatching the runtime directly. Existing `onGateRequested` hook unchanged.
3. Build worker entrypoint (`src/runtime/worker/entry.ts` or similar). Reads phase plan from argv/stdin, instantiates the runtime + tool dispatcher, runs **one** phase, emits events via the existing audit HTTP path, exits with status. No engine, no phase loop, no workflow loading.
4. Wire `HarnessRuntime.startRun` to pass the spawn-worker hook; gate decisions move inline (parent already has the resolver + prompter).
5. End-to-end smoke (sandbox-validation + software-delivery `--only plan`) + audit verify.
6. Update docs (this file + architecture addendum + any new findings).

**What stays untouched:**

- Broker, audit chain, proxy auth, internal-service dispatch.
- HTTP_PROXY routing for tool egress (model HTTPS, telemetry, package fetches).
- AuditEmitter on the inner side — workers still POST to the audit endpoint.

**What goes away:**

- L3a step 3 (HTTP gates) — gates are inline parent-side.
- ORDIN_GATES_ENABLED env flag — never built.

**Out of scope for L2 v1:**

- **Per-phase profile narrowing** (different `allowedDomains` / `allowWrite` per phase based on `allowed_tools`). Real feature, but a separate task. v1 ships per-phase **spawn** with the existing per-run profile; per-phase **profile** comes after the architecture is validated.
- **Phase-to-phase artefact handoff over IPC.** Workspace is shared between workers (it's a directory); declared outputs from phase N are visible to phase N+1 by reading the disk. No explicit handoff protocol needed.

## Sandbox levels (glossary)

Each level moves the process boundary closer to the agent loop.

| Level | What's in the inner | What's in the parent | Status |
|---|---|---|---|
| L4 | Everything (engine, runtime, agent, broker if any) | Nothing | Passthrough mode |
| L3a | Engine, runtime, agent | Broker (credentials + audit) | Shipped (steps 1, 1.5, 2) |
| L2 | Runtime, agent (one phase per worker) | **Engine, phase loop**, broker, gates | **Active** |
| L3 | Engine, runtime, agent (one worker per run) | Broker, RunStore, gates over IPC | Skipped (collapses into L2) |
| L1 | One tool call per worker | Tool dispatcher, everything else | Future opt-in (`--paranoid`) |
| L0 | One tool call per microVM | Everything | Aspirational; needs Linux + Firecracker/gVisor |

L2 is the destination for default operation. L1/L0 are opt-in modes for security-sensitive runs.

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
