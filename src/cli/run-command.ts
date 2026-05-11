import { basename, join } from "node:path";
import type { Harness, RunMeta, SandboxMode, StartRunInput } from "../composition/harness";
import type { Phase, WorkflowManifest } from "../domain/workflow";
import { captureFixture, seedFromFixture, seedPhaseInputsFromRun } from "./run-seed";

export interface RunCommandOpts {
  readonly workflow?: string;
  readonly project?: string;
  readonly repo?: string;
  readonly tier?: "S" | "M" | "L";
  readonly slug?: string;
  readonly only?: string;
  readonly from?: string;
  readonly dryRun?: boolean;
  readonly sandbox?: SandboxMode;
  readonly script?: string;
  readonly fixture?: string;
  readonly fromRun?: string;
  readonly again?: string;
  readonly captureFixture?: string;
  readonly force?: boolean;
}

export interface ResolvedRunCommand {
  readonly workflow?: string;
  readonly sandbox?: SandboxMode;
  readonly input: NormalizedStartRunInput;
  readonly header: {
    readonly task: string;
    readonly slug: string;
    readonly tier: "S" | "M" | "L";
    readonly workflow?: string;
    readonly repoPath?: string;
    readonly project?: string;
  };
  readonly seed?: SeedPlan;
}

export type NormalizedStartRunInput = StartRunInput & {
  readonly tier: "S" | "M" | "L";
};

type SeedPlan =
  | {
      readonly kind: "capture-fixture";
      readonly fixturesRoot: string;
      readonly name: string;
      readonly sourceRun: RunMeta;
      readonly workflow: WorkflowManifest;
      readonly phase?: Phase;
      readonly force?: boolean;
    }
  | {
      readonly kind: "seed";
      readonly fixturesRoot: string;
      readonly fixture?: string;
      readonly sourceRun?: RunMeta;
      readonly sourcePhase?: Phase;
    };

type RuntimeForWorkflow = (opts: { workflow?: string }) => Harness;

export async function resolveRunCommand(
  taskParts: readonly string[],
  opts: RunCommandOpts,
  runtimeForWorkflow: RuntimeForWorkflow,
): Promise<ResolvedRunCommand> {
  validateRunOpts(opts);

  const initialRuntime = runtimeForWorkflow({ workflow: opts.workflow });
  const [again, fromRun] = await Promise.all([
    opts.again ? initialRuntime.getRun(opts.again) : undefined,
    opts.fromRun ? initialRuntime.getRun(opts.fromRun) : undefined,
  ]);
  const workflow = opts.workflow ?? again?.workflow ?? fromRun?.workflow;
  const runtime = workflow === opts.workflow ? initialRuntime : runtimeForWorkflow({ workflow });
  const input = buildRunInput(taskParts, opts, { again, fromRun });
  const phaseId = opts.only ?? opts.from;
  const needsSeedPlan = opts.fixture || opts.fromRun || opts.captureFixture;
  const workflowDefinition = needsSeedPlan ? await runtime.workflowDefinition() : undefined;
  const phase = workflowDefinition && phaseId ? workflowDefinition.findPhase(phaseId) : undefined;
  const fixturesRoot = join(runtime.paths().root, "fixtures", "runs");
  const sandbox = opts.sandbox ?? again?.sandboxMode;

  return {
    ...(workflow ? { workflow } : {}),
    ...(sandbox ? { sandbox } : {}),
    input,
    header: buildHeader(input, workflow),
    ...(needsSeedPlan
      ? {
          seed: opts.captureFixture
            ? {
                kind: "capture-fixture",
                fixturesRoot,
                name: opts.captureFixture,
                sourceRun: requireFromRun(fromRun),
                workflow: requireWorkflow(workflowDefinition),
                ...(phase ? { phase } : {}),
                ...(opts.force ? { force: true } : {}),
              }
            : {
                kind: "seed",
                fixturesRoot,
                ...(opts.fixture ? { fixture: opts.fixture } : {}),
                ...(fromRun ? { sourceRun: fromRun, sourcePhase: phase } : {}),
              },
        }
      : {}),
  };
}

