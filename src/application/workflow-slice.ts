import type { WorkflowManifest } from "../domain/workflow";
import type { StartRunInput } from "./types";

export function workflowForRun(workflow: WorkflowManifest, input: StartRunInput): WorkflowManifest {
  if (input.onlyPhases) return workflow.only(input.onlyPhases);
  if (input.startAt) return workflow.startingAt(input.startAt);
  return workflow;
}
