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
    return new WorkflowManifest(result.data);
  }
}
