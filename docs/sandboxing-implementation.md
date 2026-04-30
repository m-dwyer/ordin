# Sandboxing roadmap

Forward-looking plan for ordin's sandbox boundary. Past decisions live in [`decisions/sandboxing.md`](./decisions/sandboxing.md). Real-world debugging discoveries live in [`sandboxing-findings.md`](./sandboxing-findings.md). Architecture diagram source: [`sandboxing-architecture.md`](./sandboxing-architecture.md).

## Where we are

**Level 4 + broker.** Whole inner ordin process sandboxed via `@anthropic-ai/sandbox-runtime` (srt). Broker (`src/broker/`) runs in the parent and fronts declared local services through srt's mitmProxy hook. Network egress denied by default; allowlist gated per-host. Local services declared in `ordin.config.yaml`'s `sandbox.local_services` map; broker forwards by name. macOS only; Linux comes for free via srt.

Shipped:
- B-process self-spawn via srt (`SrtSandbox` in `src/sandbox/srt/`)
- Broker module (`src/broker/`) consuming srt's `mitmProxy` socket
- Per-host + per-port granularity for local services
- IPv4-first DNS in parent (Docker IPv4 binding compat)
- `NO_PROXY` cleared in inner (Bun polyfill bypass closed)
- Tracing through proxy via OTel `httpAgentOptions`
- `network-validation` and `sandbox-validation` workflows (deterministic regression tests)

## Threat model in scope

The agent (LLM-driven, runtime-executed) is the untrusted code. Sandbox boundary protects:
1. **Filesystem** — agent writes only the workspace, run store, temp; reads denied for credential dirs.
2. **Network egress** — explicit allowlist; everything else denied at the proxy.
3. **Credentials** — secrets the agent shouldn't see (Langfuse keys, future API tokens) live parent-side.
4. **Audit/integrity** — run history and gate decisions can't be tampered with by agent code.

Out of scope: kernel-level sandbox-exec bugs (defended by microVM at L0; not practical on macOS).

## Roadmap (security levels, tightest first)

The kernel sandbox is the load-bearing security primitive. Each level moves where the *process boundary* sits relative to the agent loop, shrinking the agent's in-process blast radius.

### L0 — per-call microVM
**Trigger:** hosted/multi-tenant operation OR threat model includes kernel-class escapes.
**Why:** strongest isolation. Each tool call runs in a fresh hardware-isolated VM (Firecracker / gVisor).
**Work:** non-trivial; requires Linux host and a microVM runtime.
**Status:** aspirational. Not relevant on macOS dev tools.

### L1 — per-call kernel sandbox
**Trigger:** opt-in `--paranoid` mode for security-sensitive runs; concrete need for per-action blast radius.
**Why:** each tool invocation in a fresh kernel sandbox with a profile narrowed to that call.
**Work:**
- Refactor tool dispatcher: every tool spawns (today only Bash/Skill spawn; Read/Write/Edit/Glob/Grep are in-process).
- Per-tool profile derivation (Bash → exec; Read → fs-read-only on path; Write → narrow workspace write; etc.).
- Per-call latency budget — process spawn 10-50ms × ~50 calls/phase = 500-2500ms overhead.
- Stateful tools (long-running shell, persistent LSP) become impossible; fine for now since ordin has none.

**Status:** opt-in mode for the future. Default operation should not pay this cost.

### L2 — worker-per-phase (default destination)
**Trigger:** per-phase profiles derived from `allowed_tools` justify the isolation; phase boundaries become real isolation boundaries.
**Why:** each phase runs in its own sandboxed worker with a profile narrowed to that phase's declared tool surface. Plan phase can't write workspace; Build phase can't read credential dirs; Review phase is read-only.
**Prereqs:**
- **L3 IPC plumbing** (parent ↔ worker JSONL pipe; gate roundtrips; event forwarding). L3 validates the protocol with one worker per run before scaling to one per phase.
- **Tools-as-domain** (`Tool`, `ToolCapabilities` types). Per-phase profile derivation reads `allowed_tools` from the workflow YAML and produces a `SandboxRuntimeConfig`. Today `allowed_tools` is just strings; L2 needs structured capability metadata.
- **Phase-to-phase artifact handoff.** With each phase a fresh worker, declared outputs from phase N must be visible to phase N+1 via the shared workspace.
**Work:**
- Spawn fresh worker per phase via `Sandbox.spawnWorker(profile)`.
- Per-phase `buildSrtConfig(params, policy, allowedTools)` derives the profile.
- Workflow YAML gains optional per-phase `network: { allowed_domains: [...] }` overrides.

