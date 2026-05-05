# Mastra-native per-phase agent loops

## Context

`MastraEngine` already encapsulates `@mastra/core/workflows` at the workflow layer (Plan→Build→Review orchestration). The Engine seam is in place for the eventual swap to LangGraph (Phase 11 trigger in `docs/harness-plan.md`).

But the per-phase agent loop layer is **not** Mastra-native. There are three different loop owners:

- `AiSdkRuntime` — calls Vercel AI SDK's `generateText({...})` directly.
- `ClaudeCliProviderRuntime` — hand-rolled loop around `claude -p` stream-json.
- `ClaudeCliRuntime` — delegates entirely to Claude Code's native loop.

The "ordin owns the loop" thesis was meant to apply at both layers; today it's only realized at the workflow layer plus inside the provider runtime's hand-rolled body. Migrating per-phase loops onto Mastra `Agent` aligns the two layers behind one library boundary, so the LangGraph swap is one substitution at each level instead of three.

This plan also creates the natural moment to converge `AiSdkRuntime` and `ClaudeCliProviderRuntime` onto a single tool-execution path (`ToolDispatcher`) — today only the provider and scripted runtimes use it.

## Current state — what changes vs what stays

**Stays unchanged:**
- `Engine` and `MastraEngine` (workflow layer).
- `PhaseRunner` (`InvokeRequest`/`InvokeResult` contract preserved end-to-end).
- `Composer`, `RunStore`, `RuntimeEvent` shape, `ToolDispatcher`, `ToolPolicy` (deferred).
- `ClaudeCliRuntime` — keep as documented exception (Claude Code owns its own loop natively; no model/tool boundary to wrap with `LanguageModelV2`).

**Changes:** `AiSdkRuntime` and `ClaudeCliProviderRuntime` invocation bodies; one new file (Claude `LanguageModelV2` adapter); one new shared module (Mastra-tool wrapper around `ToolDispatcher`).

## Phase A — `AiSdkRuntime` → Mastra `Agent`

Smallest refactor. Validates the pattern.

**Files:**
- `src/worker/runtimes/ai-sdk/index.ts` — replace the `generateText({ model, tools, stopWhen, onStepFinish, ... })` call (lines 138–158) with `new Agent({...}).stream({...})`. Tools already in Vercel `tool({...})` shape (compatible with Mastra Agent verbatim). Move `onStep` mapper into `onStepFinish` callback.
- `test/unit/ai-sdk-runtime.test.ts` — add a `MockLanguageModelV2` (from `ai/test`) injection seam to runtime config so tests stub the model rather than Mastra internals.

**Event parity:** Mastra streams text-deltas per chunk; today AiSdkRuntime emits one `assistant.text` per step. Buffer deltas in `onChunk`, flush once in `onStepFinish` to preserve byte-for-byte event semantics.

**Telemetry:** keep the Langfuse `experimental_telemetry` metadata; Mastra forwards it. Disable AI SDK layer telemetry to avoid duplicate spans — rely on Mastra's wrapping only.

**Validation gate:** snapshot `RuntimeEvent` sequence for a fixed scripted scenario before the migration; the migration must produce the same sequence. Run `test/integration/mastra-engine.test.ts` and `test/integration/cli-run.test.ts` green before proceeding.

## Phase B — `LanguageModelV2` adapter for `claude -p`

New file, no integration with runtimes yet. Ship and unit-test in isolation.

**File:** `src/worker/runtimes/claude-language-model-v2.ts` — implements `LanguageModelV2` against `claude -p --output-format stream-json`.

