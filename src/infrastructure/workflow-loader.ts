import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { WorkflowManifest, WorkflowManifestSchema } from "../domain/workflow";

export class WorkflowLoader {
  async load(path: string): Promise<WorkflowManifest> {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = parseYaml(raw);
    const result = WorkflowManifestSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid workflow at ${path}: ${result.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const workflow = new WorkflowManifest(result.data);
    this.validate(workflow, path);
    return workflow;
  }

  private validate(workflow: WorkflowManifest, path: string): void {
    const seen = new Set<string>();
    for (const phase of workflow.phases) {
      if (seen.has(phase.id)) {
        throw new Error(`Duplicate phase id "${phase.id}" in workflow at ${path}`);
      }
      seen.add(phase.id);
    }
    const ids = new Set(workflow.phases.map((p) => p.id));
    for (const phase of workflow.phases) {
      if (phase.on_reject && !ids.has(phase.on_reject.goto)) {
        throw new Error(
          `Phase "${phase.id}" has on_reject.goto="${phase.on_reject.goto}" that does not match any phase id in ${path}`,
        );
      }
    }
  }
}
