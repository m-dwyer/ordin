# Architecture

This document describes ordin as it exists today in `src/`. ordin is one implementation of the harness pattern; see [`harness-plan.md`](./harness-plan.md) for the full design rationale, stage progression, and deferred-phase triggers.

## Load-Bearing Separations

```
┌──────────────────────────────────────────────────────────┐
│  Client interfaces (CLI; future: HTTP, ACP, MCP, ...)    │
│  — only use HarnessRuntime                               │
│  — `cli/gate-prompters/` assembles the CLI gate resolver │
├──────────────────────────────────────────────────────────┤
│  Orchestrator (Engine + PhaseRunner + RunStore)          │
│  — `Engine` interface; `MastraEngine` is today's impl    │
│  — uses Domain and Runtimes via their interfaces         │
├──────────────────────────────────────────────────────────┤
│  Domain (workflow, agent, skill, composer, artefact)     │
│  — pure TypeScript; no filesystem/YAML, no runtime       │
├──────────────────────────────────────────────────────────┤
│  Infrastructure (loaders, frontmatter, artefact files)   │
│  — adapts disk/YAML/frontmatter to domain objects        │
├──────────────────────────────────────────────────────────┤
│  Runtimes (ClaudeCliRuntime, AiSdkRuntime; future SDK)   │
│  — implement AgentRuntime; no orchestrator               │
├──────────────────────────────────────────────────────────┤
│  Gates (Gate / GatePrompter; HumanGate, AutoGate, File)  │
│  — pure business logic; no UI imports                    │
└──────────────────────────────────────────────────────────┘
```

**Dependency rule:** the orchestrator imports from domain, infrastructure, runtimes, and gates. Domain and runtimes depend on neither each other nor the orchestrator. Domain also cannot import infrastructure; file/YAML/frontmatter concerns adapt inward. Clients only go through `HarnessRuntime`, except `cli/gate-prompters/` which legitimately imports from gates and `domain/workflow` to assemble a `Gate` resolver for `human` kinds. Enforced locally via `bun run deps:check` (dependency-cruiser). Not CI-enforced until Stage 2.

Why these boundaries: each is independently swappable because dependencies flow one direction.

- Replace the engine (LangGraph, Temporal, custom) → new `Engine` impl alongside `MastraEngine`; domain/runtimes/gates untouched.
- Add a new client (HTTP, MCP, ACP) → new adapter over `HarnessRuntime`; zero changes elsewhere.
- Add a new runtime (Claude Agent SDK, etc.) → new adapter implementing `AgentRuntime`; zero changes elsewhere.
- Add a new gate prompter (web, Slack, Github approval) → new `GatePrompter` impl in the client layer; gate business logic stays the same.
- Change persistence/loading format (database, remote registry, package bundle) → new infrastructure adapters; domain objects stay unchanged.
- Add observability (Langfuse) → sidecar decorator wrapping the runtime, or wire Mastra's built-in tracing inside `MastraEngine`.

## Key interfaces

