# CLAUDE.md

Conventions for agents (and humans) working **on** the ordin repo itself. ordin is a harness implementation — see [`docs/harness-plan.md`](./docs/harness-plan.md) for the end-to-end design.

## Stack

- **Runtime:** Node.js >=22 (LTS), ES modules throughout.
- **Language:** TypeScript 6, strict mode, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`.
- **Runner:** `tsx` — no build step. `pnpm ordin <cmd>` runs the CLI directly from `src/`.
- **Package manager:** pnpm (pinned in `package.json` > `packageManager`).
- **Linter / formatter:** Biome v2 — 2-space indent, double quotes, 100 col. Run `pnpm lint`/`pnpm format`.
- **Tests:** Vitest v4.
- **Deps:** commander (CLI), @clack/prompts (CLI gate prompter), yaml (config), gray-matter (frontmatter), zod (schemas), @mastra/core (workflow engine), ai + @ai-sdk/openai-compatible (AiSdkRuntime — eval only), openai (transitive), autoevals (LLM-as-judge scoring for evals).

## Architecture — the four load-bearing separations

```
cli/           client interface — only uses HarnessRuntime
                gate-prompters/  CLI-side prompters (clack); CLI assembles its own gate resolver
runtime/       HarnessRuntime implementation
orchestrator/  Engine interface + PhaseRunner + RunStore
                mastra/   MastraEngine — compiles Workflow → Mastra workflow
gates/         Gate / GatePrompter interfaces + HumanGate / FileGate / AutoGate (pure business logic)
runtimes/      AgentRuntime interface + ClaudeCliRuntime + ai-sdk/
domain/        pure types + loaders + composer (no orchestrator, no runtime)
```

**Dependency rule:** `orchestrator` imports from `domain` and `runtimes`. `domain` and `runtimes` depend on neither each other nor the orchestrator. `cli` only goes through `HarnessRuntime`. Targeted exception: `cli/gate-prompters/` legitimately imports from `gates/` and `domain/workflow.ts` to assemble the CLI's gate resolver. Enforced via `pnpm deps:check` (dependency-cruiser) — run locally before commits; no CI enforcement yet.

**Engine seam.** `Engine` (in `src/orchestrator/engine.ts`) is the swap interface. `MastraEngine` is today's only implementation, backed by `@mastra/core/workflows`. A future `LangGraphEngine` or any other implementation lives behind the same interface — domain, runtimes, gates, composer, CLI, and YAML content stay unchanged.

## Style

- Classes for loaders, adapters, and services (WorkflowLoader, HumanGate, ClaudeCliRuntime, MastraEngine, etc.).
- Plain `readonly` interfaces for data that flows between layers.
- Named exports only — no default exports.
- No `.ts` or `.js` extensions on relative imports (Bundler resolution handles it).
- Zod schemas are the source of truth at I/O boundaries; `z.infer<typeof Schema>` for types.

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
pnpm ordin <cmd>     # run the CLI (tsx entrypoint)
pnpm typecheck       # tsc --noEmit
pnpm test            # vitest
pnpm lint            # biome check
pnpm format          # biome format --write
pnpm deps:check      # dependency-cruiser (architectural rules)
```

## Terminology — don't conflate

Three layers below the orchestrator. Keep them distinct in code and conversation:

- **Runtime** (`AgentRuntime`) — executes one phase. `ClaudeCliRuntime` wraps `claude -p`; `AiSdkRuntime` drives Vercel AI SDK. Swap = new adapter class.
- **Provider** — HTTP endpoint speaking an API shape (OpenAI-compatible, Anthropic-native). Examples: LiteLLM proxy, OpenAI, Ollama's native endpoint. Swap = change one URL.
- **Backend / Model** — what does inference. `claude-sonnet-4-6`, `qwen3:8b`. Opaque strings to the harness.

LiteLLM is a provider, not a runtime. Name runtime modules after the API shape or SDK they speak (SdkRuntime, AiSdkRuntime, ClaudeCliRuntime) — never after a specific provider.

## What **not** to add without a trigger

The plan commits to deferring infrastructure until concrete triggers fire. Avoid adding these proactively:

- Langfuse / OpenTelemetry / custom tracing — wait until the Phase 7 trigger. (Mastra's built-in observability hooks are available behind the engine but not wired.)
- LiteLLM *for production routing* — Phase 8 trigger. (Eval-only LiteLLM is already present per Phase 4 — don't touch it from production paths.)
- HTTP server — Phase 2 trigger.
- ACP server — Phase 9 trigger.
- LangGraph engine implementation — Phase 11 trigger. The `Engine` seam exists; adding `LangGraphEngine` is a new file alongside `MastraEngine`. Don't build until concrete need (XL-tier parallel phases, mid-process resume).
- Additional agent runtimes (Claude Agent SDK, etc.) — Phase 10 trigger; blocked on moving off Max plan billing.
- Per-phase MCP ingestion / Confluence pulls / pinned external sources — Phase 14 trigger. (Mastra workflow steps natively support MCP servers; ordin doesn't wire them yet.)

If in doubt, re-read the trigger for that phase in [`docs/harness-plan.md`](./docs/harness-plan.md) and confirm it has actually fired.
