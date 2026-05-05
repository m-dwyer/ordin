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

## 2. Decide Skill Loading Strategy

Status: works, but not equivalent to stable runtime.

Current provider behavior:

- Composer still lists available skill names/descriptions in the user prompt.
- Provider then inlines full skill bodies into the provider system prompt.
- Provider prompt tells Claude not to call `Skill`.

This is reliable, but loses progressive disclosure and increases every first
turn prompt. Stable `claude-cli` instead uses Claude Code native plugin/skill
discovery through `--plugin-dir <harnessRoot>`.

Options:

1. Keep inline skills for provider v1.
   - Pros: simple; no extra tool call; avoids Claude trying to read harness
     paths outside the workspace.
   - Cons: larger prompt; not equivalent to stable runtime; no progressive
     disclosure.

2. Expose `Skill` through schema-only MCP.
   - Pros: restores provider-owned progressive disclosure; works like
     `AiSdkRuntime` and `ToolDispatcher`.
   - Cons: Claude may spend an extra turn loading a skill; needs prompt cleanup
     so the model knows to call `Skill`.

3. Pass `--plugin-dir <harnessRoot>` as well.
   - Pros: closest to stable Claude Code behavior.
   - Cons: reintroduces Claude Code native skill machinery while the provider is
     trying to own the loop; may conflict with schema-only MCP and cwd
     boundaries.

Recommendation:

Use option 2 first. It validates ordin-owned skill activation across runtimes and
keeps the provider architecture honest.

Implementation notes:

- Stop inlining full skill bodies in `buildProviderSystemPrompt`.
- Restore wording that says available skills can be loaded with `Skill`.
- Add `Skill` to the MCP tool list when `req.prompt.skills.length > 0`, even if
  the workflow phase does not list `Skill` in `allowed_tools`.
- Or explicitly include `Skill` in workflow allowed tools for phases whose
  agents declare skills. Pick one rule and make it deterministic.
- Ensure the `Skill` tool result includes the skill body and enough metadata
  (`name`, `description`) for Claude to use it.
- Add tests proving a provider tool loop can call `Skill` and then write the
  expected artifact.

Likely files:

- `src/worker/runtimes/claude-cli-provider.ts`
- `src/worker/runtimes/claude-provider-mcp.ts`
- `src/worker/runtimes/shared/dispatcher.ts`
- `test/unit/claude-cli-provider.test.ts`

## 3. Add Tier/Effort Mapping

Status: missing.

Stable `claude-cli` maps ordin tier to Claude Code `--effort`:

- `S` -> `low`
- `M` -> `medium`
- `L` -> `high`

Provider currently does not pass `--effort`, so it may use Claude Code defaults.

Implementation notes:

- Reuse or extract `ClaudeCliRuntime.effortForTier`.
- Add `--effort <level>` in `ClaudeCliStreamProvider.buildArgs`.
- Unit-test that provider args include expected effort for S/M/L.

Likely files:

- `src/worker/runtimes/claude-cli.ts`
- `src/worker/runtimes/claude-cli-provider.ts`
- `test/unit/claude-cli-provider.test.ts`

## 4. Add Per-Phase Claude Provider Overrides

Status: missing.

Stable `claude-cli` supports:

- `phases.<phase>.fallback_model`
- `phases.<phase>.max_turns`

Provider supports only:

- `timeout_ms`
- `max_steps`
- `protocol_debug`

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

## 5. Improve Failure Classification

Status: provider collapses most failures to `kind: "model"`.

Stable `claude-cli` classifies failures into:

- `rate_limit`
- `auth`
- `tool`
- `model`
- `timeout`
- `crash`
- `unknown`

Provider should classify the same way so orchestrator retry/diagnostic behavior
does not depend on runtime choice.

Implementation notes:

- Reuse or extract `classifyFailure` from `claude-cli.ts`.
- Keep provider-specific malformed-protocol failures distinguishable, probably
  `kind: "model"` or `kind: "unknown"` with `retryable: false`.
- Mark timeout-triggered child kills as `timeout`.
- Unit-test auth, rate limit, bad tool request, timeout, and crash paths.

Likely files:

- `src/worker/runtimes/claude-cli.ts`
- `src/worker/runtimes/claude-cli-provider.ts`
- `test/unit/claude-cli-provider.test.ts`

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
