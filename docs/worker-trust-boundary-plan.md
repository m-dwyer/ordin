# Worker / broker trust boundary — A+B with pluggable transport

## Context

ADR-016 makes the broker the single dispatch point for tool execution. ADR-018 makes the transport between agent and broker pluggable: in-process by default, HTTP over localhost when sandboxed. ADR-017 moves Mastra's telemetry to direct OTel export so trace hierarchy nests natively. Together these complete the B-worker trust separation reserved in ADR-001 and unlock the pattern scanner deferred in ADR-012.

Today: `ToolDispatcher.dispatch(...)` runs in-process inside the worker (`src/worker/runtimes/shared/dispatcher.ts:39`); audit chain captures broker forwards but not in-worker tool calls; Mastra's spans translate to `RuntimeEvent.timing` and reconstruct flat in Langfuse.

After: tool dispatch goes through `BrokerClient` (interface in `src/broker/`); same policy code (ACL, scanner, audit) runs regardless of transport; default mode keeps single-process simplicity; sandboxed / server modes get physical trust separation. Mastra spans flow native OTel.

## Current state — what changes vs what stays

**Stays unchanged:**
- `Engine` seam, `MastraEngine`, `PhaseRunner`, `RunStore`, gate flow.
- `Workflow` / `Phase` domain types, `allowed_tools` semantics.
- Broker hostname-map for forwarding services (`otel`, `audit`, model upstreams).
- Parent-side OTel SDK for `ordin.run` / `ordin.phase.*` lifecycle.
- Existing `srt` integration (Phase B preserves it; passthrough mode no longer reexecs).

**Changes:**
- New `BrokerClient` interface; two implementations.
- Tool executors move from `src/worker/runtimes/shared/tools.ts` to `src/broker/tools/`.
- `buildDispatcherTools.execute` calls `BrokerClient.dispatchTool` instead of `ToolDispatcher.dispatch`.
- Worker spawn logic varies by sandbox mode (`InProcessBrokerClient` → no worker process; `HttpBrokerClient` → worker spawned, broker as HTTP server).
- Mastra `Observability` swaps `RuntimeEventTracingExporter` for an OTel exporter.

## Phase A — `BrokerClient` interface + `InProcessBrokerClient`; move tool execution

Default-mode lift. After this phase, `--sandbox passthrough` runs everything in one process but every tool call goes through the broker (audit, ACL). HTTP transport not added yet.

**Files:**
- `src/broker/client/types.ts` (**new**) — `BrokerClient` interface, `ToolIntent`, `ToolResult`, typed errors.
- `src/broker/client/in-process.ts` (**new**) — `InProcessBrokerClient`; constructor takes a `Broker` instance, dispatches via direct method calls.
- `src/broker/tools/{read,write,edit,glob,grep,bash,skill}.ts` (**new**) — receives the executors moved from `src/worker/runtimes/shared/tools.ts`. Same input shapes, same behavior.
- `src/broker/dispatch.ts` (**new**) — `Broker.dispatchTool(intent)` body: ACL check (per-phase `allowed_tools`), audit-chain append (intent + decision), executor call, audit-chain append (result), return.
- `src/worker/runtimes/shared/dispatcher.ts` — gutted; replaced by `BrokerClient.dispatchTool`. Keep the file as a thin compatibility shim or delete.
- `src/worker/runtimes/shared/mastra-tools.ts` — `buildDispatcherTools.execute` now calls `ctx.broker.dispatchTool({tool, input, runId, phaseId})` instead of `ctx.dispatcher.dispatch(...)`.
- `src/worker/runtimes/shared/tools.ts` — keep `parseToolSpec` + types; delete the executors (now in broker).
- `src/runtime/harness.ts` — wire `InProcessBrokerClient` into runtime context for passthrough mode.

**Tests:**
- `src/broker/dispatch.test.ts` — ACL deny path, audit envelope shape, executor pass-through.
- `test/unit/shared-tools.test.ts` — relocated executor tests stay green (now testing broker-side modules).
- `test/unit/claude-cli-provider.test.ts`, `test/unit/ai-sdk-runtime.test.ts` — fake `BrokerClient` injected; assert `dispatchTool` invoked instead of dispatcher.

