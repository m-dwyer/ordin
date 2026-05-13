# CLAUDE.md

Conventions for agents (and humans) working **on** the ordin repo itself. ordin is a harness implementation — see [`docs/harness-plan.md`](./docs/harness-plan.md) for the end-to-end design.

## Stack

- **Runtime + package manager:** Bun (pinned in `.mise.toml` and `package.json` > `packageManager`). Bun runs TypeScript natively — no build step, no `tsx`.
- **Language:** TypeScript 6, strict mode, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`.
- **Entrypoint:** `bun src/cli/index.ts <cmd>` runs the CLI directly from `src/` (or `bun run ordin <cmd>` via the package script).
- **Linter / formatter:** Biome v2 — 2-space indent, double quotes, 100 col. Run `bun run lint` / `bun run format`.
- **Tests:** Vitest v4 (runs under Bun via `bun run test`).
- **Deps:** commander (CLI), @opentui/core + @opentui/solid + solid-js (run-time TUI footer + gate prompter), yaml (config), gray-matter (frontmatter), zod (schemas), @mastra/core (workflow engine), ai + @ai-sdk/openai-compatible (AiSdkRuntime — eval only), openai (transitive), autoevals (LLM-as-judge scoring for evals), @opentelemetry/* (tracing — opt-in via `LANGFUSE_*` env vars).

## Architecture — the four load-bearing separations

```
cli/           client interface — only uses Harness
                tui/             OpenTUI + Solid run UI (controller + footer app + non-TTY sink)
                gate-prompters/  CLI-side prompters (OpenTUI); CLI assembles its own gate resolver
composition/   composition root — Harness facade + concrete adapter
                implementations of application-layer ports (DefaultHarnessStateLoader,
                DefaultRunExecution, DefaultRunExecutionFactory, worker-dispatch, etc.)
application/   use cases (StartRun, PreviewRun, ListRuns, GetRun, VerifyAudit) and
                ports/ (HarnessStateLoader, RunExecutionFactory). Production use cases
                only depend on these ports; runtime news up the concrete impls.
orchestrator/  Engine interface + PhaseRunner + RunStore
                mastra/   MastraEngine — compiles Workflow → Mastra workflow
gates/         Gate / GatePrompter interfaces + HumanGate / FileGate / AutoGate (pure business logic)
worker/        sandboxed code path — runtimes (AgentRuntime impls) + locator
infrastructure/ disk loaders only — config, agents, skills, projects, workflow YAML
domain/        pure types + composer + slug rule (no orchestrator, no runtime)
sandbox/       isolation primitive (leaf — depends on nothing else in src)
```

**Dependency rule:** `cli` only goes through `Harness`. `Harness` (in `composition/`) is the composition root: it news up the concrete adapter implementations and injects them into the application-layer use cases. `application/` depends only on its own `ports/`, plus `domain/`, `gates/`, and `orchestrator/` types — never on `composition/`, `cli/`, or `infrastructure/` (production code). `*.test.ts` co-located in `application/` are exempt and may wire real adapters end-to-end. `infrastructure/` adapts disk → domain and depends on nothing else above. `domain/` and `sandbox/` are leaves. Targeted exception: `cli/gate-prompters/` legitimately imports from `gates/` and `domain/workflow.ts` to assemble the CLI's gate resolver. Enforced via `bun run deps:check` (dependency-cruiser) — run locally before commits; no CI enforcement yet.

**Engine seam.** `Engine` (in `src/orchestrator/engine.ts`) is the swap interface. `MastraEngine` is today's only implementation, backed by `@mastra/core/workflows`. A future `LangGraphEngine` or any other implementation lives behind the same interface — domain, runtimes, gates, composer, CLI, and YAML content stay unchanged.

## Style

- Classes for loaders, adapters, and services (WorkflowLoader, HumanGate, ClaudeCliRuntime, MastraEngine, etc.). Service-shaped function-type aliases (`(opts) => Promise<X>` that pre-binds config and is constructed once) should be classes too — single concrete class is fine, no interface needed unless there's a real second adapter.
- Plain `readonly` interfaces for data that flows between layers.
- Named exports only — no default exports.
- No `.ts` or `.js` extensions on relative imports (Bundler resolution handles it).
- Zod schemas are the source of truth at I/O boundaries; `z.infer<typeof Schema>` for types.

### When to introduce an interface

Default to a single concrete class. Add an `interface` (or rename the class to `Default*` and extract an interface) **only when there is a real second implementation that varies the behaviour across a meaningful boundary** — typically:

- A vendor / engine swap (the `Engine` seam — Mastra today, LangGraph future).
- A transport seam (e.g. `BrokerClient` over in-process vs. HTTP).
- A trust / process boundary (worker-side vs. parent-side adapters).

Two impls with the same method signature and trivial constructor differences (e.g. "with prompter" vs. "without prompter", "real vs. test fixture") do **not** justify an interface. Express the variation via constructor parameters on one class, or via a small fixture class that implements an existing seam (`AutoApprovePrompter implements GatePrompter`). One adapter = hypothetical seam.

## Comments

- Default: no comments. Well-named identifiers document *what*.
- Block comment at the top of a file or class explaining *why* a design choice was made, or linking to the plan section that motivates it.
- Never write `// added for X` or `// removed Y` — that belongs in git history.