export async function applySeedPlan(
  plan: SeedPlan | undefined,
  input: NormalizedStartRunInput,
  runtime: Pick<Harness, "resolveRunWorkspace">,
): Promise<"captured" | "seeded" | "none"> {
  if (!plan) return "none";
  if (plan.kind === "capture-fixture") {
    await captureFixture({
      fixturesRoot: plan.fixturesRoot,
      name: plan.name,
      sourceRepo: plan.sourceRun.repo,
      sourceSlug: plan.sourceRun.slug,
      workflow: plan.workflow,
      completedPhaseIds: plan.sourceRun.phases
        .filter((phase) => phase.status === "completed")
        .map((phase) => phase.phaseId),
      ...(plan.phase ? { phase: plan.phase } : {}),
      ...(plan.force ? { force: true } : {}),
    });
    return "captured";
  }

  const targetRepo = await runtime.resolveRunWorkspace(input);
  if (plan.fixture) {
    await seedFromFixture({
      fixturesRoot: plan.fixturesRoot,
      name: plan.fixture,
      targetRepo,
    });
  }
  if (plan.sourceRun) {
    await seedPhaseInputsFromRun({
      sourceRepo: plan.sourceRun.repo,
      sourceSlug: plan.sourceRun.slug,
      targetRepo,
      targetSlug: input.slug,
      phase: requirePhase(plan.sourcePhase),
    });
  }
  return "seeded";
}

export function buildRunInput(
  taskParts: readonly string[],
  opts: RunCommandOpts,
  reuse: { readonly again?: RunMeta; readonly fromRun?: RunMeta } = {},
): NormalizedStartRunInput {
  if (opts.only && opts.from) {
    throw new Error("Use either --only or --from, not both");
  }

  const task =
    taskParts.length > 0 ? taskParts.join(" ") : (reuse.again?.task ?? reuse.fromRun?.task);
  if (!task) throw new Error("Missing task; pass one or use --again/--from-run");

  const slug = opts.slug ?? reuse.again?.slug ?? reuse.fromRun?.slug ?? slugify(task);
  if (!slug) throw new Error("Unable to determine slug; pass --slug");

  const repo = opts.repo ?? reuse.again?.repo ?? reuse.fromRun?.repo;
  const only = opts.from ? undefined : (opts.only ?? reuse.again?.phaseSlicing?.onlyPhases?.[0]);
  const startAt = opts.from ?? (opts.only ? undefined : reuse.again?.phaseSlicing?.startAt);

  return {
    task,
    slug,
    ...(opts.project ? { projectName: opts.project } : {}),
    ...(repo && !opts.project ? { repoPath: repo } : {}),
    tier: opts.tier ?? reuse.again?.tier ?? reuse.fromRun?.tier ?? "M",
    ...(only ? { onlyPhases: [only] } : {}),
    ...(startAt && !only ? { startAt } : {}),
  };
}

function validateRunOpts(opts: RunCommandOpts): void {
  if ((opts.fixture || (opts.fromRun && !opts.captureFixture)) && !opts.only && !opts.from) {
    throw new Error("Seed flags require --only <phase> or --from <phase>");
  }
  if (opts.captureFixture && !opts.fromRun) {
    throw new Error("--capture-fixture requires --from-run <runId>");
  }
  if (opts.force && !opts.captureFixture) {
    throw new Error("--force is only valid with --capture-fixture");
  }
}

function buildHeader(
  input: NormalizedStartRunInput,
  workflow?: string,
): ResolvedRunCommand["header"] {
  return {
    task: input.task,
    slug: input.slug,
    tier: input.tier,
    ...(workflow ? { workflow } : {}),
    ...(input.repoPath
      ? { repoPath: input.repoPath, project: basename(input.repoPath) }
      : input.projectName
        ? { project: input.projectName }
        : {}),
  };
}

function requireFromRun(run: RunMeta | undefined): RunMeta {
  if (!run) throw new Error("--capture-fixture requires --from-run <runId>");
  return run;
}

function requirePhase(phase: Phase | undefined): Phase {
  if (!phase) throw new Error("Seed flags require --only <phase> or --from <phase>");
  return phase;
}

function requireWorkflow(workflow: WorkflowManifest | undefined): WorkflowManifest {
  if (!workflow) throw new Error("Workflow definition is required for fixture capture");
  return workflow;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}