**Verification:** smoke run with `--sandbox passthrough` — `audit.jsonl` shows tool intents (allowed + denied) for every dispatch; `meta.json` token totals unchanged; `RuntimeEvent` stream unchanged on observable surfaces.

## Phase B — `HttpBrokerClient` + multi-process layout

Sandbox mode lift. Worker spawned as separate process; broker becomes localhost HTTP server; tool dispatch flows over HTTP.

**Files:**
- `src/broker/client/http.ts` (**new**) — `HttpBrokerClient`; HTTP+JSON over localhost; reuses `Authorization: Basic <ordin:secret>` from existing broker auth (`src/broker/index.ts`).
- `src/broker/index.ts` — extend the broker hostname-map with an `internal` entry: `tools` → in-broker dispatch handler. Same audit-chain integration.
- `src/runtime/harness.ts` — mode selection: `--sandbox seatbelt` (and `ordin serve` later) wires `HttpBrokerClient`; passthrough keeps `InProcessBrokerClient`.
- `src/runtime/worker-policy.ts` — the existing srt-mode env allowlist already covers the case (no secrets in worker env). Verify the per-run broker secret is delivered via srt's `parentProxy.http`, not via worker env. If srt's transparent redirection requires `HTTP_PROXY` for naked `http://tools/...`, add the non-secret broker URL to the allowlist.
- `src/worker/entry.ts` — initialise `HttpBrokerClient` from env-passed broker URL; pass to runtimes.

**Tests:**
- `src/broker/client/http.test.ts` — request/response framing, error serialization, auth header.
- Contract test (`test/integration/broker-transport-parity.test.ts`, **new**) — same `ToolIntent` against both `InProcessBrokerClient` and `HttpBrokerClient`; assert identical audit envelopes, identical results, identical errors. Fails the build on divergence.

**Verification:** smoke run with `--sandbox seatbelt` — worker process spawned per phase, `HttpBrokerClient` used, `audit.jsonl` matches passthrough's shape.

## Phase C — Pattern scanner (ADR-012 cash-in)

Now that dispatch is in the broker, drop in the pre-execution scanner. Same code path serves both transports.

**Files:**
- `src/broker/patterns.json` (**new**) — versioned pattern list: filesystem-destructive, network-exfil, privilege-escalation, self-modification, shell exotica (categories per ADR-012).
- `src/broker/scanner.ts` (**new**) — pattern matcher; `scan(intent) → {decision: "allow" | "deny", matchedPattern?: string}`.
- `src/broker/dispatch.ts` — call `scanner.scan(intent)` between ACL check and executor; emit `tool.scanner.deny` audit event on match; return scanner-deny error to caller.
- `src/broker/scanner.test.ts` (**new**) — table-driven tests, one row per pattern.

**Verification:** captive workflow (`workflows/sandbox-probe.yaml` per ADR-011) attempts each pattern category; assert the broker rejects all and audit-chain captures each attempt with the matched pattern name.

## Phase D — OTel direct (per ADR-017)

Drop the timing-event translation. Mastra spans become OTel-native.

**Files:**
- `src/worker/observability/tracing.ts` (**new** — only relevant in HTTP-transport mode where worker is a separate process) — `NodeSDK` + `OTLPTraceExporter` pointed at `http://otel/...` via broker. `instrumentations: []`. 5s shutdown timeout.
- `src/worker/observability/mastra-tracing.ts` — replace `RuntimeEventTracingExporter` with an OTel-emitting exporter. In-process mode: emit through harness's existing OTel SDK. HTTP-transport mode: emit through worker's SDK.
- `src/worker/runtimes/claude-language-model-v2.ts` — `ordin.provider.turn` becomes a real OTel span (`tracer.startActiveSpan` at `doStream` start, end at stream close). Drop `onEvent({type:"timing"})`.
- `src/worker/runtimes/shared/mastra-tools.ts` — `buildDispatcherTools.execute` wraps `broker.dispatchTool(...)` in `tracer.startActiveSpan("ordin.tool.<name>", ...)`. Drop the timing-event emission.
- `src/orchestrator/phase-runner.ts` — stop calling `recordSpan` for `event.type === "timing"`. Other RuntimeEvent types unchanged.
- `src/runtime/worker-policy.ts` — `TRACEPARENT` already allowlisted; ensure it's stamped on worker spawn from parent's active phase span.