**Lifecycle:** stateful per-`invoke()`. One adapter instance per `agent.stream()` call. Each `doStream()` invocation spawns a fresh subprocess, kills on first `tool_use` event (preserves today's semantics from `claude-cli-provider.ts:502–505`), captures `session_id`, passes `--resume <session_id>` on the next call. **Re-instantiated per `invoke()`** — never shared across runs.

**Stream translation:** reuse `interpretClaudeStreamLine` (already exported from `claude-cli-provider.ts:359` and well-tested). Map:
- text block → `{type:"text-delta", textDelta}`
- `tool_use` → `{type:"tool-call", toolCallId, toolName, args}` then close stream with `finishReason:"tool-calls"` after kill confirms
- `result.usage` → `{type:"finish", usage, finishReason}`

**Subprocess args:** move `buildArgs`, `renderMessages`, MCP-config writing, spawner injection from `ClaudeCliStreamProvider` into the adapter as private helpers. Keep `interpretClaudeStreamLine` exported (or extract to `src/worker/runtimes/claude-stream/parser.ts`).

**Tests (`test/unit/claude-language-model-v2.test.ts`):**
- Inject scripted spawner; assert `LanguageModelV2StreamPart` sequence per stream.
- Drive two `doStream()` calls on one instance; verify `--resume <session_id>` on the second.
- Verify kill-on-`tool_use` and `finishReason:"tool-calls"`.
- Abort signal propagation.

## Phase C — `ClaudeCliProviderRuntime` → Mastra Agent + ClaudeLanguageModelV2

**Files:**
- `src/worker/runtimes/shared/mastra-tools.ts` (**new**) — exports `buildDispatcherTools(cwd, toolNames, skills, dispatcher, onEvent)`. Each entry is a Vercel `tool({inputSchema, execute})` whose `execute` calls `dispatcher.dispatch(...)` and emits `tool.use` / `tool.result` / `ordin.tool.<name>` timing via `onEvent`. **Convergence point:** AiSdk migrates to this same builder in a follow-up so both Mastra-Agent runtimes share `ToolDispatcher` as the single executor.
- `src/worker/runtimes/claude-cli-provider.ts` — delete the manual loop body (`for (let step = 1; step <= maxSteps; step++)` block, lines 213–334) and `ClaudeCliStreamProvider`. Keep the class shell, config schema, `fromConfig`, `runDir`/transcript bookkeeping, override resolution, `buildProviderSystemPrompt`. Replace invoke body with `new Agent({...}).stream({...})` against `ClaudeLanguageModelV2`.
- `test/unit/claude-cli-provider.test.ts` — switch from `QueueProvider` (a `ClaudeModelProvider` mock) to `MockLanguageModelV2`. Snapshot event parity vs the current `RuntimeEvent` sequence.

**Per-turn timing (`ordin.provider.turn`):** retain — emit from a `LanguageModelV2` callback or wrap each `doStream` call in the runtime to fire timing events. Mastra's per-step span is "LLM step"; ordin's notion is "kill-on-tool-use turn boundary." Keep ordin's; do not double-emit.

**Per-tool timing (`ordin.tool.<name>`):** moves into `buildDispatcherTools` — emit on entry/exit of `dispatcher.dispatch`. This implicitly resolves task #8 (centralize tool timing in dispatcher) since the dispatcher is now the single entry point for tool execution under both Mastra-Agent runtimes.

## What `claude-cli` does (and why we keep it)

`ClaudeCliRuntime` represents a structurally different contract: Claude Code owns the loop, including native plugin discovery (`--plugin-dir`). There's no model/tool boundary on which `LanguageModelV2` operates because Claude Code is doing both. **Keep as an exception**, document in CLAUDE.md when Phase C lands. The Mastra thesis still holds — the only ordin runtime not on Mastra is the one where the model **is** the agent.

## Risks

1. **Stateful `LanguageModelV2` across Agent calls.** Mastra may cache model handles internally. Mitigation: re-instantiate per `invoke()`; verify Mastra Agent doesn't share instances across runs (read `@mastra/core/agent` source).
2. **`onChunk` granularity.** Text-delta streaming changes `assistant.text` event cardinality. Mitigation: buffer in `onChunk`, flush in `onStepFinish`.
3. **Telemetry double-emit.** Both Mastra and AI SDK forward to OTEL. Mitigation: disable AI SDK layer telemetry; rely on Mastra wrapping.
4. **Subprocess kill race in adapter.** Mastra dispatching tools before `child.kill` completes. Mitigation: await close before yielding `finish` (pattern from `claude-cli-provider.ts:515–526`).
5. **`tool-error` discovery in `onStepFinish`.** Today AiSdkRuntime reads `step.content` for `type === "tool-error"`. Verify Mastra preserves this; if not, surface errors inside `buildDispatcherTools` execute wrapper.
6. **`maxSteps` semantics.** Mastra `stepCountIs` may count differently than ordin's `max_steps`. Validate during Phase A.

## Sequencing (strict)

1. **A** — ship; validate `RuntimeEvent` parity and integration suites green. Don't proceed without parity.
2. **B** — ship adapter with full unit coverage; do not wire into runtimes yet.
3. **C** — wire adapter; delete hand-rolled loop and `ClaudeCliStreamProvider`; introduce `buildDispatcherTools`.
4. **Follow-up (out of scope):** migrate `AiSdkRuntime` to `buildDispatcherTools` so both runtimes share `ToolDispatcher`.

## Verification

- **Unit:** `bun test test/unit/claude-language-model-v2.test.ts test/unit/ai-sdk-runtime.test.ts test/unit/claude-cli-provider.test.ts`
- **Integration:** `bun test test/integration/mastra-engine.test.ts test/integration/cli-run.test.ts`
- **Lint/typecheck/deps:** `bun run typecheck && bun run lint && bun run deps:check`
- **Smoke (provider):** `mise run fixture:setup && bun src/cli/index.ts run "Add a tiny README note" --workflow software-delivery-provider --repo .scratch/target-repo --slug provider-smoke --tier S --sandbox passthrough` — same trace shape (Skill load, Read/Glob, Write, completion).
- **Event-parity baselines:** capture `RuntimeEvent` sequences from a fixture run *before* each phase; require the after-run sequences to match (modulo intentional changes called out per phase).

## Critical files

- `src/worker/runtimes/ai-sdk/index.ts` (modified, Phase A)
- `src/worker/runtimes/claude-language-model-v2.ts` (new, Phase B)
- `src/worker/runtimes/claude-cli-provider.ts` (modified, Phase C)
- `src/worker/runtimes/shared/mastra-tools.ts` (new, Phase C)
- `src/worker/runtimes/shared/dispatcher.ts` (unchanged; gains a second consumer in Phase C)
- `test/unit/ai-sdk-runtime.test.ts`, `test/unit/claude-cli-provider.test.ts` (modified)
- `test/unit/claude-language-model-v2.test.ts` (new)

## Open tasks affected

- **#8 (centralize tool timing in dispatcher)** — implicitly resolved by `buildDispatcherTools` in Phase C.
- **#9, #10** — independent of this plan; can land before, during, or after.