- **`HarnessRuntime`** (`src/runtime/harness.ts`) — the stable client seam. `startRun`, `listRuns`, `getRun`, `workflowDefinition`, `paths`. Every client adapter calls through this.
- **`WorkflowLoader` / `compileWorkflowPlan`** (`src/infrastructure/workflow-loader.ts`, `src/orchestrator/workflow-plan.ts`) — loaders parse YAML into manifest objects; executable validation lives in `compileWorkflowPlan()`, which rejects duplicate phase ids, invalid `on_reject` targets, and unsupported topology before returning an engine-neutral plan. `collectWorkflowDiagnostics()` exposes the same checks as structured diagnostics for future CLI/API reporting.
- **`Engine`** (`src/orchestrator/engine.ts`) — the orchestration seam. `compile()` turns a manifest into a stable `WorkflowProgram` containing the engine-neutral `ExecutionPlan`; `run()` and `preview()` execute that program with per-run inputs and services. Today's only implementation is `MastraEngine` (`src/orchestrator/mastra/`), which adapts the program to `@mastra/core/workflows` at run time: each phase becomes a `createStep`; a single `on_reject` back-edge becomes a `.dountil()` loop step. Adding a `LangGraphEngine` later is a new file behind this same interface — no domain / runtime / gate changes.
- **`executePhase` / phase collaborators** (`src/orchestrator/phase-executor.ts`) — engine-neutral phase transaction. Coordinates artefact verification, invocation planning, runtime invocation, gate coordination, and run metadata recording through small collaborators.
- **`PhaseRunner`** (`src/orchestrator/phase-runner.ts`) — invokes one already-prepared phase against an `AgentRuntime`, emits runtime lifecycle events, and returns `{ meta, invokeResult }`. It does not compose prompts, verify artefacts, or call gates.
- **`AgentRuntime`** (`src/runtimes/types.ts`) — how a phase gets executed. Today there are two:
  - **`ClaudeCliRuntime`** (`src/runtimes/claude-cli.ts`) — spawns `claude -p` (the only programmatic path under Max plan). Owns its own config schema (`bin`, `timeout_ms`, per-phase `fallback_model` / `max_turns`) via `fromConfig`. Wires `--setting-sources project`, `--exclude-dynamic-system-prompt-sections`, and `--include-hook-events` always; `--no-session-persistence` and `--include-partial-messages` per `InvokeRequest`. The subprocess contains the tool loop.
  - **`AiSdkRuntime`** (`src/runtimes/ai-sdk/`) — eval-only. Drives Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`) against any OpenAI-compatible provider URL (default: LiteLLM proxy at `localhost:4000`). Contains the tool loop in-process.
  Neither is a committed long-term production choice; both sit behind `AgentRuntime` so the engine swaps one for another without domain changes.
- **`Gate`** (`src/gates/types.ts`) — how a phase handoff is approved. Pure business logic. `HumanGate` delegates to an injected `GatePrompter`; `AutoGate` and `FileGate` are self-contained.
- **`GatePrompter`** (`src/gates/types.ts`) — collects a decision from a human reviewer. CLI ships `ClackGatePrompter` in `src/cli/gate-prompters/clack.ts`; future web/Slack/HTTP clients each ship their own. The harness default `gateForKind` returns `AutoGate` for every kind — safe headless behaviour, and prod callers always supply their own resolver.
- **`Composer`** (`src/domain/composer.ts`) — assembles phase prompts from agent + skills + artefact pointers + structured `Feedback` (rejection from a prior phase). Returns a runtime-neutral `ComposedPrompt`.

## Event model

Two event types, split cleanly along the layer boundary:

- **`RuntimeEvent`** (`src/runtimes/types.ts`) — events a single `AgentRuntime.invoke()` emits. One invocation = one subprocess = one stream, including any subagents the runtime delegates to internally (Claude's Task tool). Neutral to runIds and phases.
- **`RunEvent`** (`src/orchestrator/events.ts`) — the unified, temporally-ordered public stream. Merges three sources:
  - Run lifecycle: `run.started`, `run.completed`
  - Phase lifecycle: `phase.started`, `phase.runtime.completed`, `phase.completed`, `phase.failed`
  - Gate lifecycle: `gate.requested`, `gate.decided`
  - Agent observations: `agent.text`, `agent.thinking`, `agent.tool.use`, `agent.tool.result`, `agent.tokens`, `agent.error` — each tagged with `runId` + `phaseId`

`PhaseRunner` (`src/orchestrator/phase-runner.ts`) is the merging point. It calls `runtime.invoke({ onEvent })` with a closure that wraps each `RuntimeEvent` via `promoteRuntimeEvent()`, then emits phase lifecycle events into the same stream. The engine adds gate and run lifecycle events. Consumers (CLI today, future HTTP / MCP adapters) see one ordered stream; runtimes stay layer-pure.

The plan's `HarnessRuntime.subscribe(runId): AsyncIterable<RunEvent>` (deferred until a second client exists) consumes this same type.

## Runtime / provider / backend — three layers, don't conflate

These are separate concerns, arranged in layers below the orchestrator:

| Layer | What it is | Swap mechanism |
|---|---|---|
| **Runtime** | Executes one phase. Either contains a tool loop (`AiSdkRuntime`) or wraps a subprocess that does (`ClaudeCliRuntime`). | Wire a different `AgentRuntime` class. |
| **Provider** | HTTP endpoint speaking some API shape. Stateless, routes to backends. Examples: LiteLLM proxy, OpenAI, Anthropic's OpenAI-compat, Ollama (native OpenAI-compat). | Change one URL (runtime config). |
| **Backend / Model** | The model doing inference. Opaque strings. `claude-sonnet-4-6`, `gpt-4o-mini`, `qwen3:8b`. | Edit LiteLLM's `model_list` (or swap provider). |

So: LiteLLM is a **provider** that `AiSdkRuntime` points at by default — it is not a runtime. "Swapping LiteLLM" = change one URL. "Swapping the provider entirely" (e.g., point `AiSdkRuntime` at Ollama directly) = change one URL. "Swapping the runtime" (e.g., add a Claude Agent SDK-based one in the future) = new adapter implementing `AgentRuntime`.

## What Stage 1 intentionally doesn't have

- No HTTP server, ACP server, or MCP server — Phase 2 / Phase 9 / conditional triggers.
- No Langfuse — Phase 7 trigger. (Mastra's built-in tracing is reachable through `MastraEngine` if needed.)
- No `LangGraphEngine` — Phase 11 trigger. The `Engine` interface exists; adding LangGraph is a new file alongside `MastraEngine`. Concrete needs that would justify it: XL-tier parallel phases or mid-process resume.
- No `ordin continue` (mid-process resume) — Mastra supports it natively via storage adapters; we'd add `@mastra/libsql` (or similar) when it's wanted. Session ids are already captured by `ClaudeCliRuntime`.
- **LiteLLM is present** (Phase 4, eval-only). Production `ordin run` never touches it; `claude -p` on Max plan is the only programmatic path under that subscription.
- No `ordin install` / global symlinks — skills load per-run via `--plugin-dir` against the ordin repo itself (which is a Claude Code plugin, see `.claude-plugin/plugin.json`).

## Module graph (live)

The diagram below is regenerated from the actual code graph via `bun run deps:graph`. It renders inline on GitHub.

See [`ARCHITECTURE-graph.md`](./ARCHITECTURE-graph.md).

## Further reading

- [`harness-plan.md`](./harness-plan.md) — design document, success criteria, phase triggers.
- [`../CLAUDE.md`](../CLAUDE.md) — conventions for agents and contributors working on ordin.
- [`../README.md`](../README.md) — user-facing install and use.
