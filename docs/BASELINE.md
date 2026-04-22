# Baseline — manual-pipeline cost before harness adoption

Per `harness-plan.md` Part 1 (Measurement): *"Without a baseline, success criteria are retroactive vibes."*

Capture below, before Week 1 of real harness use, what it currently costs you to produce the artefacts the harness will eventually produce.

## Current workflow (narrative)

> Describe the manual steps from "problem arrives" to "PR merged" today. Who does each step, how long does each take, what tools, what handoffs.

## Artefact production cost

| Artefact | Average cost today | How you measure |
|---|---|---|
| Discovery doc / explore | — | — |
| RFC | — | — |
| PR-ready branch (code + tests + description) | — | — |
| Review pass | — | — |

Cost axes to capture (fill whichever apply):

- Wall-clock time from start to reviewable artefact.
- Number of Claude Code / Claude.ai sessions used.
- Approximate token spend (Claude Max plan: count sessions; Claude API: use usage dashboard).
- Number of hand-offs / back-and-forth with teammates.

## S/M-tier statistical baseline (capture over first 2 weeks of real use)

After the harness is running on real tasks, track these per run for 2 weeks and fill in baseline numbers here:

- `tokens_per_successful_run` — median and p90.
- Build iteration count — median.
- Gate rejection rate — percentage.

## L-tier narrative baseline

List the ~1–3 RFC-worthy pieces you have produced (or tried to) in the last 3 months. For each:

- Topic.
- Time-to-approved-RFC.
- Was it usable without rewrites?

These are the L-tier yardsticks the harness will be judged against.
