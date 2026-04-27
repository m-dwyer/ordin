# Agentic Harness — Plan

> **Implementation status (2026-04-27):** Phase 1 complete; Phase 4 (local eval suite) complete. Orchestrator refactored: an `Engine` seam now sits between `HarnessRuntime` and the workflow runtime, with `MastraEngine` (backed by `@mastra/core/workflows`) as today's only implementation. Phase 11's "LangGraph swap" is now a small new-file change behind that seam. Gate layer is pure business logic; the CLI's OpenTUI + Solid prompter lives in `src/cli/gate-prompters/` and `src/cli/tui/`, with a non-TTY plain-stdout fallback for piped runs. Runtime-specific config (claude-cli bin, fallback model, max turns) is owned by each runtime's own schema, not the domain. Per-phase artefact `inputs` / `outputs` are declared in `workflows/<name>.yaml` with `{slug}` placeholders. For the current codebase, see [`../README.md`](../README.md), [`./ARCHITECTURE.md`](./ARCHITECTURE.md), and [`../CLAUDE.md`](../CLAUDE.md).

A personal-first, team-extensible harness for AI-assisted software delivery with Plan → Build → Review phases, context isolation, approval gates, and instrumentation.

The harness is a **pipeline coordinator, not an agent framework**. Each phase delegates agent execution to a pluggable runtime (`ClaudeCliRuntime` subprocess wrap on Max plan for Stage 1; future SDK runtimes for in-process agents when moving off Max plan or needing mid-loop intervention). Artefacts on disk are the contract between phases. The harness owns composition, orchestration, gates, and observability — not the tool loop inside a phase.

Designed to start minimal on Claude Code + Max plan and scale through three stages: solo → per-engineer → shared services. Infrastructure is deferred until concrete triggers fire.

---

## Part 1 — Success criteria

Worth building if, after 3 months of use, the following are true:

**Personal productivity — S/M-tier (statistical)**

S/M-tier work is every PR-shipping task; volume is ~dozens/month, enough for metrics to mean something.
- `tokens_per_successful_run` trending flat or down.
- Build iteration count median ≤ 2 rounds.
- Gate rejection rate < 40%.

**Personal productivity — L-tier (narrative)**

L-tier work is ~1–3 RFC-worthy pieces over 3 months; cadence is too low for statistical framing, so criteria are narrative.
- The harness handled the L-tier work that arose; resulting RFCs were usable without rewrites.
- Time-to-approved-RFC felt meaningfully faster than hand-running the manual pipeline.
- Build output from L-tier runs merged with no more than 2 review rounds.

**Team adoption (Stage 2)**
- At least 2 other engineers use the harness weekly, unprompted.
- A teammate has contributed at least one improvement back to the repo.
- Onboarding from clone to first successful run is under 15 minutes.

**Workflow integration**
- Build-phase artefacts slot into the team's existing PR review process without reformatting.
- Plan-phase RFCs are accepted into planning process without rewrites.

**Anti-criteria (failure signals)**
- The harness is the only thing you ship — more time tuning than using.
- Teammates tried it and went back to vanilla Claude Code.
- The team still rebuilds Build-phase output from scratch.

**Measurement.** `BASELINE.md` committed before Week 1 captures current manual-pipeline cost (token spend + cycle time) for the artefacts you do produce today. S/M-tier metrics baseline over the first 2 weeks of real use. Without a baseline, success criteria are retroactive vibes.

---

## Part 2 — Architecture

### Design principles

1. **Phases are context boundaries.** Each phase runs in fresh context. Only durable artefacts on disk cross boundaries.
2. **Artefacts are the interface.** Every phase consumes and produces markdown files. Agents are implementation details.
3. **The harness is a prompt composer.** It assembles context, manages pipeline state, and delegates agent execution to a runtime adapter. It does not run agent tool loops itself.
4. **Four load-bearing separations.** Domain / Runtimes / Orchestrator / Client interfaces. Each is independently swappable because dependencies flow one direction.
5. **Implicit I/O via agent prompts.** Agents declare their reads and writes in their own prompt. YAML just orders phases. No redundant schema.
6. **Filesystem + git as the ledger.** No custom state tracking. Git history is the audit log. File timestamps mark phase transitions.
7. **Gates are default-on, configurable-off.** Human review at every handoff until a phase is trusted enough to auto-approve.
8. **Provider and CLI agnostic.** Runtime adapters abstract which agent CLI or SDK executes a phase. File-based handoff means a future SDK runtime or alternate CLI wrap is an isolated adapter swap.
9. **Defer infrastructure until triggered.** Langfuse, LiteLLM, LangGraph, Temporal, ACP — all additive. Build when concrete need is evident, not speculation.

### The four load-bearing separations

This is the architectural commitment that makes everything else cheap to evolve:

```
┌──────────────────────────────────────────────────────────┐
│  Client interfaces (CLI; future: HTTP, ACP, IDE plugin)  │
│  — call HarnessRuntime                                   │
├──────────────────────────────────────────────────────────┤
│  Orchestrator (Engine seam; MastraEngine; PhaseRunner)   │
│  — uses Domain and Runtimes                              │
├──────────────────────────────────────────────────────────┤
│  Domain (workflow, agent, skill, composer, artefact)     │
│  — pure TypeScript; no orchestrator, no runtime          │
├──────────────────────────────────────────────────────────┤
│  Runtimes (ClaudeCliRuntime; SdkRuntime when Phase 10)   │
│  — implement AgentRuntime; no orchestrator               │
└──────────────────────────────────────────────────────────┘
```

**Dependency rule:** orchestrator imports from domain and runtimes. Domain and runtimes import from neither each other nor orchestrator. Client interfaces only use `HarnessRuntime` — never reach around it to the filesystem or other internals.

In Stage 1 the separation is *convention* — directory structure + `AgentRuntime` / `HarnessRuntime` / `Gate` interfaces as architectural signposts for future-you and future-teammates. A `dependency-cruiser.config.cjs` exists and can be invoked via `pnpm deps:check` locally, but there's no CI enforcement yet (no CI). Add enforcement in Stage 2 when teammates adopt and the layers start getting violated.

This is what makes later swaps localised:
- Replacing the engine (e.g. LangGraph) → new `Engine` impl alongside `MastraEngine`; domain / runtimes / gates / CLI / YAML untouched
- Adding a new client interface → new adapter, zero changes elsewhere
- Adding a new agent runtime (Claude Agent SDK, OpenCode wrap, Mastra Agent) → new adapter implementing `AgentRuntime`, zero changes elsewhere
- Adding a new gate prompter (web, Slack, GitHub-checks) → new `GatePrompter` impl in the client layer; gate business logic stays the same
- Adding Langfuse observability → sidecar decorator wrapping existing runtime calls, or wire Mastra's tracing inside `MastraEngine`

### The harness as prompt composer

The harness does not run agent loops. It composes prompts and delegates execution:

1. Reads the workflow YAML to know phase order and per-phase config.
2. Loads the phase's agent markdown (system prompt + task template).
3. Composes the prompt: phase instructions + task description + skill pointers + context pointers.
4. Invokes the runtime adapter (`ClaudeCliRuntime` in Stage 1; `SdkRuntime` later) with the composed prompt.
5. Runtime executes (subprocess runs `claude -p`; future SDK call goes through the same interface).
6. Harness reads the produced artefact from the expected path.
7. Runs the gate (human approval via the OpenTUI footer prompt, auto-approval, file marker, etc.).
8. Transitions to next phase (fresh context, repeat).

This separation is critical:

- Agents (Claude Code, OpenCode, etc.) are better at agent work than any harness reinvention.
- The harness's value is pipeline discipline, artefact contracts, and integration with team workflow — not reimplementing tool loops.
- Keeping the harness a thin composer makes it portable across agent CLIs.

### The four phases

Each phase runs in fresh context with only declared artefact inputs. The phase's agent prompt tells the agent what to read (via Read tool) and write (to specific paths).

