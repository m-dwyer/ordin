# Sandboxing roadmap

Forward-looking plan for ordin's sandbox boundary. Past decisions live in [`decisions/sandboxing.md`](./decisions/sandboxing.md). Real-world debugging discoveries live in [`sandboxing-findings.md`](./sandboxing-findings.md). Architecture diagram source: [`sandboxing-architecture.md`](./sandboxing-architecture.md).

## Where we are

**Level 4 + broker, with credential isolation + tamper-evident audit (L3a steps 1, 1.5, 2 shipped).** Whole inner ordin process sandboxed via `@anthropic-ai/sandbox-runtime` (srt). Broker (`src/broker/`) runs in the parent as srt's `parentProxy`: srt enforces the hostname allowlist first, then forwards approved egress to the broker. Broker dispatches by hostname to either *forward* services (proxy to mapped upstream + auth injection) or *internal* services (handled in-broker; today: `audit`). Per-run hash-chained audit log at `~/.ordin/runs/<runId>/audit.jsonl`. Every request requires `Proxy-Authorization` (per-run secret); srt forwards via parentProxy URL userinfo. Network egress denied by default; allowlist gated per-host. macOS only; Linux comes for free via srt.

Shipped:
- B-process self-spawn via srt (`SrtSandbox` in `src/sandbox/srt/`)
- Broker as srt's `parentProxy` — TCP localhost listener with hostname-routed dispatch + per-service auth injection (Basic / Bearer)
- Telemetry credentials (`LANGFUSE_*`) stripped from inner spawn env; broker is the sole party that authenticates to Langfuse
- Inner uses `http://otel/...` via `HTTP_PROXY`; srt allowlist passes; broker maps `otel` → 127.0.0.1:3000 + `Authorization: Basic <pk:sk>`
- IPv4-first DNS in inner and outer (Docker IPv4 binding compat)
- `NO_PROXY` cleared in inner; `LANGFUSE_*` re-stripped post-Bun-`.env.local`-autoload
- `network-validation` and `sandbox-validation` workflows (deterministic regression tests)

Switched from `mitmProxy` (Unix socket) to `parentProxy` (TCP localhost) during step 1 because Bun ≤1.3.13 ignores `http.Agent({ socketPath })` paired with an absolute-URL `path` — exactly the shape srt's mitmProxy forwarder uses. See [`sandboxing-findings.md`](./sandboxing-findings.md) for the diagnosis. parentProxy is also the better fit for L3a's "broker as central policy point" direction: every approved egress now flows through the broker, so audit (step 2), gates (step 3), and OOB approvals (later) are route additions rather than new mechanisms.

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

### L3a — secret + audit isolation (chosen path, skips IPC complexity)
**Trigger:** want L3's credential-isolation + audit-integrity wins without committing to the worker split.
**Why:** ~80% of L3's security delta in a fraction of the change. Keeps B-process; just moves what the agent can see/touch in-process. Treats the broker as the trusted holder of everything the agent shouldn't see, do, or tamper with.

**Sequencing — small bites, each independently shippable:**

1. ✅ **Telemetry off the inner.** OTel exporter → `http://otel/...` → broker (parentProxy) → Langfuse with broker-injected Basic auth. `LANGFUSE_*` stripped from inner. Validates the broker-as-Hono-on-TCP pattern with the simplest possible message type. **(Shipped.)**
2. ✅ **Audit log behind the broker.** Sha256 hash chain, append + fdatasync per entry, per-run JSONL file. Inner posts every `RunEvent` to `http://audit/events`; broker also records its own `broker.forward` / `broker.connect` observations into the same chain (egress visibility for non-HTTP traffic via srt's SOCKS-through-CONNECT path). Required `Proxy-Authorization` (per-run random secret in srt's `parentProxy` URL userinfo) prevents inner-direct forgery. Verifier: `ordin audit verify <runId>`. **(Shipped.)**
3. **Gate state behind the broker.** Inner asks via HTTP, broker decides, broker replies. Decisions become unfakeable by the inner. The `sandboxAskCallback` srt exposes (orthogonal to mitmProxy/parentProxy — fires inside `filterNetworkRequest`) becomes the natural seam for "host not in static allowlist → ask broker → prompt user → cache decision per session".
4. **OOB channel.** Add Signal / Telegram / push as the broker's notification surface. The TUI prompter remains as a fallback. Decision policy: deny-novel-without-OOB-approval for sensitive runs.
5. **`--auto-approve` flag** with three-layer policy (static / auto-with-audit / hard-manual). Per-run flag, never persistent in config. Post-run summary lists decisions for promotion to durable policy.

