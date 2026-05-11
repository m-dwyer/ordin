---
name: review-rubric
description: Criteria for the Review phase to evaluate a built change against its RFC. Load before scoring.
---

## Purpose

A rubric the reviewer applies in a fresh-context window. The reviewer has never seen the RFC drafting nor the Build reasoning — that is the point.

## Scoring categories

For each category, classify **met / partially met / not met**, with a one-line justification.

### 1. Problem match

Does the change solve the Problem the RFC described — not a neighbouring problem, not a subset, not a superset? If the tests pass but the change doesn't address the stated problem, this is **not met** regardless of code quality.

### 2. RFC acceptance criteria

Go through the Work breakdown item by item. For each acceptance criterion the RFC declared:

- Is there a concrete change in the diff that satisfies it?
- Is there a test that would fail if the criterion regressed?

If either is missing, the criterion is at best **partially met**.

### 3. Scope discipline

Cuts both ways — flag both directions:

- **Scope leakage** — work in the diff that the RFC didn't ask for. Unrelated refactors, drive-by fixes, formatter-only churn, dependencies installed without RFC justification, files modified beyond what the RFC named, test infrastructure added when the RFC scoped tests as deferred. Call them out even if the changes are improvements.
- **Silent scope reduction** — in-scope work skipped without acknowledgement. Cross-check `build-notes.md` against the RFC's Work breakdown: every deferred item must match an item the RFC explicitly marked deferred or named as a Non-goal. Build "running out of time" without saying so is **not met** for that criterion.

### 4. Test quality

Applies only when the RFC's Work breakdown lists tests as in-scope. If the RFC explicitly defers tests, this category is **deferred** rather than not-met — but check that Build flagged the deferral in `build-notes.md` (otherwise it's a Scope discipline issue, not a Test quality one).

- New in-scope behaviour → new test? (mandatory when tests are in scope)
- Tests exercise seams, not implementation details?
- Mocks placed at system boundaries, not at the unit under test?
- Changed public contracts → updated or added regression tests?

### 5. Error paths

- Are error paths exercised, or only the happy path?
- Are errors surfaced in a way callers can act on?
- Any silent swallowing (`catch {}`, `.catch(() => {})`)?

### 6. Build-notes quality

- Does `build-notes.md` explain deviations from the RFC?
- Are open questions surfaced, not hidden?
- Is there anything in the diff that isn't mentioned?

## Output

Map each category to met/partially/not. Then:

- **Must-fix** — issues that make a category *not met*. Each item cites file:line.
- **Should-fix** — issues that make a category *partially met*. Each item cites file:line.
- **Nits** — style, naming, cosmetic. Optional.

## Recommendation heuristic

- All categories **met** → `ship`.
- Any category **not met** → `re-plan` if the RFC was wrong, `iterate` otherwise.
- Mix of **met** and **partially met** → `iterate` with must-fix list.
