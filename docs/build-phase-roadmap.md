# Build-phase roadmap

Forward-looking plan for how the Build phase produces verifiable work. Driven by an empirical run of `software-delivery` against `qwen3.6` where the build agent fabricated `Landed` entries in `build-notes.md` for milestones that hadn't actually shipped (no test files, no `vitest` config), and the reviewer caught the lie via `ls`/`grep` but failed to write its review artefact before the model emitted EOT.

## Where we are

- One Build phase per workflow run. Agent reads RFC, edits code, writes `build-notes.md`, commits.
- Build-notes structure is free-text markdown; agent fills sections from a skill template.
- No mechanical verification of build-notes claims against disk. Reviewer is the only check.
- Smaller open-weight models (qwen3.6, etc.) routinely fabricate `Landed` entries because the section name and template invite claim-mode prose. Stronger models (Claude/GPT-5) generally don't.

## Ordered improvements

Each improvement stands alone. Land in order; each later one assumes the earlier ones are in place.

**1. Reshape `build-notes.md` to remove structural lie-pressure.**

- Drop the upfront "Planned" / "What changed" section. RFC's Work Breakdown is already the contract; restating it in build-notes is duplication.
- Structure becomes: `Summary` (post-fact), `Landed` (one entry per shipped milestone, each with a `verified: <command> → <result>` line), `Deferred (per RFC)`, `Deviations from the RFC`, `What to look at first`.
- Skill rule: no entry enters `Landed` without a verification line. The model has to fabricate both the claim *and* the verification command, which is a higher dishonesty bar.
- Files: `skills/build-notes-template/SKILL.md`, `agents/build-local.md` step 6.

**2. Structured work-breakdown artefact from Plan.**

- Plan phase emits a second declared output alongside the RFC: `docs/rfcs/{slug}-work-breakdown.yaml` with one entry per milestone — `id`, `description`, `files`, `verify` (a shell command that proves the milestone landed).
- RFC stays prose (framing, options, recommendation, work-breakdown narrative). The YAML is the machine-iterable view.
- Skill rule: `verify` commands are concrete (`grep`, `test -f`, `bun test`), not aspirational ("manually inspect").
- Files: `skills/rfc-template/SKILL.md`, `workflows/software-delivery.yaml` Plan outputs.

**3. Mechanical verify as Build's exit criterion.**

- Engine reads `work-breakdown.yaml` after Build's `runtime.invoke()` returns. For each milestone the build-notes marks `Landed`, run its `verify` command in the workspace. Failure → phase fails with the offending milestone named.
- Catches fabricated `Landed` entries without depending on the reviewer or the build-agent's honesty.
- Files: `src/orchestrator/phase-executor.ts` (extend post-runtime artefact verification), `src/orchestrator/phase-artefacts.ts` (parse work-breakdown YAML).

**4. Per-milestone iteration inside Build.**