**Phase 0 — Explore (optional, pre-Plan)**
- Purpose: rubber-duck ambiguous initiatives before committing to Plan.
- Inputs: problem statement, strategy docs, ADRs, links to stakeholder conversations.
- Output: `explore/<slug>.md` — problem decomposition, framings, recommended framing.
- Gate: human confirms framing.
- Skip when: problem is well-scoped (most M-tier work).

**Phase 1 — Plan**
- Purpose: turn a well-formed problem into a reviewable RFC.
- Inputs: problem statement, optional explore framing, relevant ADRs, target `CLAUDE.md`.
- Output: `docs/rfcs/<slug>-rfc.md` — Summary (handover), Problem, Options, Recommendation, Work breakdown with acceptance criteria, Risks.
- Gate: human approves.
- Read-only tools; no shell, no writes outside the artefact path.

**Phase 2 — Build**
- Purpose: turn approved RFC into a PR-ready branch.
- Inputs: approved RFC, engineering-principles skill, target `CLAUDE.md`, any Review findings from a prior iteration.
- Output: code changes, tests, conventional commits, `docs/rfcs/<slug>-build-notes.md`.
- Gate: pre-commit hook (tests + lint) + human review of diff.
- Full shell, edit, test tools.

**Phase 3 — Review**
- Purpose: independent evaluation against the RFC. Catches "works but isn't what we asked for."
- Inputs: approved RFC, build notes, git diff. **Fresh context window (`fresh_context: true`).**
- Output: `reviews/<slug>-review.md` — recommendation (ship / iterate / re-plan), must-fix, should-fix, nits, RFC coverage.
- Gate: human decides iteration target.
- Read-only; explicitly adversarial prompt.

### Iteration model

Three iteration paths, all explicit:

- **Within-phase** — agent retries in same context until local success criterion (tests pass, RFC sections complete).
- **Back-one-phase** — Review findings feed into fresh Build run with RFC + findings artefact. Build re-discovers branch state via `git diff`. Default iteration.
- **Back-to-Plan** — Review concludes the RFC itself is flawed. Rare but tracked; promotes review artefact into Plan's input.

No implicit iteration. All loops are state transitions with their own artefacts. Iteration counter per phase; ceiling triggers halt and human surface.

### Artefact handover

**Principle: files on disk + fresh subprocess between them.**

Phase N completes → writes artefact to declared path → gate check → (human approves or iteration triggers) → Phase N+1 composer reads artefact → spawns fresh `claude -p` subprocess (or future SDK invocation) → agent works with only composed prompt + target repo CWD + tools.

Key design decisions:

- **Artefacts live in the target repo** at conventional paths (`docs/rfcs/`, `reviews/`). Committed to git as part of the work. RFC appears in the PR diff alongside the code it describes.
- **Run metadata** (transcripts, token counts, phase timings) lives in `~/.harness/runs/<run-id>/`. Not deliverable; harness internal.
- **No explicit I/O in workflow YAML.** The agent's prompt declares what to read and write. YAML only orders phases and declares orchestration concerns (gate, runtime, fresh_context).
- **No custom state tracking.** `git log` shows phase history; `git diff` between agent output and human edits is the artefact-diff signal; file timestamps are the ledger.

### The composer — tiered context

Three tiers of context loading:

1. **Always inline (2–5k tokens):** phase instructions, agent system prompt, task description, skill pointers.
2. **Selectively inline (3–10k tokens):** skills explicitly declared in the phase's prompt as required.
3. **Lazy-load via tools (0 tokens upfront):** target repo files (via Read), external context (via MCP), optional standards (fetched on request).

For `ClaudeCliRuntime`, skills install at `~/.claude/skills/harness/<name>/` (symlinked from `~/.harness/skills/`) so Claude Code's native progressive disclosure discovers them — only SKILL.md descriptions enter the initial prompt; bodies load on demand when the agent decides they're relevant.

For runtimes without native skill discovery (SDK, raw API), the composer inlines selected skill bodies. Capability negotiation handles the difference.

Token budgets per phase (soft warn, hard ceiling = 3× soft). Composer emits warnings when a context manifest would exceed soft budget.

### Agent runtimes

Runtimes implement the `AgentRuntime` interface:

```ts
interface AgentRuntime {
  readonly name: string;
  readonly capabilities: RuntimeCapabilities;
  invoke(req: InvokeRequest): Promise<InvokeResult>;
}
```

Stage 1 has one runtime: `ClaudeCliRuntime`. Additional runtimes (SDK, Mastra, etc.) are new adapters implementing the same interface when triggers fire; no orchestrator changes.

| Runtime | Use case | Status |
|---|---|---|
| `ClaudeCliRuntime` | Subprocess-spawns `claude -p` on Max plan. Sole Stage 1 runtime. | Stage 1 |
| `SdkRuntime` | Direct API via Anthropic SDK / Mastra / Claude Agent SDK. When moving off Max plan or when streaming + mid-loop intervention becomes needed. | Deferred to Phase 10 |

#### `ClaudeCliRuntime` invocation spec

Per-phase invocation of `claude -p`:

- **System prompt.** Agent markdown body passed via `--append-system-prompt`.
- **User prompt.** Task description + pointers to artefact inputs composed by the harness.
- **Model.** Per-phase from `harness.config.yaml` (Plan/Review default Opus; Build default Sonnet). Agent-markdown frontmatter can override.
- **Output.** `--output-format stream-json` from day 1. Events captured to `~/.harness/runs/<id>/transcript.jsonl` and re-emitted to the user's terminal for live progress.
- **Skills.** Native Claude Code discovery via install-time symlinks to `~/.claude/skills/harness/<name>/` (source of truth: `~/.harness/skills/`).
- **CWD.** Target repo path.
- **Token ceiling.** Soft budget logged in retro; hard ceiling deferred (revisit when a run blows past budget and surprises you).

**Tool allowlists per phase.** Passed to `claude -p` via `--allowed-tools`. Plan and Review are path-scoped writes with no shell surface; Build has unrestricted Bash scoped to that phase only.

| Phase | Allowed tools |
|---|---|
| Plan | `Read, Grep, Glob, Write(docs/rfcs/*)` |
| Review | `Read, Grep, Glob, Write(reviews/*), Bash(git diff*), Bash(git log*), Bash(git show*)` |
| Build | `Read, Write, Edit, Grep, Glob, Bash` |

Build's unrestricted Bash is honest broad scope: the real safety surface is Review + the human gate + `git diff` on the working tree, not a cargo-cult enumeration of "safe" Bash patterns (since Build already has `Write`/`Edit` on arbitrary paths, narrow Bash buys nothing).

**Day-1 spike.** Verify `claude -p` subprocess behaviour when the agent attempts a tool call not on the allowlist: does it stall (blocking on absent stdin), gracefully deny and report to the agent, or exit non-zero? Behaviour determines whether per-phase watchdog timeouts are Phase-1-required or a later concern.

### Client interfaces

The `HarnessRuntime` interface is the stable client seam:

```ts
interface HarnessRuntime {
  createRun(input: CreateRunInput): Promise<Run>;
  getRun(id: string): Promise<Run>;
  listRuns(filter?: RunFilter): Promise<Run[]>;
  resumeRun(id: string): Promise<Run>;
  cancelRun(id: string): Promise<void>;

  startPhase(runId: string, phaseId: string): Promise<PhaseResult>;
  getPhase(runId: string, phaseId: string): Promise<PhaseState>;

  approveGate(runId: string, phaseId: string, note?: string): Promise<void>;
  rejectGate(runId: string, phaseId: string, reason: string): Promise<void>;

  getArtefact(runId: string, path: string): Promise<Artefact>;
  listArtefacts(runId: string): Promise<Artefact[]>;

  subscribe(runId: string): AsyncIterable<RunEvent>;
}
```

All client adapters translate their transport to this interface:

