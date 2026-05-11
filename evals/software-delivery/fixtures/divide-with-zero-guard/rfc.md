# RFC — Implement calculator `divide` with zero-guard

## Summary

Add a `divide(a, b)` function to `src/calculator.ts` that returns `a / b` and throws a clear error when `b === 0`. This resolves the TODO currently marking zero-denominator behaviour as undecided. The change is scoped to `src/calculator.ts` only.

## Problem

`src/calculator.ts` exposes `add`, `subtract`, `multiply`, but `divide` is missing because zero-denominator behaviour was left undecided (see the inline `TODO: divide` comment). Callers currently work around this by inlining `/`, which ships buggy `Infinity` / `NaN` outputs on bad input. The harness fixture doubles as a smoke target for the eval suite, so leaving `divide` unimplemented blocks further build-phase fixtures.

## Options

1. **Throw on zero denominator.** `divide(a, 0)` raises `RangeError("divide by zero")`. Callers must handle the throw at the boundary. Pro: loud failure, discoverable. Con: introduces a throwing function in a module where no other op throws.
2. **Return a discriminated result.** `divide` returns `{ ok: true, value } | { ok: false, error }`. Pro: type-safe at the call site. Con: more ceremony than three-line arithmetic helpers warrant.
3. **Return `NaN`.** Matches native JS `Infinity` / `NaN` semantics. Pro: zero work. Con: silent failure; the TODO exists precisely because this was rejected.

## Recommendation

Option 1. The module's callers are internal; a throw is the loudest failure mode and matches the engineering-principles rule that "an operation that can't succeed raises." Option 2 is overbuilt for this module's style; Option 3 is what the TODO explicitly rejected.

## Work breakdown

1. Add `export function divide(a: number, b: number): number` to `src/calculator.ts`. Throws `RangeError` with message `"divide by zero"` when `b === 0`. Remove the now-resolved `TODO: divide` comment.
   - Acceptance: `src/calculator.ts` exports `divide`; the `TODO: divide` line is gone.

## Non-goals

- **Tests.** The fixture repo has no test runner wired up; this module is exercised end-to-end by the harness eval suite rather than per-file unit tests. Call this out in `build-notes.md` so a reviewer isn't surprised.
- **README, other TODOs, formatting passes.** Out of scope. Other `TODO` lines in `src/calculator.ts` stay.

## Risks

- **Throwing diverges from the module's non-throwing style.** Likelihood: medium. Impact: low (few call-sites). Mitigation: document the choice in `build-notes.md` so reviewers see it immediately.
- **Callers catch too broadly and swallow unrelated `RangeError`s.** Likelihood: low. Impact: low. Mitigation: the specific message `"divide by zero"` makes targeted catches easy.
- **Scope creep — tempting to validate all operators.** Likelihood: medium. Impact: low. Mitigation: RFC is explicit — `divide` only. Other TODOs stay.
