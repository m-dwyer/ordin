import type { Phase, WorkflowManifest } from "../domain/workflow";

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
export function createExecutionPlan(manifest: WorkflowManifest): ExecutionPlan {
  const phases = manifest.phases;
  validateUniquePhaseIds(manifest);
  validateRejectTargetsResolve(manifest);
  const rejecters = phases.filter((phase) => phase.on_reject);

  if (rejecters.length === 0) {
    return { kind: "linear", phases };
  }

  if (rejecters.length > 1) {
    throw new Error(
      `Workflow "${manifest.name}" supports at most one on_reject phase; found ${rejecters.length}`,
    );
  }

  const rejecter = rejecters[0] as Phase;
  const rejecterIndex = phases.indexOf(rejecter);
  const targetIndex = phases.findIndex((phase) => phase.id === rejecter.on_reject?.goto);

  if (targetIndex < 0 || targetIndex >= rejecterIndex) {
    throw new Error(
      `on_reject.goto must target an earlier phase (phase "${rejecter.id}" -> "${rejecter.on_reject?.goto}")`,
    );
  }

  return {
    kind: "single-retry-loop",
    beforeLoop: phases.slice(0, targetIndex),
    loop: phases.slice(targetIndex, rejecterIndex + 1),
    afterLoop: phases.slice(rejecterIndex + 1),
    rejecter,
    maxIterations: rejecter.on_reject?.max_iterations ?? 1,
  };
}

function validateUniquePhaseIds(manifest: WorkflowManifest): void {
  const seen = new Set<string>();
  for (const phase of manifest.phases) {
    if (seen.has(phase.id)) {
      throw new Error(`Duplicate phase id "${phase.id}" in workflow "${manifest.name}"`);
    }
    seen.add(phase.id);
  }
}

function validateRejectTargetsResolve(manifest: WorkflowManifest): void {
  const ids = new Set(manifest.phases.map((phase) => phase.id));
  for (const phase of manifest.phases) {
    if (phase.on_reject && !ids.has(phase.on_reject.goto)) {
      throw new Error(
        `Phase "${phase.id}" has on_reject.goto="${phase.on_reject.goto}" that does not match any phase id in workflow "${manifest.name}"`,
      );
    }
  }
}
