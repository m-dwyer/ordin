---
name: engineering-principles
description: Codebase conventions and scope discipline for the Build phase. Load before making stylistic or architectural decisions.
---

## Purpose

This skill is the *delta* from generic good engineering — the specific habits this project cares about. Tune it after the first real run; the generic bits below are bootstrap defaults.

## Scope discipline

- Do **only** what the RFC scoped. If you notice an unrelated bug or smell, note it in `build-notes.md` under "Observations" — do not fix it.
- One surprise per PR is already too many. Zero is the target.
- No speculative abstractions. Three similar lines beats a premature helper.
- No backwards-compat shims for code that doesn't exist yet.

## Tests

- New behaviour gets a test. No test = not done.
- Prefer integration tests that exercise a whole seam over unit tests that mirror implementation shape.
- Tests that mock the thing they're testing are not tests.
- If you change a public contract, every call-site gets a regression test or the change is wrong.

## Code changes

- Small commits, conventional messages, each referencing the RFC section it addresses.
- No `// TODO` without a ticket or a line in `build-notes.md` Open-questions.
- No mass formatter runs on unrelated files — the diff must be minimal.
- Delete dead code the RFC scope touches. Leaving it "just in case" is an anti-pattern.

## Error handling

- Validate at system boundaries (user input, external APIs). Trust internal code.
- Don't wrap thrown errors just to add a message; add `cause` if you must.
- No silent failures. An operation that can't succeed raises.

## Naming

- Function names are the *verb* plus what changes. `loadConfig`, not `config` or `getConfig`.
- Boolean names read as a question: `isReady`, not `ready`.
- Avoid vague suffixes (`*Manager`, `*Helper`, `*Util`) unless the alternative is genuinely worse.

## Comments

- Default: no comments. Well-named identifiers document *what*.
- Write a comment when the **why** is non-obvious — hidden constraint, subtle invariant, a workaround with a link to the bug it mitigates.
- Never describe the current task, PR, or caller ("added for the Y flow") — rots as the code evolves.
