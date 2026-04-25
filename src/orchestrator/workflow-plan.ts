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
 * Engine-neutral topology analysis. Engines consume this plan rather
 * than each re-validating workflow graph constraints in adapter code.
 */
export function createExecutionPlan(manifest: WorkflowManifest): ExecutionPlan {
  const phases = manifest.phases;
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