**Verification:** Langfuse trace tree shows full hierarchy:
```
ordin.run > ordin.phase.<id> > chat > [ chat <model>, ordin.provider.turn, tool: 'X' > ordin.tool.X ]
```
No flat siblings under phase.

## Risks

1. **Audit envelope drift across transports.** Two implementations might disagree on serialisation. Mitigation: contract test (Phase B) is the canonical guard; runs in CI.
2. **In-process mode regresses trust posture vs today's worker.** Today's `--sandbox passthrough` still spawns a worker process (modest crash isolation). Phase A removes that for default mode. Acceptable per ADR-018; explicitly called out in mode-selection UX.
3. **Broker grows beyond audit budget.** Pattern scanner (~200 LOC?) + dispatch handlers (~100 LOC of glue) + tool implementations (~400 LOC moved) push `src/broker/` toward the ADR-001 1500-LOC line. Re-evaluate at end of Phase C; trim if over.
4. **TRACEPARENT timing in Phase D.** Parent's phase span isn't open when the worker boots. Mitigation: extract context per `invoke()`, not at SDK init.
5. **Pattern scanner false positives.** Aggressive patterns will block legitimate commands users expect to work. Mitigation: ship with conservative defaults; provide per-project override file (`.ordin/scanner-allow.json`) for documented exceptions.
6. **Server-mode unblocking.** ADR-008 deferred sandboxing for `ordin serve` / `ordin mcp`. Phase B's HTTP-transport unblocks them — out of scope for this plan but worth flagging.
7. ~~**Broker-side bash bypasses srt FS isolation.**~~ Resolved by the ADR-016 correction (Phase B-bis): tool execution moved back worker-side, so bash runs inside the kernel sandbox under `--sandbox srt` and the broker is policy + audit only.

## Sequencing (strict)

1. **A** — broker dispatch with InProcess transport. Default-mode runs use the new path; smoke run + audit.jsonl shape verified.
2. **B** — HTTP transport added; contract test enforces parity. Sandboxed runs use new path.
3. **C** — pattern scanner; captive workflow exercises it.
4. **D** — OTel direct; Langfuse hierarchy verified.

A → B is the critical sequencing — B's contract test depends on A's surface being stable. C and D are independent and can land in either order.

## Verification

- **Unit:** new tests per phase as listed; `mise run typecheck && mise run lint && mise run deps-check && mise run test` green.
- **Integration:** `mastra-engine`, `cli-run`, `harness-runtime` suites stay green.
- **Smoke (default):** `bun src/cli/index.ts run "Add a tiny README note" --workflow software-delivery-provider --repo .scratch/target-repo --slug trust-boundary-passthrough --tier S --sandbox passthrough`. Verify audit.jsonl, meta.json totals, Langfuse trace shape.
- **Smoke (sandboxed):** same with `--sandbox seatbelt`. Verify worker is a separate process, HTTP-transport audit envelopes match passthrough, srt allowlist still gates non-broker egress.
- **Captive workflow (Phase C):** `workflows/sandbox-probe.yaml` runs each pattern category and confirms rejection.

## Critical files

- `src/broker/client/types.ts`, `src/broker/client/in-process.ts`, `src/broker/client/http.ts` (new, Phases A & B)
- `src/broker/dispatch.ts`, `src/broker/scanner.ts`, `src/broker/tools/*.ts` (new, Phases A & C)
- `src/worker/runtimes/shared/mastra-tools.ts` (modified, Phase A & D)
- `src/worker/runtimes/shared/dispatcher.ts`, `tools.ts` (gutted/deleted, Phase A)
- `src/runtime/harness.ts`, `src/runtime/worker-policy.ts` (modified, Phase B)
- `src/worker/observability/tracing.ts` (new, Phase D)
- `src/worker/observability/mastra-tracing.ts` (modified, Phase D)
- `src/worker/runtimes/claude-language-model-v2.ts` (modified, Phase D)
- `src/orchestrator/phase-runner.ts` (modified, Phase D)
- `test/integration/broker-transport-parity.test.ts` (new, Phase B — contract test)
