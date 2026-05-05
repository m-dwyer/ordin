# Claude CLI Provider Runtime TODO

This notes the known gaps after `94514bf Improve Claude provider resume and timing spans`.
The experimental `claude-cli-provider` runtime now works through Claude Code's
`stream-json` protocol, schema-only MCP tools, ordin-owned `ToolDispatcher`
execution, per-phase `--resume`, and provider/tool OTEL timing spans.

The goal of this TODO is parity with the stable `claude-cli` runtime where that
parity matters for real software-delivery workflows.

## Current Shape

- Stable runtime: `src/worker/runtimes/claude-cli.ts`
- Provider runtime: `src/worker/runtimes/claude-cli-provider.ts`
- Schema-only MCP server: `src/worker/runtimes/claude-provider-mcp.ts`
- Shared tool execution: `src/worker/runtimes/shared/dispatcher.ts`
- Shared tool primitives: `src/worker/runtimes/shared/tools.ts`
- Workflow used for smoke tests: `workflows/software-delivery-provider.yaml`

Current provider behavior:

- Starts a Claude Code process for each provider turn.
- Captures Claude `session_id` and passes `--resume <session_id>` for follow-up
  turns within the same phase.
- Disables Claude native tools with `--tools ""`.
- Exposes phase tools through schema-only MCP names such as
  `mcp__ordin__Read`.
- Kills the Claude process as soon as a `tool_use` block is observed, then
  dispatches the normalized tool name through `ToolDispatcher`.
- Records `ordin.provider.turn` and `ordin.tool.<ToolName>` timing spans under
  the parent phase trace.

## 1. Enforce Tool Pattern Allowlist

Status: deferred until sandbox v1 lands.

The workflow supports scoped tools (`Write(docs/rfcs/*)`, `Bash(git diff*)`, …).
Stable `claude-cli` delegates enforcement to Claude Code via `--allowed-tools`;
the provider runtime parses only the tool name, so patterns degrade to bare
tool names at the `ToolDispatcher` boundary.

Why deferred:

The right design depends on whether ordin owns the security boundary or only a
workflow-correctness boundary. Without sandbox, this validator is the only line
between a model and the host filesystem — argues for shell-quote tokenization,
strict path normalization, etc. With sandbox, the validator narrows to "does
this call match the phase's declared intent?" and a much smaller implementation
suffices. Building the strict version now means rewriting it once sandbox lands.

Revisit when:

- Sandbox v1 ships and is the production stance for `claude-cli-provider` runs.
- A real workflow-correctness bug appears (a phase scoped to `Write(docs/rfcs/*)`
  writes outside its scope and breaks something).

Likely files when picked up:

- `src/worker/runtimes/shared/` (new module for the policy class)
- `src/worker/runtimes/claude-cli-provider.ts`, `scripted/index.ts` (call sites)

## 2. Skill Loading via MCP-Exposed `Skill`

Status: done.

Provider lists skill names + descriptions in the system prompt and exposes
`Skill` via the schema-only MCP server. Bodies are no longer inlined; the model
calls `Skill { name }` to load on demand. ordin's `ToolDispatcher` serves the
SKILL.md body. Matches the agentskills.io activation pattern; same shape as
stable runtime's plugin system, with ordin owning the catalog and loader.

## 3. Tier/Effort Mapping

Status: done. `effortForTier` extracted from `claude-cli.ts` for shared use;
provider passes `--effort low|medium|high`.

## 4. Per-Phase Claude Provider Overrides

Status: done. `ClaudeCliProviderConfigSchema.phases.<id>.{fallback_model,max_steps}`.
`fallback_model` flows through to `claude -p` (omitted when same as main
model); `max_steps` overrides the provider-loop ceiling. `max_turns` is
intentionally not supported — the provider kills the child after each tool use
so it has no analog.

Implementation notes:

- Extend `ClaudeCliProviderConfigSchema` with a `phases` record similar to
  `ClaudeCliConfigSchema`.
- Decide mapping:
  - `fallback_model`: pass through to Claude Code when different from selected
    model.
  - `max_turns`: probably not useful because provider breaks after one tool use
    per process. Prefer `max_steps` as provider-owned loop ceiling.
- If `max_turns` is omitted for provider, document the difference.

Likely files:

- `src/worker/runtimes/claude-cli-provider.ts`
- `test/unit/claude-cli-provider.test.ts`

## 5. Failure Classification Parity

Status: done. Provider catch reuses `classifyFailure` from `claude-cli.ts`, so
`rate_limit`, `auth`, `tool`, `timeout`, `crash`, `unknown` surface identically
across runtimes. `ProviderTimeoutError` propagates timer-fired child kills as
`kind: timeout, retryable: true`. The "tool not allowed" matcher was broadened
to include `is not allowed` so policy-violation messages classify as `tool`.

## 6. Partial Streaming and Hook Events

Status: lower priority.

Stable runtime supports:

- `req.streamPartial` -> `--include-partial-messages`
- `--include-hook-events`

Provider currently emits final text blocks for each provider turn and records
tool/provider timing spans. That is enough for the TUI smoke path, but not full
parity.

Implementation notes:

- `--include-partial-messages` may be useful if Claude Code emits partial text
  before tool use in provider mode.
- Hook events may be less important because provider-owned tools already emit
  ordin spans. Add only if a concrete diagnostic gap appears.

Likely files:

- `src/worker/runtimes/claude-cli-provider.ts`
- `test/unit/claude-cli-provider.test.ts`

## 7. Performance Follow-Ups

Status: measured but not solved.

Recent smoke runs showed provider total time improved from about 1m40s to about
53s in one run, but another trace showed a single resumed provider turn taking
about 41s. Tool dispatch spans are near-zero, so most remaining latency is
Claude Code/model turn latency, process startup, MCP initialization, or Claude
session resume overhead.

Implementation notes:

- Use Langfuse timing spans to identify slow turns:
  - `ordin.provider.turn`
  - `ordin.tool.<ToolName>`
- If provider turns remain slow, test whether a real persistent process gives a
  meaningful win over `--resume`.
- Before attempting persistent transport, first reduce unnecessary model turns:
  - avoid verify `Read` when the phase output check already validates the file.
  - strengthen Plan prompt to batch exploration before writing.
  - avoid `Skill` calls when inline skill strategy is retained.

## Test Commands

Run focused checks:

```sh
bun test test/unit/claude-cli-provider.test.ts test/unit/claude-cli.test.ts
bun run typecheck
bun run lint
bun run deps:check
```

Run full suite. In restricted sandboxes this may fail with
`listen EPERM 127.0.0.1`; rerun outside the sandbox because broker/http tests
bind local loopback servers.

```sh
bun run test
```

Smoke the provider workflow:

```sh
ordin run "Add a tiny README note" \
  --workflow software-delivery-provider \
  --repo .scratch/target-repo \
  --only plan \
  --slug provider-smoke \
  --tier S \
  --sandbox passthrough
```