Steps 4 and 5 are deferred until 1–3 land.

**✅ LiteLLM (step 1.5, shipped):** AI SDK runtime sends to `http://llm-gateway/`; srt forwards through the broker; broker maps to LiteLLM and stamps `Authorization: Bearer <LITELLM_MASTER_KEY>` from parent-side env. The inner has no api_key. This was needed urgently (not optional) because `allowLocalBinding=false` blocks direct dial to `localhost:4000` — without step 1.5, AiSdkRuntime under srt simply doesn't work. See Finding 19 for the empirical verification.

**Trade-off:** doesn't dissolve Finding 8 (TUI coupling), doesn't unblock server-mode sandboxing or Docker/microVM impls. If those triggers don't fire, L3a is enough.

## Independent improvements (any order, any level)

- **Captive workflow + adversarial probes** (ADR-011). LLM-driven agent attempts documented escape categories; humans review for unexpected successes.
- **Profile-level probe tests.** Deterministic vitest probes asserting denied operations are denied. Catches profile-rule regressions in CI.
- **Linux bwrap support** (ADR-004 v2). Inherited via srt; needs Linux contributor to verify.
- **Pre-flight documentation** (ADR-007). README sections on macOS Full Disk Access, choosing sandbox mode, configuring `local_services`.
- **Out-of-band gate approval channels** (ADR-013). Broker extension: Signal/SMS/push-notification path so the agent literally cannot perceive or fake a gate decision.
- **Hash-chained audit log** (ADR-005 v3 follow-on). Tamper-evident `audit.jsonl` for the egress + capability decision streams.
- **Bundle the inner** (`bun build` or `bun build --compile`). Today the inner runs harness TypeScript source directly, which forces the kernel sandbox to allow `node_modules` / tsconfig / source reads from the harness root, and forces dev-mode-specific kernel denies for `<harnessRoot>/.env.local` (Bun's cwd-only autoload would otherwise re-introduce stripped secrets). A bundled or compiled inner has zero runtime dependency on the harness directory: cwd is irrelevant, no `.env.local` autoload concern, no JSX/TS transpile, and the sandbox surface shrinks dramatically. Doubles as the distribution story.

## Order-of-operations decisions

When in doubt, do the cheap and reversible thing first. Don't build for hypothetical triggers.

- **L4 → L3a** if you want credential isolation soon and aren't blocked on server-mode sandboxing.
- **L4 → L3 → L2** if you're committed to per-phase profiles and want to validate the IPC design with one worker first.
- **L4 → L2 directly** if you're confident enough in the IPC design to skip the validation step. More work upfront; arrives at the destination faster.
- **L1** as a future opt-in mode, regardless of which baseline you settle on.

## What this plan deliberately does not cover

- **Per-MCP-server sandbox isolation.** Today MCP servers spawned from inside the harness inherit the harness's sandbox. v3 alternative: each MCP server gets its own sandbox profile. Requires worker-per-MCP plumbing; defer until concrete need.
- **Skill signing** (Ed25519 manifest authentication). Supply-chain protection; activates if/when ordin ships a skill registry.
- **Pre-execution command pattern scanner** (ADR-012). Inner fence catching destructive commands the kernel sandbox allows because they're inside permitted zones. Defense-in-depth; orthogonal to the level ladder.
