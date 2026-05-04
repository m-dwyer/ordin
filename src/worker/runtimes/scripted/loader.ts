import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ScriptedPlan } from "./types";

/**
 * YAML loader + zod schema for `scripts/<workflow>.yaml` plan files.
 *
 * Plan file shape:
 *
 *   phases:
 *     plan:
 *       steps:
 *         - text: "Reading the workspace"
 *         - tool:
 *             name: Read
 *             input:
 *               file_path: README.md
 *         - tool:
 *             name: Write
 *             input:
 *               file_path: docs/rfcs/{slug}-rfc.md
 *               content: |
 *                 ...
 *
 * Variable substitution (`{cwd}`, `{workspace}`, `{run_id}`, `{phase}`)
 * is applied at dispatch time by ScriptedRuntime — not at load time —
 * so plans stay portable across runs.
 */

const ScriptedToolCallSchema = z.object({
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()).default({}),
});

const ScriptedStepSchema = z
  .object({
    text: z.string().optional(),
    thinking: z.boolean().optional(),
    tool: ScriptedToolCallSchema.optional(),
  })
  .refine((s) => s.text !== undefined || s.thinking !== undefined || s.tool !== undefined, {
    message: "Step must declare at least one of: text, thinking, tool",
  });

const ScriptedPhaseSchema = z.object({
  steps: z.array(ScriptedStepSchema),
});

const PlanFileSchema = z.object({
  phases: z.record(z.string(), ScriptedPhaseSchema),
});

export class ScriptedPlanLoader {
  async load(path: string): Promise<ScriptedPlan> {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = parseYaml(raw);
    const result = PlanFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid scripted plan ${path}: ${result.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    return new Map(Object.entries(result.data.phases));
  }
}
