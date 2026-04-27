# ordin

![ordin](./hero.png)

*Run workflows with structure, order, and control across AI runtimes.*

A personal-first, team-extensible harness for AI-assisted software delivery. Plan → Build → Review, each phase in a fresh context with gates at every handoff.

**What it gives you:**
- Phased workflow runs with human gates at each handoff, configurable per phase.
- Multiple agent runtimes — `ClaudeCliRuntime` (wraps `claude -p`) and `AiSdkRuntime` (Vercel AI SDK over any OpenAI-compatible provider).
- File-based artefact handoff between phases (RFCs, build notes, reviews) — git is the audit log.
- Three client surfaces over the same engine: CLI, HTTP (with bearer auth + Scalar docs), and MCP (stdio, for Claude Code / Cursor / OpenCode / Claude Desktop).
- Skills + agents authored as plain markdown with frontmatter.
- Local eval suite (Vitest + LiteLLM + Ollama) for regression-gating prompt changes.

Design document: [`docs/harness-plan.md`](./docs/harness-plan.md). This README covers how to run the current implementation.

## Requirements

- **Bun ≥1.3** on PATH in every shell you plan to run `ordin` from. If you use mise, the repo-level `.mise.toml` pins it for you (`mise install`); for shells outside this repo, install Bun directly or pin it in your *user-level* `~/.config/mise/config.toml`.
- **Claude Code CLI** on PATH (`claude`) — Stage 1 invokes it as a subprocess.

## One-time install

```bash
git clone <repo-url> ~/src/ordin
cd ~/src/ordin
mise install              # picks up .mise.toml — installs pinned Bun
bun install
bun link                  # puts `ordin` on PATH
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

Expect: ✓ runtime check, ✓ claude binary, ✓ ordin files, ✓ plugin manifest.

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

## Drive ordin from outside the CLI

Three transports sit on the same `RunService` seam — pick whichever fits the consumer.

### HTTP server (`ordin serve`)

Hono + OpenAPI server with SSE for live event streaming:

```bash
ordin serve --port 8787              # 127.0.0.1:8787, no auth (loopback only)
ORDIN_API_TOKEN=secret ordin serve   # bearer-auth on; non-loopback hosts allowed
```

Routes: `POST /runs`, `GET /runs/:id`, `GET /runs/:id/events` (SSE), `GET /runs/:id/gates`, `POST /runs/:id/gates/:phaseId/decide`, `POST /preview`. Spec at `/openapi.json`. Interactive Scalar docs at `/docs` — paste your token in Scalar's auth panel for try-it-out.

### Remote CLI (`ordin remote`)

Talks to a running `ordin serve` over HTTP — same task surface as the in-process CLI, JSON-lines output for piping:

```bash
ORDIN_SERVER_URL=http://127.0.0.1:8787 ORDIN_API_TOKEN=secret \
  ordin remote start "fix login bug" --repo /abs/path/to/repo

