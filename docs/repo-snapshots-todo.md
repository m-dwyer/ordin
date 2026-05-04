# Repo Snapshots TODO

## Problem

Current fixtures copy declared workflow artifacts only. That is enough to rerun Build from a Plan RFC, but it is not enough to rerun Review from a Build result after resetting the target repo.

Review needs the actual post-Build workspace state: code changes, tests, generated files, and handoff artifacts. A docs-only fixture can make Build notes claim work landed while the reset repo still has no implementation changes.

## Goal

Make phase outputs durable as workspace snapshots, not only declared artifact files.

Target shape:

```text
~/.ordin/runs/<run-id>/snapshots/
  plan/repo/
  build/repo/
  review/repo/
```

Each snapshot should represent the target repo filesystem immediately after that phase completes.

## Proposed First Implementation

Use `rsync` or equivalent recursive copy after each successful phase:

```bash
rsync -a --delete \
  --exclude node_modules \
  --exclude .cache \
  --exclude dist \
  --exclude coverage \
  <target-repo>/ \
  <run-dir>/snapshots/<phase>/repo/
```

Include `.git` initially so Review can run `git status`, `git diff`, and `git log` against the same repo state Build produced. Revisit this if snapshot size becomes a problem.

## CLI Shape

Possible restore command:

```bash
ordin run "Implement divide with zero-guard" \
  --project fixture \
  --from-snapshot <run-id>:build \
  --only review
```

Possible fixture capture behavior:

```bash
ordin run --capture-fixture divide-build --from-run <run-id>
```

For a Build-completed run, this should capture or reference the post-Build repo snapshot, not only `docs/rfcs/*-build-notes.md`.

## Open Questions

- Should snapshots be copied into fixtures, or should fixtures reference run snapshots by id?
- Should `.git` be included always, or reconstructed from base repo plus patch/untracked files?
- What exclude list is safe across real projects?
- How should snapshot restore interact with dirty target repos?
- Should failed phases get snapshots for debugging, or only completed phases?

## Non-Goals For Now

- Container or microVM execution.
- Cross-machine snapshot transport.
- Deduplicated storage via restic/borg.
- Workflow-engine checkpoint/resume. This TODO is only about workspace state.