## Where things live

| Concern | Path |
|---|---|
| Phase agents | `agents/*.md` (frontmatter + body) |
| Skills (hand-authored) | `skills/<name>/SKILL.md` |
| Plugin manifest (Claude-side) | `.claude-plugin/plugin.json` — loaded via `--plugin-dir` per run |
| Workflows | `workflows/*.yaml` |
| Per-phase defaults | `ordin.config.yaml` (top-level harness config; `runtimes.<name>.*` is opaque to the domain — each runtime owns its own schema via `fromConfig`) |
| Projects (shared / local) | `projects.yaml` / `projects.local.yaml` |
| Run artefacts | `~/.ordin/runs/<run-id>/` (outside repo) |
| Eval fixtures + runner | `evals/` (pack-local; Phase 4) |
| LiteLLM proxy config | `litellm/config.yaml` (eval-only; swap `model_list` to change provider/backend) |
| Optional infra (LiteLLM, future Langfuse) | `infra/docker-compose.yml` |

No global install step — `~/.claude/` is never modified. Skills load per-run when `ClaudeCliRuntime` passes `--plugin-dir <ordin-repo>` to `claude -p`.

## Commands

```
bun run ordin <cmd>  # run the CLI (Bun runs TS directly)
bun run typecheck    # tsc --noEmit
bun run test         # vitest
bun run lint         # biome check
bun run format       # biome format --write
bun run deps:check   # dependency-cruiser (architectural rules)
```

`mise run <task>` (e.g. `mise run check`) wraps these with the right tool versions; prefer it for day-to-day use.

## Terminology — don't conflate

Three layers below the orchestrator. Keep them distinct in code and conversation:

- **Runtime** (`AgentRuntime`) — executes one phase. `ClaudeCliRuntime` wraps `claude -p`; `AiSdkRuntime` drives Vercel AI SDK. Swap = new adapter class.
- **Provider** — HTTP endpoint speaking an API shape (OpenAI-compatible, Anthropic-native). Examples: LiteLLM proxy, OpenAI, Ollama's native endpoint. Swap = change one URL.
- **Backend / Model** — what does inference. `claude-sonnet-4-6`, `qwen3:8b`. Opaque strings to the harness.

LiteLLM is a provider, not a runtime. Name runtime modules after the API shape or SDK they speak (SdkRuntime, AiSdkRuntime, ClaudeCliRuntime) — never after a specific provider.

## What **not** to add without a trigger

The plan commits to deferring infrastructure until concrete triggers fire. Avoid adding these proactively:

- Langfuse SDK as a direct dependency — tracing is wired via OpenTelemetry SDK (`src/observability/tracing.ts`) + AI SDK `experimental_telemetry`, with OTLP/HTTP pointed at self-hosted Langfuse. Vendor-neutral; switching backends is one URL.
- LiteLLM *for production routing* — Phase 8 trigger. (Eval-only LiteLLM is already present per Phase 4 — don't touch it from production paths.)
- ACP server — Phase 9 trigger (Zed/Neovim daily-driver).
- LangGraph engine implementation — Phase 11 trigger. The `Engine` seam exists; adding `LangGraphEngine` is a new file alongside `MastraEngine`. Don't build until concrete need (XL-tier parallel phases, mid-process resume).
- Additional agent runtimes (Claude Agent SDK, etc.) — Phase 10 trigger; blocked on moving off Max plan billing.
- Per-phase MCP ingestion / Confluence pulls / pinned external sources — Phase 14 trigger. (Mastra workflow steps natively support MCP servers; ordin doesn't wire them yet.)

If in doubt, re-read the trigger for that phase in [`docs/harness-plan.md`](./docs/harness-plan.md) and confirm it has actually fired.
