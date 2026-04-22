# Fixture Target Repo

A tiny TypeScript utility library used as a target for ordin dev loops. Not a real project.

## What's here

- `src/greet.ts` — greeting helper.
- `src/calculator.ts` — arithmetic with a couple of obvious TODO gaps.

## Why

ordin developers need *something* to aim an `ordin plan / build / review` run at without pointing at real work. This stand-in is small enough that phases finish quickly and cheap enough to reject-and-iterate on without guilt.

Copy to `.scratch/target-repo/` (gitignored in the ordin repo) via `pnpm fixture:setup`, which also `git init`s it so the Review phase's `git diff` / `git log` / `git show` work.