### L3 — worker-per-run (stepping stone)
**Trigger:** server-mode sandboxing (`ordin serve`, `ordin mcp`) OR Finding 8's TUI-coupling workaround becomes fragile under refactor.
**Why:** parent process unsandboxed; sandboxed worker spawned for the engine + runtimes. TUI, RunStore, gates, broker stay parent-side. Validates the IPC design with one worker before L2.
**Work:**
- Define parent ↔ worker JSONL message protocol (`RunEvent`, `GateRequest`, `GateResolution`).
- Worker entrypoint (`src/runtime/worker/entry.ts`): reads run plan from stdin, instantiates engine + runtimes, emits events.
- Parent host (`src/runtime/worker/host.ts`): spawns worker via `SrtSandbox.spawnWorker`, multiplexes stdio, forwards gate requests to TUI prompter, forwards resolutions back.
- Move RunStore writes to parent (parent receives `run.event.*` and persists).
- Move gate-decision plumbing to parent.
- Strip secrets (Langfuse keys, future API tokens) from worker spawn env.
- `Sandbox` interface gains `spawnWorker(args): WorkerHandle`. Default impl in `PassthroughSandbox` is plain `Bun.spawn`.

### L3a — secret + audit isolation (alternate path, skips IPC complexity)
**Trigger:** want L3's credential-isolation + audit-integrity wins without committing to the worker split.
**Why:** ~80% of L3's security delta in a fraction of the change. Keeps B-process; just moves what the agent can see/touch in-process.
**Work:**
- Strip secrets from inner spawn env in `SrtSandbox.enterIfNeeded`.
- RunStore writes mediated by the broker (broker writes; inner emits write events over a Unix socket; broker validates and persists).
- Gate-decision state moved out of the inner process.

**Trade-off:** doesn't dissolve Finding 8 (TUI coupling), doesn't unblock server-mode sandboxing or Docker/microVM impls. If those triggers don't fire, L3a is enough.

## Independent improvements (any order, any level)

- **Captive workflow + adversarial probes** (ADR-011). LLM-driven agent attempts documented escape categories; humans review for unexpected successes.
- **Profile-level probe tests.** Deterministic vitest probes asserting denied operations are denied. Catches profile-rule regressions in CI.
- **Linux bwrap support** (ADR-004 v2). Inherited via srt; needs Linux contributor to verify.
- **Pre-flight documentation** (ADR-007). README sections on macOS Full Disk Access, choosing sandbox mode, configuring `local_services`.
- **Out-of-band gate approval channels** (ADR-013). Broker extension: Signal/SMS/push-notification path so the agent literally cannot perceive or fake a gate decision.
- **Hash-chained audit log** (ADR-005 v3 follow-on). Tamper-evident `audit.jsonl` for the egress + capability decision streams.

## Order-of-operations decisions

When in doubt, do the cheap and reversible thing first. Don't build for hypothetical triggers.

- **L4 → L3a** if you want credential isolation soon and aren't blocked on server-mode sandboxing.
- **L4 → L3 → L2** if you're committed to per-phase profiles and want to validate the IPC design with one worker first.
- **L4 → L2 directly** if you're confident enough in the IPC design to skip the validation step. More work upfront; arrives at the destination faster.
- **L1** as a future opt-in mode, regardless of which baseline you settle on.

## What this plan deliberately does not cover

- **Compiled-binary distribution** (`bun build --compile`). Distribution work, not sandboxing.
- **Per-MCP-server sandbox isolation.** Today MCP servers spawned from inside the harness inherit the harness's sandbox. v3 alternative: each MCP server gets its own sandbox profile. Requires worker-per-MCP plumbing; defer until concrete need.
- **Skill signing** (Ed25519 manifest authentication). Supply-chain protection; activates if/when ordin ships a skill registry.
- **Pre-execution command pattern scanner** (ADR-012). Inner fence catching destructive commands the kernel sandbox allows because they're inside permitted zones. Defense-in-depth; orthogonal to the level ladder.
