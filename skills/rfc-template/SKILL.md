---
name: rfc-template
description: RFC structure, tone, and acceptance-criteria discipline. Load when drafting or reviewing an RFC.
---

## Purpose

This skill is the *delta* from a generic RFC template — it captures the discipline the harness wants, not a full explainer.

## Required sections (in order)

1. **Summary** — 2–4 sentences. This is the handover paragraph Build will read first. If Build can't plan from the Summary alone plus the Work breakdown, it's too thin.
2. **Problem** — what we're solving and for whom. Include the trigger (incident, metric, user report, strategic ask). Avoid "we need X" — explain why.
3. **Options** — two or more. For each: one-paragraph description + bulleted trade-offs. If you genuinely can't find a second option, say so and explain the constraint that collapses the design space.
4. **Recommendation** — which option and why. One short paragraph.
5. **Work breakdown** — numbered milestones. Each milestone has acceptance criteria that are observable in a diff, a test, or a log line. "Refactor X cleanly" is not acceptance criteria; "function Y now returns `Result<T>` and all call sites are updated; added test at z.test.ts" is.
6. **Risks** — top three. Each: risk, likelihood, impact, mitigation. Don't fill to three if you only have two — padding dilutes signal.

## Optional sections

- **Open questions** — explicit calls for reviewer input. Use when you can't resolve something without a human decision.
- **Non-goals** — scope exclusions. Use when readers might assume the RFC covers something it deliberately doesn't.
- **Migration / rollout** — only if the change can't ship in a single PR.

## Tone discipline

- Present-tense, active voice. "The service rejects requests over 10MB" not "requests will be rejected".
- No hedging in the Recommendation. Commit.
- Code snippets sparingly — RFC is about *what* and *why*, not *how*.
- No bullet-point lists more than two levels deep.

## Anti-patterns (refuse to produce these)

- Summary that is just the Problem section re-phrased.
- Work breakdown milestones that are tasks ("implement auth module") rather than observable deltas.
- Risks that are generic ("could introduce bugs") — specific or omit.
- "Out of scope" lists longer than the Work breakdown — that's a sign the RFC is too small for its topic.