ordin remote events  <runId> | jq .             # SSE → JSON-lines
ordin remote gates   <runId>                    # pending gates
ordin remote decide  <runId> plan approve
ordin remote list                               # recent runs
```

### MCP server (`ordin mcp`)

Stdio JSON-RPC server for editors and agent hosts (Claude Code, Cursor, OpenCode Desktop, Claude Desktop, Continue, Cline). Tools: `startRun`, `previewRun`, `listRuns`, `getRun`, `getEvents`, `pendingGates`, `resolveGate`.

Test it locally with the official inspector:

```bash
npx @modelcontextprotocol/inspector ordin mcp
```

Wire it into a host (OpenCode example, `~/.config/opencode/opencode.json`):

```jsonc
{
  "mcp": {
    "ordin": {
      "type": "local",
      "command": ["/absolute/path/to/ordin/bin/ordin", "mcp"]
    }
  }
}
```

Claude Desktop / Cursor / Claude Code follow the same shape with their own config files.

## Dev loop (testing ordin itself)

A committed fixture target repo lets you smoke-test phases without aiming at real work and without needing `bun link`:

```bash
bun run fixture:setup      # stages .scratch/target-repo/ and git-inits it
bun run ordin plan "Add input validation to the calculator" --project fixture --tier S
bun run ordin run  "Implement divide with zero-guard"        --project fixture --tier S
```

The `fixture` project is registered in `projects.yaml` and points at `.scratch/target-repo/` (gitignored). Re-run `bun run fixture:setup` any time to reset the fixture to a clean state.

## Eval loop (regression-gating prompt changes)

Evals gate changes to the pack's prompts, skills, agents, and workflow. They run the real orchestrator against fixture tasks with `AiSdkRuntime` pointed at a LiteLLM proxy — not your Max plan — so iteration is cheap and provider-swappable. See [`evals/README.md`](./evals/README.md) for details.

**One-time setup.** Install [Docker](https://docs.docker.com/desktop/) and [Ollama](https://ollama.com/). Pull a model with native OpenAI-format tool-use (qwen3 family works; qwen2.5-coder does not):

```bash
ollama pull qwen3:8b          # agent model — needs real tool_calls, not JSON-in-text
ollama pull qwen3:4b          # cheap judge for LLM-as-judge rubrics
cp .env.local.example .env.local   # holds LITELLM_MASTER_KEY; mise auto-loads
```

**Each session:**

```bash
mise run litellm-up           # docker compose up -d litellm (port 4000)
bun run eval                  # run the full eval suite (mise run eval works too)
mise run litellm-down         # stop proxy when done
```

**Swap backends without editing code.** `litellm/config.yaml` declares backend aliases (`qwen3-8b`, `qwen3-14b`, `qwen3-32b`, `qwen3-coder-30b`). Pick one at run time:

```bash
ORDIN_EVAL_MODEL=qwen3-14b bun run eval
ORDIN_EVAL_MODEL=qwen3-coder-30b bun run eval
```

For cloud providers (Anthropic, OpenAI, OpenRouter, Bedrock) see commented templates in `litellm/config.yaml`.

Production `ordin run` never touches LiteLLM or Docker. These are eval-only.

## Directory layout + architecture

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the four layer separations and a live module graph.
- [`CLAUDE.md`](./CLAUDE.md) — conventions for agents and contributors working on ordin.
- [`docs/harness-plan.md`](./docs/harness-plan.md) — full design, success criteria, and deferred-phase triggers (Appendix A has the file layout).

## Status

**Phase 1 complete.** `ClaudeCliRuntime` drives runs against Max plan via `claude -p`. CLI wrapper hardened with `--setting-sources project`, `--exclude-dynamic-system-prompt-sections`, `--include-hook-events`, and per-phase `--fallback-model` / `--max-turns`.

**Phase 2 complete (HTTP).** Hono + `@hono/zod-openapi` server over a new `RunService` seam (background runs, async-iterable subscribe, deferred-promise gate prompter). SSE events. Bearer auth via `ORDIN_API_TOKEN`; loopback-only when unset. Scalar UI at `/docs`.

**Phase 2b complete (MCP).** Stdio JSON-RPC server over the same `RunService`. Seven tools cover the run lifecycle including a polling `getEvents` cursor. Validated against OpenCode Desktop end-to-end.

**Phase 4 (local eval suite) complete.** `AiSdkRuntime` (Vercel AI SDK) + Dockerised LiteLLM proxy + Vitest-shaped `.eval.ts` fixtures with autoevals LLM-as-judge rubrics. First fixture (plan: add input validation) passes 5/5 locally via qwen3:8b.

**Orchestrator refactor (post-Phase 4) complete.** `Engine` interface + `MastraEngine` (backed by `@mastra/core/workflows`) replace the custom sequential state machine. Gates are pure business logic; the CLI's OpenTUI prompter lives in `src/cli/gate-prompters/` (Solid component in `src/cli/tui/`). Runtime-specific config out of the domain. Per-phase artefact `inputs` / `outputs` declared in `workflows/<name>.yaml` with `{slug}` placeholders. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

Langfuse observability, multi-project mode, `LangGraphEngine`, mid-process resume, ACP server, and per-phase ingestion are conditional phases gated on their plan-declared triggers.
