# CLAUDE.md

Conventions for agents (and humans) working **on** the ordin repo itself. ordin is a harness implementation — see [`docs/harness-plan.md`](./docs/harness-plan.md) for the end-to-end design.

## Stack

- **Runtime:** Node.js >=22 (LTS), ES modules throughout.
- **Language:** TypeScript 6, strict mode, `verbatimModuleSyntax`, `noUncheckedIndexedAccess`.
- **Runner:** `tsx` — no build step. `pnpm ordin <cmd>` runs the CLI directly from `src/`.
- **Package manager:** pnpm (pinned in `package.json` > `packageManager`).
- **Linter / formatter:** Biome v2 — 2-space indent, double quotes, 100 col. Run `pnpm lint`/`pnpm format`.
- **Tests:** Vitest v4.
- **Deps:** commander (CLI), @clack/prompts (gates), yaml (config), gray-matter (frontmatter), zod (schemas), ai + @ai-sdk/openai-compatible (AiSdkRuntime — eval only), openai (transitive), autoevals (LLM-as-judge scoring for evals).

## Architecture — the four load-bearing separations

```
cli/           client interface — only uses HarnessRuntime
runtime/       HarnessRuntime implementation
orchestrator/  sequential state machine + run-store
gates/         Gate interface + Clack/File/Auto
runtimes/      AgentRuntime interface + ClaudeCliRuntime (prod) + ai-sdk/ (eval)
domain/        pure types + loaders + composer (no orchestrator, no runtime)
```

**Dependency rule:** `orchestrator` imports from `domain` and `runtimes`. `domain` and `runtimes` depend on neither each other nor the orchestrator. `cli` only goes through `HarnessRuntime`. Enforced via `pnpm deps:check` (dependency-cruiser) — run locally before commits; no CI enforcement yet.

## Style

- Classes for loaders, adapters, and services (WorkflowLoader, ClackGate, ClaudeCliRuntime, etc.).
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
| Per-phase defaults | `ordin.config.yaml` |
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
- **Backend / Model** — what does inference. `claude-sonnet-4-6`, `qwen2.5-coder:7b`. Opaque strings to the harness.

LiteLLM is a provider, not a runtime. Name runtime modules after the API shape or SDK they speak (SdkRuntime, AiSdkRuntime, ClaudeCliRuntime) — never after a specific provider.

## What **not** to add without a trigger

The plan commits to deferring infrastructure until concrete triggers fire. Avoid adding these proactively:

- Langfuse / OpenTelemetry / custom tracing — wait until the Phase 7 trigger.
- LiteLLM *for production routing* — Phase 8 trigger. (Eval-only LiteLLM is already present per Phase 4 — don't touch it from production paths.)
- HTTP server — Phase 2 trigger.
- ACP server — Phase 9 trigger.
- LangGraph or similar orchestrator — Phase 11 trigger.
- Additional runtimes (Claude Agent SDK, Mastra) — Phase 10 trigger.
- Per-phase MCP ingestion / Confluence pulls / pinned external sources — Phase 14 trigger.

If in doubt, re-read the trigger for that phase in [`docs/harness-plan.md`](./docs/harness-plan.md) and confirm it has actually fired.