| Adapter | Stage 1 | Purpose |
|---|---|---|
| **CLI** | ✓ | Primary user interface; OpenTUI + Solid footer for live runs (gate prompts in-panel via keypress); `$EDITOR` for artefact review at gates. |
| **HTTP server** | active | Hono + `@hono/zod-openapi`; SSE for events. |
| **MCP server** | active (after HTTP) | In-process adapter over `HarnessRuntime`. Reaches Claude Code, Cursor, Claude Desktop, Continue, Cline. |
| **ACP server** | deferred | Native fit for phases/gates; trigger: Zed or Neovim user daily-driving. |
| **IDE plugins** | deferred | VS Code, JetBrains — thin extensions over the HTTP API once that lands. |
| **Slack / webhooks** | deferred | Async gate approval if gates become a collaboration bottleneck. |

CLI was sufficient for Stage 1. HTTP (Phase 2) lands first as the universal substrate; MCP (Phase 2b) follows on top of `HarnessRuntime` for the mixed-host audience. ACP deferred to Phase 9.

### Standards and skills

Skills are hand-authored markdown files with YAML frontmatter at `~/.harness/skills/<name>/SKILL.md`. Installed to `~/.claude/skills/harness/<name>/` via symlink at `harness install` time so Claude Code's native skill discovery picks them up automatically. Progressive disclosure works for free — only SKILL.md descriptions enter the initial prompt; bodies load on demand when the agent decides they're relevant.

**Ingestion (Stage 2+):** `harness standards sync` eventually pulls standards from Confluence / ADR repos / Notion via MCP, produces pinned-and-hashed skill files with a diff-review step. Source of truth remains filesystem; ingestion is an input pipeline, not a runtime pull. Reproducibility requires pinning. The generalised version of this idea is the ingestion layer (below).

### Workflow packs

ordin is a runtime — a stateless engine that loads content from one or more **workflow packs** and executes them. A pack is a portable directory:

```
<pack>/
├── .claude-plugin/plugin.json   # optional — makes the pack a Claude Code plugin too
├── ordin.config.yaml            # per-phase defaults (model, allowed_tools, tiers)
├── workflows/<name>.yaml        # phase ordering + orchestration concerns
├── agents/<name>.md             # agent prompts with frontmatter
├── skills/<name>/SKILL.md       # hand-authored skill bodies
├── ingestion/<phase>.yaml       # per-phase external context (Phase 14; placeholder today)
└── evals/                       # fixtures + assertions that gate pack changes
    ├── fixtures/
    └── README.md
```

The ordin repo itself is today's **default pack**, shipping the `software-delivery` workflow. Future packs (`acme-frontend-workflows`, `pm-discovery-pack`) are separate repos that ordin loads by path — same mechanism as the current `--plugin-dir` + `projects.yaml` pattern.

**Author / consumer asymmetry.** Authoring a good pack (prompt engineering + skill design + ingestion config + eval rubrics) is specialist work — realistically one or two engineers per team. Most teammates consume packs: fork, tweak ingestion to their Confluence/repo, occasionally add a fixture. Design the pack-contribution path for that ratio — easy to tailor, deliberate to author from scratch. Don't assume every role (PM, designer, SRE) will author packs at Stage 2; that's a Stage 3+ aspiration.

**Composition model.** Today: one pack, resolved by path. Stage 2 expected: one pack + per-engineer overlay (`projects.local.yaml` already models this pattern for project paths). Stage 3+ expected: company pack + team overlay + personal overlay. Multi-layer override is always messy (cf. Kustomize, Helm). Don't formalise until a real second layer lands.

**Relationship to `.claude-plugin/plugin.json`.** The ordin repo is already a Claude Code plugin — `--plugin-dir` loads its skills. A pack with a `plugin.json` is loadable as *both* a Claude Code plugin and an ordin pack; packs without one are ordin-only.

**Evals travel with the pack.** A pack's `evals/` gate changes to *that pack's* prompts, skills, and ingestion. When software-delivery eventually splits from the ordin repo, its fixtures split with it.

### Ingestion layer

The composer's tiered-context model describes *how* context reaches an agent. The ingestion layer describes *where that context comes from*.

Each workflow declares, per phase, what external context to ingest. Source types:

- **Pinned files in the pack** — skills, templates, ADRs committed as markdown (today's mechanism).
- **Pinned + hashed external pulls** — Confluence pages, Notion docs, GitHub files snapshotted offline via `ordin ingest`; content-hashed for reproducibility. Generalises Phase 12 standards sync per-phase, per-workflow.
- **Live MCP connections** — Confluence MCP, GitHub MCP, Linear MCP exposed to the agent at invocation so it can query current state.

**Pinned vs live tradeoff.** Pinned is reproducible (evals re-run against the same snapshot), but stale until re-synced. Live is fresh but nondeterministic (evals get noisier, reruns diverge, MCP uptime matters). Most workflows will want both — pinned for stable reference (coding standards, RFC templates, architecture invariants), live MCP for fluid context (current sprint, open PRs, this week's incidents).

**Declaration shape** (forward design — not yet implemented):

```yaml
# ingestion/explore.yaml
phase: explore
sources:
  - type: pinned
    path: ingestion/pinned/tech-strategy.md
    origin: { kind: confluence, space: ARCH, page_id: 12345 }
    synced_at: 2026-04-22T10:00:00Z
    content_hash: sha256:ab12…
  - type: live-mcp
    server: confluence-mcp
    capability: search
    scope: "space:ARCH"
```

**Eval reproducibility.** Fixtures pin ingestion by pack-commit-hash. Live-MCP sources are flagged as non-reproducible — eval authors opt in knowing reruns may diverge.

**Variation as a tuning knob.** Workflow authors tune ingestion alongside prompts and skills. Evals measure the effect: *"does pulling the ADR directory into Plan improve RFC quality?"*, *"does GitHub PR context in Build reduce iteration rounds?"*. Ingestion is a first-class eval dimension once the layer exists.

**Status.** Design only. See Phase 14 in Part 8 for build scope. Phase 4's eval fixtures reserve an `ingestion_override` field to stay forward-compatible.

### Project context

`projects.yaml` (shared) + `projects.local.yaml` (gitignored) register known target repos:

```yaml
projects:
  data-platform-core:
    path: ~/code/data-platform-core
    standards_overlay: standards/data-platform.md
```

Commands take `--repo` (single) or `--repos` (multi). Multi-project is for cross-cutting architecture work; the harness runs in a consolidated context with multiple repos accessible. For Stage 1, single-project is sufficient. Multi-project is added explicitly when a real cross-cutting task requires it.

### Integration points (where most agentic tooling fails)

The harness is only valuable if artefacts slot into the team's existing workflow without translation:

| Phase | Harness produces | Team consumes | Gap to close |
|---|---|---|---|
| Explore | `explore/<slug>.md` | Discovery doc in Confluence | Auto-export via MCP |
| Plan | `docs/rfcs/<slug>-rfc.md` | Team's RFC template | Skill must match exact format |
| Build | Branch + commits + `build-notes.md` | PR matching team's PR template + passing CI | Build includes PR body format; CI deps in engineering-principles skill |
| Review | `reviews/<slug>-review.md` | Code review process | Postable as PR comments, not separate doc |

Spend a week early inventorying team formats before refining prompts. The Build phase is written backwards from the team's PR template.

### Failure modes

| Failure | Detection | Response |
|---|---|---|
| Plan produces RFC that misses the problem | Human reviewer rejects at gate | Re-run Plan with feedback artefact |
| Build can't pass tests after N iterations | Iteration counter > threshold | Halt; produce `build-blocked.md`; human decides |
| Build and Review disagree irreconcilably | Same fix → same rejection twice | Halt; surface both artefacts; treat as Plan ambiguity |
| Token ceiling exceeded mid-phase | Real-time counter | Hard kill; write partial artefacts; surface |
| Gate-reviewer unavailable for hours | Pending-gate timer | Wait at gate. No silent auto-approve. |
| Triage misclassifies tier | Token usage vs tier baseline | Logged; feed into triage prompt iteration |
| MCP server returns garbage / times out | Phase reports retrieval failure | Continue with degraded context; flag in artefact |
| User edits artefact while phase running | File modification time mismatch | Warn; let human decide whether to restart phase |

Failures written to `.harness/runs/<run>/failures.json` for trend analysis.

---

## Part 3 — Adaptive pipeline

The harness is useless if a one-line bugfix triggers a 4-phase ceremony, and equally useless if a multi-week initiative gets the same treatment as a typo. Three levers make it adaptive: **task tiering**, **phase skipping**, and **context tiering**.

### Task tiers

| Tier | Example | Phases | Agent shape | Model profile |
|---|---|---|---|---|
| **S — Trivial** | Typo, rename, dependency bump | Build only | Single pass | Haiku / local |
| **M — Standard** | Single-file feature, bug fix | Plan (light) → Build → Review (light) | Subagents, single pass per phase | Sonnet |
| **L — Complex** | Cross-module feature, migration | Explore? → Plan → Build → Review, iteration | Full subagents, iteration allowed | Opus Plan/Review, Sonnet Build |
| **XL — Initiative** *(deferred, typically requires LangGraph)* | Multi-week, multi-RFC | Full pipeline, Plan decomposes to child M-tier runs | Parallel Build agents | Premium across |

XL-tier is genuinely hard on a single-back-edge engine. Treat as aspirational until Phase 11 (richer Mastra wiring or a new `LangGraphEngine` behind the existing `Engine` seam). In the meantime, decompose XL manually into a sequence of L-tier runs.

### Triage — the cheapest phase

Before any real phase runs, a **triage** call classifies the request. One prompt, one cheap model, structured output:

```
Input: problem statement (+ optional repo context hints)
Output:
  tier: S | M | L | XL
  phases: [list of phases to run]
  rationale: one line
  confidence: 0..1
```

If confidence is low, prompt the human. If high, proceed. Triage costs ~100–500 tokens and saves running Explore on a typo.

**Phase 1 note.** Triage is *not* in Phase 1. Solo use means you know the tier when you reach for the harness; CLI takes `--tier S|M|L` and defaults to M. Triage agent lands when (a) you start second-guessing your own tier calls, or (b) Stage 2 adoption introduces teammates who won't self-tier reliably.

### Phase skipping rules

- **Explore** runs only when Triage flags the problem as ambiguous or on user request. Default off.
- **Plan** runs in **light mode** for M-tier: short structured plan (goal, approach, acceptance criteria) rather than full RFC. Same skill, different template.
- **Review** runs in **light mode** for M-tier: rubric subset, no full adversarial pass. For S-tier, Review is replaced by pre-commit gate (tests + lint) only.
- **Gates** scale inversely with tier: S-tier auto-approves everything, M-tier gates on Review only, L-tier gates every phase, XL-tier gates every phase plus per-child-task.

### Context tiering

Three tiers of ingestion:

- **Minimal.** Task description + directly-referenced files. Default for S.
- **Focused.** Task description + relevant standards + files matched by repo search. Default for M.
- **Full.** Everything in the phase manifest. Default for L/XL.

### Token optimisation checklist

1. **Prompt caching** (Anthropic native) — ~90% discount on repeated prefix tokens. Static skills/standards/templates in the cacheable prefix halves the bill.
2. **LiteLLM Redis cache (Phase 4)** — replayed responses for eval/dev runs.
3. **Fresh context at phase boundaries** — a Review that inherits Build transcript burns 10–50× the tokens.
4. **Lazy context loading via tools** — let agents request files via Read, not pre-load manifests.
5. **Artefact summarisation at handoff** — Summary section for downstream phases; full doc via Read when needed.
6. **Short-circuit on cache hits in eval** — fixture suite resolves from cache until prompt actually changes.
7. **Token budgets** — soft budget logged in retro; hard ceiling deferred (revisit when a run blows past budget and surprises you).
8. **Stop sequences / output structure** — Review and Triage produce short structured output; enforce.
9. **Trim skills to differences from generic knowledge** — `rfc-template` is the *deltas* from a generic RFC, not a from-scratch explainer.
10. **Measure `tokens_per_successful_run` per tier** — the headline metric.

---

## Part 4 — Deployment model

Three stages of deployment. Each is a meaningful step; don't move to the next until the current one pays off.

### Stage 1 — Solo

Everything runs on your machine. Harness installed at `~/.harness/`, skills symlinked to `~/.claude/skills/harness/`. Production uses `claude -p` on Max plan via `ClaudeCliRuntime` — sole Stage 1 runtime. No Docker, no Langfuse, no LiteLLM, no Redis. Just files + git + subprocess.

**Don't move to Stage 2 until 3 real initiatives complete and a teammate has asked unprompted.** Premature rollout poisons adoption.

### Stage 2 — Per-engineer

Each engineer installs the same harness repo. `harness install` sets up their local symlinks. Standards directory is shared via the harness repo; improvements propagate via `git pull`. Additions (Langfuse, LiteLLM) only if triggered by concrete need.

Footprint per engineer: negligible. No containers required. Optional Langfuse + LiteLLM add ~1–2GB RAM if deployed.

Bar to graduate: "we want to compare runs across engineers" or "standards directory has become contentious."

### Stage 3 — Shared services

Selectively externalise what benefits from sharing:

- **Shared Langfuse** on a small VM. Each engineer's harness points at the shared instance. Cross-engineer metrics become possible.
- **Shared eval baselines** — fixture suite stays in repo; baselines published centrally.
- **Optional shared LiteLLM proxy** — org-wide cost tracking, rate-limit pooling. Only if cost governance becomes a real concern.
- **HTTP API** exposed for editor plugins, internal web UI, CI integrations.

This is where the harness might become interesting to a DX/platform team.

### Repo layout decisions that matter for portability

1. **Infrastructure-as-code lives in the harness repo.** Docker compose, LiteLLM config, Langfuse provisioning, dashboard JSON.
2. **Secrets via `.env`, never committed.** `.env.example` shows what's needed.
3. **`projects.yaml` + `projects.local.yaml` overlay pattern** avoids merge conflicts on per-engineer paths.

---

## Part 5 — Iterating on the harness

Once the harness is running and real tasks have flowed through, work shifts from building to improving.

### The core loop

```
1. Observe signals from real runs (git + .harness/runs/ + optional Langfuse)
2. Form one hypothesis about what to change
3. Make the change in a branch
4. Run `harness eval` — must not regress fixtures
5. Run on one real task — observe via retro
6. Commit if better, revert if worse
```

**One change at a time.** Multiple simultaneous changes destroy attribution.

### Signals in order of value

| Signal | What it tells you | Where |
|---|---|---|
| **Artefact diffs** (what you edited before approving) | Which prompt/skill section isn't pulling its weight | `git diff` between agent commit and your edit commit |
| **Gate rejections** | A phase is producing unusable output | Run metadata |
| **Build iteration count** | The build loop is fighting something — unclear RFC, missing standards, model mismatch | Run metadata / Langfuse |
| **Eval suite regressions** | A change broke a previously-working fixture | `harness eval` |
| **Token usage rising at flat quality** | Prompts getting verbose or context leaking | Langfuse |
| **Time-to-decision at gates** | Specific gates are friction — auto-approve or fix upstream | Run metadata |

### What's tunable

| Lever | Impact | Effort |
|---|---|---|
| Subagent system prompts | High | Low |
| Skill content (especially standards) | High | Medium |
| Context manifest (what loads) | Medium-High | Low |
| Rubric criteria | Medium-High | Medium |
| Model per phase | Medium (sometimes surprising) | Trivial (config) |
| Tier definitions / triage prompt | High (affects everything) | Medium |
| Tool allowlists per agent | Low-Medium | Trivial |

Start with subagent prompts and standards skills — highest impact, cheapest to test.

### Anti-patterns

- **Tuning on a single bad output.** One run is noise; two runs same issue is signal.
- **Adding to skills without removing.** Skills accumulate cruft; periodically audit and delete.
- **Optimising for eval, not real work.** If eval improves but retros don't, update fixtures from real failures.
- **Tweaking models when the prompt is the problem.** A better model masks a bad prompt; the issue resurfaces on a cheaper model later.

---

## Part 6 — Workflow profiles (deferred)

Deferred until software-delivery is mature (3+ months stable use). The same harness can eventually run:

- **Incident postmortem** (Reconstruct → Analyse → Document → Peer Review)
- **Personal planning** (Clarify → Design → Schedule → Retro)
- **Architecture decision (ADR)** (Research → Framing → Decision → Review)
- **Product discovery, performance review, quarterly planning, hiring debrief, technical writing, customer research**

Each adds ~30–50 lines of YAML + 3–5 skills. The workflow-profiles directory layout (`workflows/<name>/`) is introduced when the second workflow lands, not before — premature abstraction otherwise.

**Adoption sequencing:** software-delivery end-to-end, stabilise for a couple of months, add one *very different* workflow (incident postmortem or personal planning) to stress-test assumptions, then generalise. Don't build three workflows in parallel.

---

## Part 7 — Risks

1. **The harness becomes the project.** Easy to spend weeks tuning the planner prompt and zero weeks shipping real work. Every week must include using it on real work.
2. **Context leakage through the human.** You remember Build's reasoning and bias Review. Score rubric before reading diff.
3. **Rubric gaming.** Agents satisfy rubric without satisfying goal. Periodic human-graded calibration + rubric rotation.
4. **Team adoption friction.** >15-minute onboarding is a death sentence. Fix before fixing anything else.
5. **Build output doesn't match team workflow.** Design Build backwards from team's PR template.
6. **Premature shared services.** Stage 2 longer than feels right.
7. **Premature LangGraph / Langfuse / Temporal.** Commit in the repo: "will not add X until [specific trigger]."
8. **Optimising the harness, not outcomes.** Re-read success criteria quarterly.
9. **Implicit I/O means no pre-flight validation.** First failure is inside the agent. Acceptable for Stage 1; revisit if it bites at Stage 2.
10. **No token guardrail without explicit context declarations.** Discipline lives in prompt-authoring. Composer warns but doesn't enforce.
11. **Git-as-ledger assumes discipline.** If user doesn't commit artefacts, observability breaks. Optional auto-commit hook as mitigation.

---

## Part 8 — Implementation phases

Organised by capability, not calendar. Each phase has clear exit criteria. Sequencing assumes a few focused hours per week; compress or extend as workload allows.

**Principle:** every phase ends with the harness used on a real task. No "build infrastructure for weeks, then use it." Infrastructure is justified by the next real task's needs.

Phases 1, 4, 5, 6 are the Stage 1 + Stage 2 mainline. Phases 2, 3, 7+ are conditional — build only when the named trigger fires. Numbers are stable so references hold; the order you'd build them in is 1 → 4 → 5 → 6, then conditional phases as triggers arrive.

> **Current status (2026-04-22):** Phase 1 is **complete** and shipped as the `ordin` CLI. See the Phase 1 "Implementation notes" below for variances from the original plan. Next mainline target: Phase 4 (local eval suite).

### Phase 1 — Core end-to-end (Weeks 1–2) — ✅ Completed 2026-04-22

**Goal.** First real RFC flows through Plan → Build → Review end-to-end on a real task, using `ClaudeCliRuntime` against a real target repo.

**Deliverables:**
- pnpm/TS project with Biome (spaces) + Vitest + zod
- `src/domain/` — workflow loader, agent loader, skill loader, composer, artefact manager, project registry
- `src/runtimes/` — `ClaudeCliRuntime` (sole Stage 1 runtime; `--append-system-prompt`, `--output-format stream-json`, `--allowed-tools` per phase, `--model` from config, CWD = target repo)
- `src/orchestrator/` — `Engine` interface + `PhaseRunner` + `RunStore`; default impl `MastraEngine` (in `src/orchestrator/mastra/`) compiles the workflow into a `@mastra/core/workflows` workflow with Review→Build back-edge as a `.dountil()` loop; blocking foreground execution (Option A)
- `src/gates/` — `ClackGate` opens artefact in `$EDITOR`, then approve/reject/edit-and-approve. `FileGate` and `AutoGate` optional.
- `src/runtime/` — `HarnessRuntime` implementation (library surface — signpost interface even though CLI is the only Stage 1 client)
- `src/cli/` — `plan`, `build`, `review`, `run`, `status`, `runs`, `retro`, `doctor`, `install`. `--tier S|M|L` flag on phase commands. No `harness continue` (deferred with state-restore).
- `harness.config.yaml` — per-phase `model` and `allowed_tools`.
- `workflows/software-delivery.yaml`
- `agents/planner.md`, `agents/build-local.md`, `agents/reviewer.md`
- Initial skills hand-authored against a real target task (not generic templates): `rfc-template`, `engineering-principles`, `review-rubric`.
- Streaming transcript capture to `~/.harness/runs/<id>/transcript.jsonl` from day 1.
- `BASELINE.md` committed with current manual-pipeline cost (tokens + cycle time).
- `CLAUDE.md` with stack, architecture, style conventions.
- Optional: `pnpm deps:check` running dependency-cruiser locally. Not required for Phase 1 exit; no CI enforcement.

**Day-1 spike.** Verify `claude -p` subprocess behaviour on disallowed-tool-call (stall vs graceful deny vs non-zero exit). Determines whether per-phase watchdog timeout is Phase-1-required or deferred.

**Exit criteria:**
- ✅ One real Plan cycle completes end-to-end on the fixture target repo using `ClaudeCliRuntime` (Plan + gate). Build → Review cycles work structurally; full end-to-end cycle on a real target repo awaits first production use.
- ✅ Streaming output visible in terminal during each phase (clack-styled, tool-input previews); transcript persisted to `~/.ordin/runs/<id>/<phase>.jsonl`.
- ✅ `ordin retro <run-id>` produces per-phase duration, tokens, gate decisions, iteration count.
- ✅ `ordin runs` lists historical runs.
- ⏳ Teammate uses the generated RFC — awaits first shared use (Stage 2 gate).

**Implementation notes (variance from plan):**

- **App renamed to `ordin`.** CLI binary, package name, config file (`ordin.config.yaml`), plugin manifest name, and persistence path (`~/.ordin/runs/`) all reflect this. The harness *pattern* name stays in code (`HarnessRuntime`, `HarnessConfig`, `harness-plan.md`) — ordin is one implementation of the pattern.
- **No `harness install` command, no `~/.claude/` symlinks.** Plan originally had `install` symlinking skills/agents into `~/.claude/skills/harness/`. Dropped in favour of a `.claude-plugin/plugin.json` manifest at the ordin repo root and per-invocation `--plugin-dir <ordin-repo>`. Zero global pollution; users just `pnpm link --global .` to put `ordin` on PATH.
- **Day-1 spike resolved.** Disallowed tool calls under `claude -p` stall waiting for stdin-backed permission approval. Fix: `--permission-mode bypassPermissions` on every invocation; `--allowed-tools` is the actual security boundary. Optional `timeoutMs` escape hatch wired in `ClaudeCliConfig` but not mandatory.
- **Tier profiles with per-tier model + runtime-internal effort mapping.** `ordin.config.yaml` gains `tiers.{S,M,L}.model?` (neutral string, user-tunable). `ClaudeCliRuntime` privately maps `prompt.tier → --effort {low,medium,high}`. Domain stays provider-neutral; Claude-specific vocabulary (`--effort`, `--permission-mode`, `--plugin-dir`) lives only inside the runtime.
- **Unified `RunEvent` stream.** Orchestrator merges runtime-local `RuntimeEvent`s (tagged with `runId`/`phaseId`) with its own lifecycle events (`run.started`, `phase.started/completed/failed`, `gate.requested/decided`, `run.completed`) into one ordered stream. CLI sink uses clack spinner + `log.step` / `log.error` for rendering.
- **Fixture target repo.** `test/fixtures/target-repo-template/` + `pnpm fixture:setup` stage a throwaway target repo at `.scratch/target-repo/`. Registered in `projects.yaml` as `fixture`. Enables dev loops without aiming at real work.
- **Extra dev-ergonomics added.** `.mise.toml` pins Node/pnpm and exposes `test`, `typecheck`, `lint`, `deps-check`, `deps-graph`, `fixture-setup`, `check` tasks. `ARCHITECTURE.md` + auto-generated `ARCHITECTURE-graph.md` (Mermaid module graph via `pnpm deps:graph`). Test coverage via `@vitest/coverage-v8`.
- **Deps:** pnpm, TypeScript 6, Biome 2 (2-space indent, double quotes, 100 col), Vitest 4, zod 4, commander 14, @clack/prompts 1, yaml 2, gray-matter 4. Locked via `packageManager` + `.mise.toml`.
- **Tests:** 43 unit tests across 10 files. Domain coverage ~93%, orchestrator ~96% (state machine including Review→Build back-edge + max_iteration halt paths exercised). `ClaudeCliRuntime`, `ClackGate`, HTTP/CLI wrappers intentionally uncovered — deferred to Phase 4's eval suite + a future `MockRuntime` for local UX iteration.
- **Deferred from Phase 1:** `BASELINE.md` exists as a template but real numbers await first 2 weeks of production use. A `MockRuntime` for sink/orchestrator iteration (noted during Phase 1 but not built) would make future UX changes cheap to test.

### Phase 2 — HTTP adapter + OpenAPI (active)

**Trigger fired.** Mixed external-client need; no single editor-shaped target dominates.

**Deliverables:**
- `src/http/` — Hono server over `HarnessRuntime`, `@hono/zod-openapi` for schemas
- `/openapi.json` + SSE for `subscribe(runId)`
- `ordin serve [--port 8787]` CLI command

**Exit criteria:**
- `curl` drives a full run; TypeScript SDK generated from `/openapi.json` used in an integration test

### Phase 2b — MCP adapter (active, after Phase 2)

**Trigger fired.** Reaches Claude Code, Cursor, Claude Desktop, Continue, Cline.

**Deliverables:**
- `src/mcp/` — in-process consumer of `HarnessRuntime`
- Tools: `startRun`, `preview`, `getRun`, `getEvents`, `resolveGate`, `listWorkflows`
- `ordin mcp` stdio command

**Exit criteria:**
- Claude Code drives a run end-to-end including gate response; same server works in one other host (Cursor or Claude Desktop)

### Phase 3 — Triage and light-mode tiering (conditional)

**Trigger.** (a) You start second-guessing your own `--tier` calls, or (b) Stage 2 adoption introduces teammates who won't self-tier reliably.

Phase 1 already has `--tier S|M|L` as a CLI flag and `harness retro` for retrospectives — this phase adds automation and tier-specific agents on top.

**Deliverables:**
- `agents/triage.md` — cheap structured-output agent, classifies S/M/L/XL with rationale + confidence
- Light-mode agents: `planner-light.md`, `reviewer-light.md` (smaller templates, rubric subset)
- Tier → phase mapping in workflow YAML (S: build-only auto-approve; M: light plan → build → light review; L: full)
- Per-phase soft token budgets declared in YAML, warnings in retro (hard ceiling still deferred until a run actually blows past budget)

**Exit criteria:**
- S-tier run completes in <60s on a dep bump
- L-tier run works on a real cross-module feature
- Baseline `tokens_per_successful_run` captured per tier in `BASELINE.md`

### Phase 4 — Local eval suite

**Goal.** Change the harness safely. Every prompt change is eval-gated.

**Deliverables:**
- `evals/` directory with fixture-task YAMLs + a small TS runner (plain Vitest-style iteration with `autoevals` for LLM-as-judge scoring).
- 10–15 fixture tasks (real historical problems, paired with expected artefact characteristics — e.g., "RFC must address X; build must produce tests for Y; review must catch Z if seeded with the bug"). MVP seeds with 3–5 fixtures derived from the `.scratch/target-repo` calculator; real ones backfill as they arise.
- `AiSdkRuntime` — second runtime implementing `AgentRuntime` via Vercel AI SDK against any OpenAI-compatible provider. Eval uses this; production stays on `ClaudeCliRuntime`.
- LiteLLM proxy (Docker) as the default provider, with disk cache. Backend swapped by editing `litellm/config.yaml` `model_list` — Ollama, Anthropic passthrough, OpenAI, Bedrock, etc.
- `ordin eval [--suite <phase>] [--real-models]` command; reports pass/fail, deltas vs baseline.
- Docs: edit prompt → `ordin eval` → see deltas in <10 min.

**Note.** LiteLLM enters the stack here as a *provider* (HTTP gateway), scoped to eval only. Production path (Max plan via `ClaudeCliRuntime`) never touches it. Phase 8 later adds LiteLLM for *production routing* — a different use.

**Scope choices (vs. original plan):**
- **No promptfoo / Inspect AI.** Considered and rejected. Promptfoo's product direction is security red-teaming; its framework weight doesn't fit a pack-local eval shape. Own the small TS runner; use `autoevals` library for the one non-trivial piece (LLM-as-judge rubrics).
- **Disk cache, no Redis.** LiteLLM supports disk cache natively. Avoids adding Redis as infra. Redis revisits only if Phase 8's production routing actually needs it.
- **Bespoke runner rather than Vitest for eval suite.** Eval must run against pack content from any workflow pack path (see Workflow packs). Vitest is a repo-dev tool; pack consumers may not have it. The runner is a programmatic API + CLI entry (`ordin eval`), content-dir-aware.
- **Forward-compat with ingestion (Phase 14).** Fixture YAMLs reserve `ingestion_override` field; runner accepts it as a no-op today, wires it when Phase 14 lands.

**Exit criteria:**
- Change to planner prompt → eval deltas visible locally in <10 min
- At least one regression caught by eval and reverted
- Eval suite runs from cache after first run (cost = 0)

**Implementation notes (2026-04-22, in progress):**
- ✅ `src/runtimes/ai-sdk/` — `AiSdkRuntime` (`index.ts`, 173 LOC) + tool defs (`tools.ts`, 157 LOC). Uses `ai` + `@ai-sdk/openai-compatible` + `zod`. Tool surface mirrors `ClaudeCliRuntime`: Read / Write / Edit / Glob / Grep / Bash.
- ✅ `infra/docker-compose.yml` + `litellm/config.yaml` — LiteLLM proxy with disk cache; default `model_list` points at Ollama on host, commented passthroughs for Anthropic / OpenAI / OpenRouter / Bedrock.
- ✅ `HarnessRuntime` accepts `runtimes?` and `gateForKind?` overrides so eval swaps in `AiSdkRuntime` + `AutoGate` without touching orchestrator or workflow YAML.
- ⏳ Eval fixtures + runner + `ordin eval` CLI — in progress.

### Phase 5 — Multi-project mode

**Goal.** Cross-cutting architecture work (changes spanning multiple repos) works end-to-end.

**Deliverables:**
- `projects.yaml` + `projects.local.yaml` registry
- `--repos` CLI argument (comma-separated) and HTTP equivalent
- Composer handles multi-repo context (agent receives paths to all repos; runs with appropriate CWD)
- Per-project `standards_overlay` merging into phase context
- Decision documented: where cross-cutting artefacts land (primary repo vs cross-cutting `architecture/` repo)

**Exit criteria:**
- One real cross-cutting initiative completed end-to-end via multi-project mode
- Artefact landing location is consistent and documented

### Phase 6 — Team adoption polish

**Goal.** Two teammates use the harness on their own work, unprompted.

**Deliverables:**
- `HARNESS.md` — one-page day-to-day guide
- `harness install` symlinks skills to `~/.claude/skills/harness/`, registers CLI, validates config
- `harness doctor` — checks Node version, Claude CLI availability, skill symlinks, config validity
- `harness update` — pulls latest harness changes, re-syncs symlinks
- `.env.example` with all config variables documented
- One paired end-to-end walkthrough with a teammate (observe, note friction, fix top 3)
- Standards contribution docs (how to propose a change, review model, merge bar)

**Exit criteria:**
- Teammate clones harness, runs `harness install`, completes a Plan → Build → Review cycle without help
- Teammate prefers harness-produced RFC to their previous workflow
- Onboarding walkthrough timed and under 15 minutes
- Two teammates using the harness weekly without prompting

---

### Conditional phases (trigger-driven)

The phases below are additive and only built when the named trigger fires. Don't build speculatively.

### Phase 7 — Langfuse observability

**Trigger.** Git + `.harness/runs/` is no longer sufficient. You can't answer questions like "which prompts regressed last week" or "which phases consistently hit token ceilings" without structured trace storage.

**Deliverables:**
- `infra/docker-compose.yml` Langfuse v3 stack (web, worker, postgres, clickhouse, redis, minio); web bound to 127.0.0.1:3000
- `src/observability/tracing.ts` — single OTel `NodeSDK` bootstrap. Reads `LANGFUSE_HOST` / `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`; no exporter when unset
- Run span (`ordin.run`) in `MastraEngine.run`; phase span (`ordin.phase`) in `executePhase` — engine-neutral so any future engine inherits tracing through the shared phase entry point
- AI SDK `experimental_telemetry: { isEnabled, functionId, metadata }` on `generateText` — auto-emits nested spans for the model loop, tool calls, and step boundaries; nests under the phase span via OTel context
- Eval bootstrap (`evals/setup.ts`) starts/shuts the SDK; `runPhase()` opens its own `ordin.eval.phase` root span since it bypasses `MastraEngine`
- Stage-3-ready: `LANGFUSE_HOST` env var swaps to a shared instance with no code change

**Non-deliverables (deferred):**
- `ClaudeCliRuntime` instrumentation. The phase span still wraps subprocess invocations so phase boundaries are visible, but model/tool detail isn't auto-emitted (the subprocess speaks no OTel). Parsing the JSON event stream into spans is a follow-up.
- Langfuse SDK as a direct harness dependency — OTLP/HTTP keeps the harness vendor-neutral
- Dashboard provisioning. Defer until trace shape is observed in real use.

**Exit criteria:**
- Every harness run appears as a Langfuse trace with token counts, durations
- Disabling tracing is a one-env-var change; harness behavior unchanged with no `LANGFUSE_*` set

### Phase 8 — LiteLLM for multi-provider routing

**Trigger.** A teammate uses Bedrock-only auth; or the eval suite wants model-comparison runs; or fallback chains are needed for rate-limit resilience.

**Deliverables:**
- `litellm/config.yaml` with provider routing and fallback chains
- `LiteLlmRuntime` adapter (provider-agnostic calls)
- Per-phase model configuration (`model: anthropic/claude-opus-4-7`)
- Stage-3-ready: shared proxy option for team-wide cost tracking

**Note.** LiteLLM never enters the Max-plan `ClaudeCliRuntime` path — only runtimes that need multi-provider routing.

**Exit criteria:**
- One phase runs on Claude Opus via LiteLlm adapter
- Fallback chain works when primary model rate-limits

### Phase 9 — ACP adapter (deferred)

**Trigger.** A Zed or Neovim user starts daily-driving an ACP-capable editor.

**Deliverables:**
- `src/acp/` — stdio server over `HarnessRuntime`; gates → `session/request_permission`, artefacts → `fs/write_text_file`
- `ordin acp` command
- One session hosts many sequential runs; `/run <workflow> <task>` to invoke

**Exit criteria:**
- ACP-compatible editor starts a run, observes progress, approves gates from within the editor

### Phase 10 — SDK-based runtime

**Trigger.** Moving to API billing, or wanting streaming observation / mid-loop intervention, or removing Claude Code CLI dependency.

**Options:**
- Claude Agent SDK (Anthropic primitives; cleanest for Anthropic-only)
- Mastra (TS-native agent framework with tool loop, memory, streaming)
- Vercel AI SDK (lighter weight, less opinionated)

**Deliverables:**
- `SdkRuntime` implementing `AgentRuntime`
- Tool loop handling (Read, Write, Bash, Glob, Grep)
- MCP client support
- Permission handling (prompt user on sensitive tool use)

**Exit criteria:**
- One phase runs end-to-end on `SdkRuntime` against a non-Anthropic model
- No Claude CLI dependency in that path

### Phase 11 — `LangGraphEngine` (or richer Mastra config)

**Trigger.** XL-tier work needs parallel Build agents; or `ordin continue` (mid-process resume) becomes a real pain point; or `MastraEngine`'s topology constraints (single back-edge per workflow) bite.

The `Engine` seam already exists. Two concrete paths once a trigger fires:

1. **Wire more of Mastra into `MastraEngine`** — Mastra natively supports parallel steps (`.parallel()`), suspend/resume (via `@mastra/libsql` storage), nested branches, and richer condition primitives. For most triggers this is the cheaper path: edit `src/orchestrator/mastra/index.ts` + add a storage dep.
2. **Add `LangGraphEngine`** — new file `src/orchestrator/langgraph/index.ts` implementing `Engine`, with its own compiler turning `Workflow` into a `StateGraph`. Domain / runtimes / gates / CLI / YAML untouched. Switch via `ORDIN_ENGINE` env or constructor option.

**Deliverables (depending on path chosen):**
- `MastraEngine` extended for parallel phases / nested loops / mid-process resume; storage adapter wired.
- *Or* `LangGraphEngine` implementing the same `Engine` interface.
- Per-phase soft-iteration cap and parallel topology supported in `Workflow`/YAML where the engine needs it.

**Note.** The structural refactor that landed before this phase moved the heavy lifting forward — adding a second engine implementation is a single new file, not a directory replacement.

**Exit criteria:**
- Parallel-phase XL-tier workflow runs end-to-end.
- Mid-process crash recoverable without re-running prior phases.

### Phase 12 — Standards ingestion

**Trigger.** Hand-authored skills drift from source of truth (Confluence, ADR repos). Manual sync becomes a chore.

**Deliverables:**
- `harness standards sync` command — MCP-driven ingestion agent pulls from configured sources
- Output: `skills/generated/<name>/SKILL.md` with `source:` and `content_hash:` headers
- Diff-review gate: user approves changes before they land
- Scheduled or on-demand sync

**Exit criteria:**
- Engineering standards from team's Confluence appear as a harness skill
- Changes to the source produce a visible diff in next sync
- Reproducibility preserved: runs use pinned/committed skill content, not live MCP calls

### Phase 14 — Ingestion layer

**Trigger.** Workflow authoring hits the ceiling of what pinned skills alone can express. A teammate wants their planner to consult Confluence, or their builder to read GitHub issue comments, and hand-copying into skills is the bottleneck.

**Deliverables:**
- `ingestion/<phase>.yaml` schema + loader in `src/domain/`.
- `ordin ingest <pack> [--phase X]` command — syncs pinned sources, writes content-addressed snapshots, updates hashes.
- MCP binding in `LiteLlmRuntime` + per-phase MCP server wiring for `ClaudeCliRuntime` (the latter has native MCP discovery; wiring it per-phase is the new work).
- Composer extended: ingestion config resolves to `artefactInputs` (pinned) + MCP server references (live).
- Eval runner: fixtures pin ingestion by pack-commit-hash; live-MCP sources flagged non-reproducible.
- Docs: how to add a new ingestion source; pinned-vs-live decision guide.

**Exit criteria:**
- One real workflow pulls tech-strategy context via pinned Confluence ingestion.
- One real workflow invokes a live MCP tool from Build phase.
- Evals for the ingested phase run reproducibly from the pinned snapshot.
- Swapping an ingestion source in a fixture produces a measurable eval delta.

**Relationship to Phase 12.** Phase 12 (`harness standards sync`) was scoped as a narrow "pull standards into skills" tool. Phase 14 supersedes it: standards-as-skills becomes one type of ingestion; Phase 14 formalises ingestion broadly. If Phase 14 lands, Phase 12 collapses into it.

### Phase 15 — Async notifications

**Trigger.** Long runs become common enough that polling `getEvents` or watching SSE in a terminal is friction; a teammate wants to be pinged on completion or pending gate.

**Deliverables:**
- Per-server / per-run webhook URLs that POST `RunEvent` JSON on `run.completed` and `gate.requested`
- `--notify` flag on `ordin run` for a desktop notifier
- HMAC signing for webhook payloads

**Exit criteria:**
- Slack/webhook receiver can verify-and-render a `run.completed` callback
- Webhook delivery is best-effort — failure never affects the run

### Phase 16 — Multi-user awareness

**Trigger.** Two or more developers share an `ordin serve` instance and run/gate ownership becomes ambiguous.

**Deliverables:**
- Token-to-identity map (extends single `ORDIN_API_TOKEN` to `ORDIN_API_TOKENS`); each request carries the identity through to `RunMeta`
- `RunMeta.startedBy` and per-gate `decidedBy`
- Default listing scoped to the requester; `?all=true` for the unscoped view

**Exit criteria:**
- Two tokens drive runs against the same server; each user sees only their runs by default
- Gate audit log records who decided each gate

### Phase 13+ — Deferred indefinitely (trigger-driven)

- **Temporal** — durable cross-day execution
- **A2A** — remote specialist agents
- **Shared LiteLLM proxy** — org-wide cost governance
- **Shared Langfuse** — cross-engineer baselines
- **Workflow profiles directory** — second workflow lands
- **XL-tier orchestration** — typically via LangGraph, probably coincides with Phase 11
- **IDE-specific plugins (VS Code, JetBrains)** — thin extensions over HTTP

---

## Appendix A — File layout

```
harness/
├── package.json                    # Bun, TS, Biome, Vitest
├── biome.json
├── tsconfig.json
├── vitest.config.ts
├── dependency-cruiser.config.cjs   # optional; run locally via `bun run deps:check`, no CI enforcement
│
├── CLAUDE.md                       # conventions for agents working ON the harness
├── HARNESS.md                      # day-to-day user guide
├── BASELINE.md                     # current-state metrics
├── README.md
│
├── harness.config.yaml             # per-phase `model` and `allowed_tools`; runtime defaults
├── projects.yaml                   # shared project registry
├── projects.local.yaml             # personal overrides (gitignored)
│
├── bin/
│   └── harness                     # CLI entry
│
├── src/
│   ├── domain/
│   │   ├── workflow.ts
│   │   ├── agent.ts
│   │   ├── skill.ts
│   │   ├── composer.ts
│   │   ├── artefact.ts
│   │   └── project.ts
│   ├── runtimes/
│   │   ├── types.ts                # AgentRuntime interface
│   │   └── claude-cli.ts           # sole Stage 1 runtime; sdk.ts lands when Phase 10 triggers
│   ├── orchestrator/
│   │   └── sequential.ts
│   ├── gates/
│   │   ├── types.ts                # Gate interface
│   │   ├── clack.ts                # opens $EDITOR on artefact, then approve/reject/edit
│   │   ├── file.ts
│   │   └── auto.ts
│   ├── runtime/                    # HarnessRuntime implementation
│   │   └── harness.ts
│   └── cli/
│       └── *.ts
# src/http/ lands when HTTP adapter trigger fires (see conditional Phase 2)
│
├── workflows/
│   └── software-delivery.yaml
│
├── agents/
│   ├── planner.md
│   ├── build-local.md
│   └── reviewer.md
# planner-light.md, reviewer-light.md, triage.md land when conditional Phase 3 triggers
│
├── skills/
│   ├── rfc-template/SKILL.md
│   ├── engineering-principles/SKILL.md
│   └── review-rubric/SKILL.md
│
├── evals/                          # Phase 4
│   ├── fixtures/
│   └── config.yaml
│
├── litellm/                        # Phase 4 (for eval) / Phase 8 (for routing)
│   └── config.yaml
│
├── langfuse/                       # Phase 7
│   ├── docker-compose.yml
│   └── dashboards/
│
└── test/
    ├── unit/
    └── integration/                # opt-in via env var
```

User-level (installed by `harness install`):

```
~/.harness/                         # source of truth
├── skills/                         # hand-authored skill bodies
└── runs/
    └── <run-id>/
        ├── transcript.jsonl
        ├── tokens.json
        └── meta.json

~/.claude/                          # user's Claude Code config
├── skills/
│   └── harness/                    # symlinks → ~/.harness/skills/*
└── agents/
    └── harness-*.md                # symlinks → <harness-repo>/agents/*
```

Artefacts in target repo:

```
<target>/
├── problem.md                      # user-written brief
├── docs/rfcs/<slug>-rfc.md         # Plan output (committed by Build)
├── docs/rfcs/<slug>-build-notes.md # Build output
├── reviews/<slug>-review.md        # Review output
└── (code changes + tests)          # Build output
```

---

## Appendix B — CLI surface

```
# Lifecycle (Phase 1)
harness install                     # symlink skills/agents to ~/.claude
harness update                      # re-sync after pulling changes
harness doctor                      # check config, deps, symlinks
harness status                      # print current run state (live)
harness runs                        # list historical runs
harness retro <run-id>              # per-phase duration, tokens, gate decisions, iteration count, cost

# Phases (Phase 1)
harness plan <task> [--repo ...] [--tier S|M|L]
harness build <slug> [--repo ...]
harness review <slug>

# Full pipeline (Phase 1)
harness run <task> [--repo ...] [--tier S|M|L]   # blocking foreground; gates inline via $EDITOR + clack

# Exploration (conditional, optional Phase 0)
harness explore <task> [--repos ...]

# Triage (conditional Phase 3)
harness triage <task>               # classify tier, suggest phases

# HTTP (conditional Phase 2)
harness serve [--port 8787]         # starts HTTP + OpenAPI

# Eval (Phase 4)
harness eval [--suite <phase>] [--real-models]

# ACP (conditional Phase 9)
harness acp                         # ACP server over stdio
```

---

## Appendix C — Core types

```ts
// Workflow YAML parsed into:
interface Workflow {
  name: string;
  description?: string;
  version: string;
  phases: Phase[];
}

interface Phase {
  id: string;
  agent: string;                    // agent markdown name
  runtime: string;                  // AgentRuntime name (Stage 1: "claude-cli")
  gate: "human" | "auto" | "pre-commit";
  fresh_context?: boolean;
  on_reject?: { goto: string; max_iterations: number };
  budgets?: { soft_tokens: number };  // hard_tokens deferred
}

// Agent markdown frontmatter:
interface Agent {
  name: string;
  runtime: string;
  tools?: string[];
  model?: string;
  body: string;                     // the prompt
}

// Agent execution seam:
interface AgentRuntime {
  readonly name: string;
  readonly capabilities: RuntimeCapabilities;
  invoke(req: InvokeRequest): Promise<InvokeResult>;
}

interface RuntimeCapabilities {
  nativeSkillDiscovery: boolean;
  streaming: boolean;
  mcpSupport: boolean;
  maxContextTokens: number;
}

// Client seam:
interface HarnessRuntime {
  createRun(input: CreateRunInput): Promise<Run>;
  getRun(id: string): Promise<Run>;
  listRuns(filter?: RunFilter): Promise<Run[]>;
  resumeRun(id: string): Promise<Run>;
  cancelRun(id: string): Promise<void>;
  startPhase(runId: string, phaseId: string): Promise<PhaseResult>;
  getPhase(runId: string, phaseId: string): Promise<PhaseState>;
  approveGate(runId: string, phaseId: string, note?: string): Promise<void>;
  rejectGate(runId: string, phaseId: string, reason: string): Promise<void>;
  getArtefact(runId: string, path: string): Promise<Artefact>;
  listArtefacts(runId: string): Promise<Artefact[]>;
  subscribe(runId: string): AsyncIterable<RunEvent>;
}

// Gate seam:
interface Gate {
  request(ctx: GateContext): Promise<GateDecision>;
}

type GateDecision =
  | { status: "approved"; note?: string }
  | { status: "rejected"; reason: string };

// Event model — stable across all clients:
type RunEvent =
  | { type: "run.started"; runId: string }
  | { type: "phase.started"; runId: string; phaseId: string }
  | { type: "phase.runtime.completed"; runId: string; phaseId: string }
  | { type: "artefact.updated"; runId: string; path: string }
  | { type: "tokens.used"; runId: string; phaseId: string; count: number }
  | { type: "gate.requested"; runId: string; phaseId: string }
  | { type: "phase.completed"; runId: string; phaseId: string }
  | { type: "phase.failed"; runId: string; phaseId: string; error: string }
  | { type: "run.completed"; runId: string };
```