- Build phase becomes a `foreach` over `work-breakdown.yaml.milestones`. Each iteration: fresh context with RFC + last `build-notes.md` + the current milestone, agent does that one thing, runs `verify`, commits, appends a `Landed` entry, advances.
- Smaller scope per agent invocation — the dishonesty pressure mostly evaporates when the agent only has to claim one thing at a time.
- Files: `src/domain/workflow.ts` (`foreach` field on `PhaseSchema`), `src/orchestrator/workflow-plan.ts` (new `ExecutionPlan` variant), `src/orchestrator/mastra/*` (wire to Mastra's `.foreach()` step).

**5. Phase-level retry on transient failure.**

- If a phase fails its artefact check, retry the same phase up to N times before failing the run. Same prompt, fresh worker — handles cases where a smaller model emitted EOT before calling the final tool but would succeed on a re-roll.
- Different from `on_reject` (which is a gate-rejection cycle); this triggers on `phase.failed`, not on a gate decision.
- Per-phase or workflow-default; YAML field `retry: { max: 2 }`.
- Files: `src/domain/workflow.ts` (Phase schema), `src/orchestrator/phase-executor.ts` (retry wrapper).

**6. Per-agent runtime/model selection.**

- Cheaper/local model for Plan, stronger model for Build/Review. Already supported by per-agent frontmatter in `agents/*.md`; just hasn't been used for differentiation yet.
- Trigger: empirical evidence that one phase's failure mode is fundamentally model-quality (qwen3.6 EOT mid-write) and not solvable at the prompt layer.

**7. Discovery / Plan split.**

- Split the current Plan phase into `discovery` (problem statement → RFC framing) and `plan` (RFC → work-breakdown.yaml + commit-by-commit milestone list).
- Only worth doing if `(2)` has shipped and produces evidence that the plan agent juggling "framing" and "decomposition" in one prompt is hurting either deliverable.
- Adding phases is the most expensive structural change; reach for it after cheaper levers.

## Workflow-iteration ergonomics

Independent from the build-phase deliverable improvements above; these accelerate the dev loop when testing workflow / agent / skill changes. None require engine work; all are file-shuffling.

The disk-as-state model already gives phase-boundary "checkpointing" for free — `--only <phase>` re-uses prior phases' artefacts from disk. The two gaps are: bootstrapping a new run from a known-good prior run's outputs, and avoiding model tokens on phases you're not iterating on.

**Fixture runs.**

- Pre-canned RFCs / work-breakdowns / build-notes under `test/fixtures/runs/<scenario>/` representing realistic mid-workflow states.
- New CLI flag `--fixture <name>` seeds the run directory from the fixture before invoking the engine. Useful for: iterating on a Build skill against a known-good plan output without burning Plan tokens; testing Review against a deliberately-bad build-notes; reproducing a past failure deterministically.
- Files: `src/cli/run.ts` (flag), new fixture directory layout, `src/runtime/harness.ts` (seed run dir before `startRun`).

**`--mock-prior <runId>`.**

- Copy a prior run's artefacts into a new run's dir as starting state, then run only the phases you're iterating on (`--only build` against the seeded artefacts).
- Cheaper than fixtures when the input you want is "exactly what last week's run produced", e.g. for prompt regression checks against a real RFC.
- Files: `src/cli/run.ts` (flag), small artefact-copy helper.

**Why these aren't checkpoint+resume.**

Both achieve "iterate on Build without re-running Plan" via disk seeding, not by snapshotting engine state. They don't preserve audit chain continuity, event stream replay, or run-id identity — by design, each iteration is a *new* run that happens to start from a familiar place. If you ever need bit-for-bit reproducibility (eval suites comparing against a frozen prior run), that's the real LangGraph checkpoint trigger.

## LangGraph engine swap

Mastra handles items 1–7. The roadmap's Phase 11 LangGraph trigger is unrelated to build-phase specifics; it fires when *workflow shapes* exceed Mastra's DAG model, not when build phases need narrowing. Concrete LangGraph triggers:

- **Mid-run checkpoint + resume** — pause an in-flight workflow, persist state, resume from a different process. Real for headless server-mode where users approve gates from a separate client.
- **Stateful shared graph state with typed reducers** — many steps reading/writing the same evolving structure. Mastra threads data through step inputs/outputs; LangGraph models a single typed state object.
- **Non-tree topologies with cycles + branches mixed** — multiple feedback edges between non-adjacent phases. Mastra supports one `on_reject` rejecter; more would force awkward composition.
- **Subgraphs as first-class composition** — nested workflows where a phase is itself a workflow. Mastra's nested-workflow story is more limited.

None of these fire today. Don't swap until at least one is concrete pain.

## Workflow YAML schema extensibility

The schema (`src/domain/workflow.ts`) is Zod-based. Adding new fields is strictly additive — extend the Zod schema, optional fields ignore-by-default, engines opt in by reading them. Existing workflows keep parsing.

What's cheap to add:

- New per-phase fields (`verify`, `max_steps`, `retry`, `foreach`, `model_class`).
- New artefact contract attributes (`schema`, `validate_with`).
- New gate kinds (extend `GateKindSchema`).

What requires engine + compiler changes:

- **New topology shapes** — `compileWorkflowPlan` returns `ExecutionPlan` which today has two variants (`linear`, `single-retry-loop`). Adding `foreach` or `parallel-branches` means new variants + Mastra-side fan-out wiring. The seam is well-defined, but it's a real change, not a YAML field.
- **Multiple rejecters / multiple loops** — today max one `on_reject` per workflow. Lifting that needs the compiler to model overlapping cycles.

### YAML vs. code-defined workflows

| | YAML (today) | Code |
|---|---|---|
| Diffability | Plain text, reviewable in PRs | Imports + types — diffable but noisier |
| Validation timing | Load-time Zod parse | Compile-time TS + load-time Zod |
| Expressiveness | Static fields only | Computed phases, conditional inclusion, list comprehension |
| Authoring barrier | Anyone | TS contributors |
| Safety | Schema-bounded | Type-bounded — broader |
| Re-deploy | None | Build step |

YAML is the right default for the workflows we have today (5–10 phases, mostly static topology). The point you'd reach for code-defined workflows is when one of these is true:

1. Phase count is computed (e.g., one phase per RFC milestone, count discovered at runtime). YAML can't express this; needs `foreach` in the schema *or* a code-level fan-out.
2. Conditional phase inclusion based on inputs (e.g., "skip review if RFC says non-goals only"). Doable with a YAML `when:` field, but expressions get ugly fast.
3. Workflow composition (one workflow embeds another). YAML imports / includes are awkward; code makes this trivial.

If items 1 and 2 land via `foreach` + `when` schema fields, you stay in YAML for a long time. Item 3 is the realistic forcing function — and it's also the LangGraph subgraph trigger above. The two questions converge.

## Workflow rendering and visualization

The `WorkflowManifest` data structure is the single source of truth — YAML or code-defined, both produce the same shape. Renderers walk that data. Don't try to make helpers do double duty (build manifest *and* emit diagrams via re-execution); keep helpers single-purpose, walk the data once it's built.

```
WorkflowManifest  ─┬─→  renderMermaid(m)  → string  (static docs)
                   └─→  renderXyflow(m)   → { nodes, edges }  (interactive UI)
```

Each renderer is ~80–120 LoC of pure data walking. Same data, multiple output adapters. Works for YAML and code-defined workflows identically.

**Mermaid (static, do this with the workflow improvements above).**

- `renderMermaid(manifest): string` emits `stateDiagram-v2`. Phases as states, gates as transition labels, `on_reject` as back-edges, `foreach` (when it lands) as compound states.
- CLI: `bun run ordin workflow diagram <name>` prints to stdout.
- Pre-commit hook regenerates a `.mmd` companion next to each workflow file so docs stay in sync.
- Pairs with the doc-evolution use case: snapshot `software-delivery`'s diagram before/after each roadmap item lands, embed in this file.

**xyflow read-only (cheap, lights up when there's a web UI).**

- `renderXyflow(manifest): { nodes, edges }` emits xyflow's data model.
- Drop into any future web dashboard for live run visualization (audit-stream-driven node colouring) or a workflow-library browser.
- Builds on the same walker as Mermaid — adding it later is incremental.

**xyflow as workflow editor (drag-and-drop authoring → TS codegen).**

- Real commitment, not a derivative of the walker. Round-trip fidelity (xyflow → TS → load → xyflow), code generation, hand-edit conflict resolution.
- **Reuse check first:**
  - **`@mastra/playground-ui`** — Apache-2.0 React component library used by Mastra's dev playground. Genuinely reusable as a building block if you want to skip drawing primitives from scratch and build an ordin-shaped editor on top. Note that the runnable Mastra Playground itself (`@mastra/playground`) is marked `@internal/`, not published, and ships only as part of `mastra dev` — so it's not "point it at ordin and go", it's "we cherry-pick its components for our own editor".
  - **Mastra core license caveat**: Apache-2.0 *outside* `ee/` directories; the `ee/` (Enterprise Edition) directories are under a separate license. Stay out of `ee/` and `@mastra/playground-ui` is genuinely OSS.
  - **LangGraph Studio** is *not* a real alternative — part of LangSmith, paid/hosted. Doesn't ship with the open-source LangGraph library.
  - No off-the-shelf "ordin-domain workflow editor" exists. You'd be wiring `@mastra/playground-ui` or xyflow directly into your own surface either way; the question is which UI library, not "build vs reuse".
- Trigger: empirical demand for visual authoring (likely from non-engineers). Until then, defer — building an editor without users is the most expensive item on the roadmap.

**Order of investment.**

1. TS workflow loader + helpers (from the YAML/code section above).
2. Mermaid renderer + CLI command + pre-commit doc generation.
3. xyflow read-only renderer (only when a web UI surface lands; trivial once Mermaid renderer is in place).
4. `@mastra/playground-ui` evaluation spike (one day): does it provide enough primitives that wiring it onto our `WorkflowManifest` is meaningfully cheaper than xyflow direct?
5. xyflow (or `@mastra/playground-ui`-based) editor with codegen — only when there's a concrete authoring user and the read-only viewer demonstrably isn't enough.

## Out of scope for this roadmap

- **Build agent personality / prompt tone** — separate from structural fixes.
- **RFC quality** — the planner producing a thin RFC is a Plan-phase concern; a separate doc.
- **Tool sandboxing** — covered by `docs/sandboxing-implementation.md`.
- **Skill registry / signing** — supply-chain concern; orthogonal.
