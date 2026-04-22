# Architecture

This document describes ordin as it exists today in `src/`. ordin is one implementation of the harness pattern; see [`harness-plan.md`](./harness-plan.md) for the full design rationale, stage progression, and deferred-phase triggers.

## The four load-bearing separations

```
┌──────────────────────────────────────────────────────────┐
│  Client interfaces (CLI; future: HTTP, ACP, MCP, ...)    │
│  — only use HarnessRuntime                               │
├──────────────────────────────────────────────────────────┤
│  Orchestrator (sequential state machine, run store)      │
│  — uses Domain and Runtimes via their interfaces         │
├──────────────────────────────────────────────────────────┤
│  Domain (workflow, agent, skill, composer, artefact)     │
│  — pure TypeScript; no orchestrator, no runtime          │
├──────────────────────────────────────────────────────────┤
│  Runtimes (ClaudeCliRuntime; SDK runtime when triggered) │
│  — implement AgentRuntime; no orchestrator               │
└──────────────────────────────────────────────────────────┘
```

**Dependency rule:** the orchestrator imports from domain and runtimes. Domain and runtimes depend on neither each other nor the orchestrator. Clients only go through `HarnessRuntime` — they never reach around it into domain/orchestrator/runtimes directly. Enforced locally via `pnpm deps:check` (dependency-cruiser). Not CI-enforced until Stage 2.

Why these four boundaries: each is independently swappable because dependencies flow one direction.

- Replace the orchestrator with LangGraph → replace one directory, domain/runtimes untouched.
- Add a new client (HTTP, MCP, ACP) → new adapter over `HarnessRuntime`; zero changes elsewhere.
- Add a new runtime (SDK, Mastra, alternate CLI) → new adapter implementing `AgentRuntime`; zero changes elsewhere.
- Add observability (Langfuse) → sidecar decorator wrapping the runtime; no core changes.

## Key interfaces

- **`HarnessRuntime`** (`src/runtime/harness.ts`) — the stable client seam. `startRun`, `listRuns`, `getRun`, `workflowDefinition`, `paths`. Every client adapter calls through this.
- **`AgentRuntime`** (`src/runtimes/types.ts`) — how a phase gets executed. Today there are two:
  - **`ClaudeCliRuntime`** (`src/runtimes/claude-cli.ts`) — production. Spawns `claude -p` against the Max plan. The subprocess contains the tool loop.
  - **`AiSdkRuntime`** (`src/runtimes/ai-sdk/`) — eval-only. Drives Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`) against any OpenAI-compatible provider URL (default: LiteLLM proxy at `localhost:4000`). Contains the tool loop in-process.
  The orchestrator is indifferent — both implement the same interface.
- **`Gate`** (`src/gates/types.ts`) — how a phase handoff is approved. Stage 1 has `ClackGate` (interactive), plus `FileGate` and `AutoGate` as signposts.
- **`Composer`** (`src/domain/composer.ts`) — assembles phase prompts from agent + skills + artefact pointers. Returns a runtime-neutral `ComposedPrompt`.

## Event model

Two event types, split cleanly along the layer boundary:

- **`RuntimeEvent`** (`src/runtimes/types.ts`) — events a single `AgentRuntime.invoke()` emits. One invocation = one subprocess = one stream, including any subagents the runtime delegates to internally (Claude's Task tool). Neutral to runIds and phases.
- **`RunEvent`** (`src/orchestrator/events.ts`) — the unified, temporally-ordered public stream. Merges three sources:
  - Run lifecycle: `run.started`, `run.completed`
  - Phase lifecycle: `phase.started`, `phase.completed`, `phase.failed`
  - Gate lifecycle: `gate.requested`, `gate.decided`
  - Agent observations: `agent.text`, `agent.thinking`, `agent.tool.use`, `agent.tool.result`, `agent.tokens`, `agent.error` — each tagged with `runId` + `phaseId`

The orchestrator (`src/orchestrator/sequential.ts`) is the merging point. It calls `runtime.invoke({ onEvent })` with a closure that wraps each `RuntimeEvent` via `promoteRuntimeEvent()`, then emits its own lifecycle events into the same stream via its `onEvent` callback. Consumers (CLI today, future HTTP / MCP adapters) see one ordered stream; runtimes stay layer-pure.

The plan's `HarnessRuntime.subscribe(runId): AsyncIterable<RunEvent>` (deferred until a second client exists) consumes this same type.

## Runtime / provider / backend — three layers, don't conflate

These are separate concerns, arranged in layers below the orchestrator:

| Layer | What it is | Swap mechanism |
|---|---|---|
| **Runtime** | Executes one phase. Either contains a tool loop (`AiSdkRuntime`) or wraps a subprocess that does (`ClaudeCliRuntime`). | Wire a different `AgentRuntime` class. |
| **Provider** | HTTP endpoint speaking some API shape. Stateless, routes to backends. Examples: LiteLLM proxy, OpenAI, Anthropic's OpenAI-compat, Ollama (native OpenAI-compat). | Change one URL (runtime config). |
| **Backend / Model** | The model doing inference. Opaque strings. `claude-sonnet-4-6`, `gpt-4o-mini`, `qwen2.5-coder:7b`. | Edit LiteLLM's `model_list` (or swap provider). |

So: LiteLLM is a **provider** that `AiSdkRuntime` points at by default — it is not a runtime. "Swapping LiteLLM" = change one URL. "Swapping the provider entirely" (e.g., point `AiSdkRuntime` at Ollama directly) = change one URL. "Swapping the runtime" (e.g., add a Claude Agent SDK-based one in the future) = new adapter implementing `AgentRuntime`.

## What Stage 1 intentionally doesn't have

- No HTTP server, ACP server, or MCP server — Phase 2 / Phase 9 / conditional triggers.
- No Langfuse, LangGraph — Phase 7 / Phase 11 triggers.
- **LiteLLM is present** (Phase 4, eval-only). Production `ordin run` never touches it; `claude -p` on Max plan is the only path.
- No `ordin install` / global symlinks — skills load per-run via `--plugin-dir` against the ordin repo itself (which is a Claude Code plugin, see `.claude-plugin/plugin.json`).

## Module graph (live)

The diagram below is regenerated from the actual code graph via `pnpm deps:graph`. It renders inline on GitHub.

See [`ARCHITECTURE-graph.md`](./ARCHITECTURE-graph.md).

## Further reading

- [`harness-plan.md`](./harness-plan.md) — design document, success criteria, phase triggers.
- [`../CLAUDE.md`](../CLAUDE.md) — conventions for agents and contributors working on ordin.
- [`../README.md`](../README.md) — user-facing install and use.
