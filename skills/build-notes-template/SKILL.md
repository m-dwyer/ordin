---
name: build-notes-template
description: Build-notes structure, written as a working journal. Load when starting Build and again before declaring done.
---

## Purpose

This skill is the *delta* from a generic implementation summary — the discipline the harness wants from `build-notes.md`. Build notes are written **as a working journal**, not a retrospective: the file exists from the first commit and gets updated as work lands.

## Required sections (in order)

1. **Summary** — 2–4 sentences. The handover paragraph the reviewer reads first. What landed, what didn't, and any RFC deviation. If the RFC needs revision, prefix the file with the line `RFC needs revision` and explain at the bottom under "RFC issues".
2. **What changed** — bullet list grouped by RFC Work-breakdown milestone. Each entry: which file(s) changed, in one line, with the *why*. The reviewer reads this against the diff; vagueness here forces them to re-derive your intent from the patch.
3. **Deferred per RFC** — explicit list of work the RFC marked deferred (or that the Work breakdown called out for follow-up). The reviewer must see these so they don't read the absence as oversight. If nothing was deferred, write "None."
4. **Deviations from the RFC** — anything you did that the RFC didn't ask for, or anything in the RFC you didn't do. Each item: what changed, why, and (if non-obvious) why this isn't a scope expansion. If there were no deviations, write "None."
5. **What to look at first** — pointer for review: the riskiest change, the spot where the RFC was ambiguous, or the code that exercises a new boundary. Two or three lines.

## Optional sections

- **RFC issues** — only if the RFC was wrong or under-specified during implementation. State the issue, what you assumed, and confirm the `RFC needs revision` flag at the top of the file.
- **Test results** — if the RFC scopes tests as in-scope, paste the relevant pass/fail summary or the commit hash that runs them. Omit when tests are deferred.

## How to write it (working journal)

- **Start the file before the first code edit.** Write the Summary as your *intended* outcome and the "What changed" section as the planned mapping from RFC milestones to commits. This is the contract you're holding yourself to — and it gives the reviewer the through-line if you stop midway.
- **Update between commits.** After each logical step, edit the file: convert planned entries to landed entries, capture deferrals as they emerge, note any scope shift.
- **Verify before marking Landed.** Do not flip an entry from Planned to Landed on the strength of intent. Run a quick `ls`, `grep`, `Read`, or `Bash` check that the change actually exists on disk — a file you wrote, a symbol you added, a test that runs. Unverified entries stay Planned. *Marking work Landed without verification is the single biggest source of false build-notes; the reviewer will catch it, and the run will fail.*
- **Reconcile at the end.** Before declaring done, re-read the file. Every entry under "What changed" should match a real diff. Every RFC milestone should resolve to either a landed entry or a Deferred entry — nothing dangling.

## Tone discipline

- Present-tense, active voice. "Adds the divide function" not "added the divide function".
- Specific over generic. "Changes `divide()` to throw `RangeError` on zero" beats "improved error handling".
- No padding. If the change is small, the notes are short.
- No bullet-point lists more than two levels deep.

## Anti-patterns (refuse to produce these)

- Summary that just lists files touched — that's "What changed", not the handover paragraph.
- "Deferred per RFC" missing items the RFC explicitly named as out of scope. The reviewer reads this list to confirm intent.
- Silent deviations — if you changed something the RFC didn't ask for, name it under "Deviations" with a justification. "Just a small clean-up" is not a justification.
- Notes longer than the diff. A 200-line build for a 50-line change means you're explaining instead of letting the code show.
- Trailing summary written only at the end. The journaling pattern is the point — a retrospective drafted once, after work, drops the deferrals and deviations the journal would have caught.
