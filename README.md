# ordin

![ordin](./hero.png)

*Run workflows with structure, order, and control across AI runtimes.*

A personal-first, team-extensible harness for AI-assisted software delivery. Plan → Build → Review, each phase in a fresh context with gates at every handoff.

Design document: [`docs/harness-plan.md`](./docs/harness-plan.md). This README covers how to run the Stage 1 implementation.

## Requirements

- **Node.js ≥22** on PATH in every shell you plan to run `ordin` from. If you use mise, pin Node in your *user-level* `~/.config/mise/config.toml` — the repo-level `.mise.toml` only activates inside this repo.
- **pnpm** (for installing deps).
- **Claude Code CLI** on PATH (`claude`) — Stage 1 invokes it as a subprocess.

## One-time install

```bash
git clone <repo-url> ~/src/ordin
cd ~/src/ordin
pnpm install
pnpm link --global .      # puts `ordin` on PATH
```

Register target repos (per-engineer overlay, gitignored):

```bash
cat >> projects.local.yaml <<'EOF'
projects:
  my-repo:
    path: ~/code/my-repo
EOF
```

Verify from any directory:

```bash
cd /tmp && ordin doctor
```

Expect: ✓ Node ≥22, ✓ claude binary, ✓ ordin files, ✓ plugin manifest.

**No `~/.claude/` modifications are needed.** Skills load per-invocation via `--plugin-dir`, not via global symlinks.

## Use

Full pipeline on a real task:

```bash
ordin run "Add email search to the user directory" --project my-repo --tier M
```

Single phase:

```bash
ordin plan  "Add email search to the user directory"         --project my-repo
ordin build add-email-search-to-the-user-directory           --project my-repo
ordin review add-email-search-to-the-user-directory          --project my-repo
```

Ad-hoc against any repo path (no registration required):

```bash
ordin run "Fix the thing" --repo /tmp/some-repo --tier S
```

## What happens during a run

1. **Plan** — spawns `claude -p` in the target repo with the `planner` agent, producing an RFC at `docs/rfcs/<slug>-rfc.md`. Review and approve at the interactive gate (`$EDITOR` opens the RFC on request).
2. **Build** — fresh subprocess with the `build-local` agent reads the approved RFC and produces code changes, tests, commits, and `build-notes.md`.
3. **Review** — another fresh subprocess runs the `reviewer` agent in read-only mode against the diff, producing a review at `reviews/<slug>-review.md`.
4. If Review rejects with findings, Build re-runs with the rejection reason as prior-iteration context (bounded by `max_iterations` in the workflow YAML).

Each invocation passes `--plugin-dir <ordin-repo>` so `.claude-plugin/plugin.json` is picked up and skills discover from `skills/`. No installation into `~/.claude/` ever.

Transcripts and metadata land in `~/.ordin/runs/<run-id>/`.

## Inspect

```bash
ordin runs                 # list recent runs
ordin retro <run-id>       # per-phase tokens, duration, gate decisions
ordin status               # latest run at a glance
ordin doctor               # environment health
```

## Dev loop (testing ordin itself)

A committed fixture target repo lets you smoke-test phases without aiming at real work and without needing `pnpm link --global`:

```bash
pnpm fixture:setup         # stages .scratch/target-repo/ and git-inits it
pnpm ordin plan "Add input validation to the calculator" --project fixture --tier S
pnpm ordin run  "Implement divide with zero-guard"        --project fixture --tier S
```

The `fixture` project is registered in `projects.yaml` and points at `.scratch/target-repo/` (gitignored). Re-run `pnpm fixture:setup` any time to reset the fixture to a clean state.

## Eval loop (regression-gating prompt changes)

Evals gate changes to the pack's prompts, skills, and config. They run the real orchestrator against fixture tasks with `AiSdkRuntime` pointed at a LiteLLM proxy — not your Max plan — so iteration is cheap and provider-swappable.

**One-time:** install [Docker](https://docs.docker.com/desktop/) and [Ollama](https://ollama.com/) (or any local LLM). Pull a tool-use capable model:

```bash
ollama pull qwen2.5-coder:7b
ollama pull qwen2.5:3b        # judge model for LLM-as-judge rubrics
```

**Each session:**

```bash
mise run litellm-up           # docker compose up -d litellm (port 4000)
mise run eval                 # run the eval suite
mise run litellm-down         # stop proxy when done
```

**Swap backends** by editing `litellm/config.yaml` — `model_list` has Ollama as default plus commented entries for Anthropic / OpenAI / OpenRouter / Bedrock. No code change needed.

Production `ordin run` never touches LiteLLM or Docker. These are eval-only.

## Directory layout + architecture

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the four layer separations and a live module graph.
- [`CLAUDE.md`](./CLAUDE.md) — conventions for agents and contributors working on ordin.
- [`docs/harness-plan.md`](./docs/harness-plan.md) — full design, success criteria, and deferred-phase triggers (Appendix A has the file layout).

## Status

**Phase 1 complete.** `ClaudeCliRuntime` drives production runs against Max plan.

**Phase 4 (local eval suite) in progress.** `AiSdkRuntime` (Vercel AI SDK) and LiteLLM proxy landed; eval runner and fixtures are next. HTTP adapter, Langfuse observability, multi-project mode, LangGraph swap, and per-phase ingestion are conditional phases gated on their plan-declared triggers.
