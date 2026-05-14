import type { Phase, WorkflowManifest } from "../domain/workflow";
import type { RunMeta } from "./run-store";

export interface WorkflowDiagnostic {
  readonly code:
    | "duplicate_phase_id"
    | "missing_reject_target"
    | "multiple_rejecters"
    | "invalid_reject_target";
  readonly message: string;
  readonly phaseId?: string;
}

export class WorkflowValidationError extends Error {
  constructor(readonly diagnostics: readonly WorkflowDiagnostic[]) {
    super(diagnostics.map((d) => d.message).join("; "));
    this.name = "WorkflowValidationError";
  }
}

export type ExecutionPlan =
  | {
      readonly kind: "linear";
      readonly phases: readonly Phase[];
    }
  | {
      readonly kind: "single-retry-loop";
      readonly beforeLoop: readonly Phase[];
      readonly loop: readonly Phase[];
      readonly afterLoop: readonly Phase[];
      readonly rejecter: Phase;
      readonly maxIterations: number;
    };

/**
 * Engine-neutral workflow compiler. This is the single executable
 * validation boundary: loaders parse manifests, but this function
 * decides whether a manifest can run and returns the topology plan
 * engines consume.
 */
export function compileWorkflowPlan(manifest: WorkflowManifest): ExecutionPlan {
  const phases = manifest.phases;
  const diagnostics = collectWorkflowDiagnostics(manifest);
  if (diagnostics.length > 0) {
    throw new WorkflowValidationError(diagnostics);
  }

  const rejecters = phases.filter((phase) => phase.on_reject);

  if (rejecters.length === 0) {
    return { kind: "linear", phases };
  }
  const rejecter = rejecters[0] as Phase;
  const rejecterIndex = phases.indexOf(rejecter);
  const targetIndex = phases.findIndex((phase) => phase.id === rejecter.on_reject?.goto);

  return {
    kind: "single-retry-loop",
    beforeLoop: phases.slice(0, targetIndex),
    loop: phases.slice(targetIndex, rejecterIndex + 1),
    afterLoop: phases.slice(rejecterIndex + 1),
    rejecter,
    maxIterations: rejecter.on_reject?.max_iterations ?? 1,
  };
}

/**
 * Walk an execution plan against the on-disk RunMeta and return the
 * next phase id the engine would invoke, or undefined if the run has
 * completed every phase the plan reaches. Engine-neutral plan
 * traversal — both MastraEngine and any future engine compiling to
 * the same plan shape share this. The resume planner uses this to
 * decide where to re-enter after a mid-run crash.
 *
 * "Completed" here means the latest entry for a phase in
 * `runMeta.phases` has `status: "completed"` *and* its gate decision
 * is approved or auto-approved (rejections trigger looping, not
 * forward progress).
 *
 * Loop case: if a single-retry-loop's rejecter has `status: "rejected"`
 * as its latest entry, the next phase is the rejecter's `on_reject.goto`,
 * not the rejecter itself. Without this, a crash between rejection and
 * the start of the next loop iteration would resume by re-running the
 * rejecter — wrong, since the loop hasn't actually retried yet.
 */
export function nextPhase(plan: ExecutionPlan, runMeta: RunMeta): string | undefined {
  const latest = latestPhaseStatuses(runMeta);
  if (
    plan.kind === "single-retry-loop" &&
    latest.get(plan.rejecter.id) === "rejected" &&
    plan.rejecter.on_reject
  ) {
    return plan.rejecter.on_reject.goto;
  }
  const traversal =
    plan.kind === "linear" ? plan.phases : [...plan.beforeLoop, ...plan.loop, ...plan.afterLoop];
  for (const phase of traversal) {
    if (latest.get(phase.id) !== "completed") return phase.id;
  }
  return undefined;
}

function latestPhaseStatuses(
  runMeta: RunMeta,
): ReadonlyMap<string, "completed" | "failed" | "rejected" | "running"> {
  const latest = new Map<string, "completed" | "failed" | "rejected" | "running">();
  for (const entry of runMeta.phases) {
    latest.set(entry.phaseId, entry.status);
  }
  return latest;
}

export function collectWorkflowDiagnostics(
  manifest: WorkflowManifest,
): readonly WorkflowDiagnostic[] {
  const diagnostics: WorkflowDiagnostic[] = [];
  const seen = new Set<string>();
  for (const phase of manifest.phases) {
    if (seen.has(phase.id)) {
      diagnostics.push({
        code: "duplicate_phase_id",
        phaseId: phase.id,
        message: `Duplicate phase id "${phase.id}" in workflow "${manifest.name}"`,
      });
    }
    seen.add(phase.id);
  }

  const ids = new Set(manifest.phases.map((phase) => phase.id));
  for (const phase of manifest.phases) {
    if (phase.on_reject && !ids.has(phase.on_reject.goto)) {
      diagnostics.push({
        code: "missing_reject_target",
        phaseId: phase.id,
        message: `Phase "${phase.id}" has on_reject.goto="${phase.on_reject.goto}" that does not match any phase id in workflow "${manifest.name}"`,
      });
    }
  }

  const rejecters = manifest.phases.filter((phase) => phase.on_reject);
  if (rejecters.length > 1) {
    diagnostics.push({
      code: "multiple_rejecters",
      message: `Workflow "${manifest.name}" supports at most one on_reject phase; found ${rejecters.length}`,
    });
  }

  if (rejecters.length === 1) {
    const rejecter = rejecters[0] as Phase;
    const rejecterIndex = manifest.phases.indexOf(rejecter);
    const targetIndex = manifest.phases.findIndex((phase) => phase.id === rejecter.on_reject?.goto);
    if (targetIndex >= 0 && targetIndex >= rejecterIndex) {
      diagnostics.push({
        code: "invalid_reject_target",
        phaseId: rejecter.id,
        message: `on_reject.goto must target an earlier phase (phase "${rejecter.id}" -> "${rejecter.on_reject?.goto}")`,
      });
    }
  }

  return diagnostics;
}
