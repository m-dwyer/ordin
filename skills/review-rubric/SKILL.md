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

Is the diff scoped to the RFC? Unrelated refactors, drive-by fixes, and formatter-only churn are scope leakage. Call them out even if they're improvements.

### 4. Test quality

- New behaviour → new test? (mandatory)
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
