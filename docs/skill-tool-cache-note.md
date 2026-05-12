# Skill Tool Cache Note

## Context

During a software-delivery smoke run, the Plan phase loaded the same `rfc-template`
skill more than once in a single agent invocation. The behavior is valid, but it
repeats a large tool result and spends tokens without adding new context.

## Recommendation

Add a per-invocation cache to the worker-side `Skill` tool executor.

- First call to `Skill("name")` returns the full `SKILL.md` body.
- Later calls for the same skill name in the same phase invocation return a short
  message such as: `Skill "name" is already loaded; use the previously returned instructions.`
- Duplicate calls remain audited as normal tool dispatch/result events.
- The cache is not shared across phases, runs, agents, or process lifetimes.

## Why Worker-Side

The domain Tool Authority should continue to describe and validate the `Skill`
tool. It should not own execution memory. The worker/tool layer already owns
tool execution context, so it is the right place to remember which skills have
been loaded during a single invocation.

## Non-Goals

- Do not make duplicate skill loads an error.
- Do not hide duplicate calls from the audit log.
- Do not introduce a global skill body cache.
- Do not change skill resolution semantics across fresh-context phase runs.

## Acceptance Criteria

- A phase invocation that calls the same skill twice receives the full body once
  and a short already-loaded response the second time.
- Two different phase invocations can each load the full same skill body once.
- Broker audit still records every `Skill` dispatch and result.
- Existing skill authorization and unknown-skill behavior are unchanged.

## Related: Repeated Writes

The smoke run also showed the Build phase writing the same build-notes artefact
several times while settling on its content. Some repeated writes are expected:
the Build agent is instructed to treat build notes as a working journal and
update them as work progresses. Unlike duplicate skill loads, writes are side
effects and must not be cached or suppressed.

Future improvements should make repeated writes easier to interpret without
changing write semantics:

- Tighten the Build prompt: update build notes only after a meaningful state
  change, such as initial plan, completed RFC milestone, discovered deferral, or
  final reconciliation.
- Prefer `Edit` over full-file `Write` after the initial build-notes file
  exists.
- Add a warning-only audit/TUI signal when the same path is rewritten many times
  in a short window.
- Include repeated-write counts in run summaries, for example:
  `docs/rfcs/x-build-notes.md rewritten 4 times`.

Repeated writes should remain allowed. The warning is a prompt-quality and token
efficiency signal, not a policy violation.
