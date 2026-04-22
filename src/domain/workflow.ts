import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Workflow schema — see harness-plan.md Appendix C.
 * YAML only orders phases and declares orchestration concerns;
 * implicit I/O: the agent prompt declares what to read and write.
 */
export const GateKindSchema = z.enum(["human", "auto", "pre-commit"]);
export type GateKind = z.infer<typeof GateKindSchema>;

export const OnRejectSchema = z.object({
  goto: z.string(),
  max_iterations: z.number().int().positive(),
});
export type OnReject = z.infer<typeof OnRejectSchema>;

export const BudgetsSchema = z.object({
  soft_tokens: z.number().int().positive().optional(),
});
export type Budgets = z.infer<typeof BudgetsSchema>;

export const PhaseSchema = z.object({
  id: z.string().min(1),
  agent: z.string().min(1),
  runtime: z.string().min(1),
  gate: GateKindSchema,
  fresh_context: z.boolean().optional(),
  on_reject: OnRejectSchema.optional(),
  budgets: BudgetsSchema.optional(),
});
export type Phase = z.infer<typeof PhaseSchema>;

export const WorkflowSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.union([z.string(), z.number()]).transform((v) => String(v)),
  phases: z.array(PhaseSchema).min(1),
});
type WorkflowShape = z.infer<typeof WorkflowSchema>;

export class Workflow {
  readonly name: string;
  readonly description?: string;
  readonly version: string;
  readonly phases: readonly Phase[];

  constructor(shape: WorkflowShape) {
    this.name = shape.name;
    this.description = shape.description;
    this.version = shape.version;
    this.phases = shape.phases;
  }

  findPhase(id: string): Phase {
    const phase = this.phases.find((p) => p.id === id);
    if (!phase) {
      throw new Error(`Phase "${id}" not found in workflow "${this.name}"`);
    }
    return phase;
  }

  firstPhase(): Phase {
    const first = this.phases[0];
    if (!first) throw new Error(`Workflow "${this.name}" has no phases`);
    return first;
  }

  nextPhase(id: string): Phase | undefined {
    const idx = this.phases.findIndex((p) => p.id === id);
    if (idx < 0) {
      throw new Error(`Phase "${id}" not found in workflow "${this.name}"`);
    }
    return this.phases[idx + 1];
  }

  /**
   * Return a new Workflow that begins at `phaseId`. Earlier phases are
   * dropped; on_reject edges that point into the dropped range are
   * preserved only if the target still exists in the slice.
   */
  startingAt(phaseId: string): Workflow {
    const idx = this.phases.findIndex((p) => p.id === phaseId);
    if (idx < 0) {
      throw new Error(`Phase "${phaseId}" not found in workflow "${this.name}"`);
    }
    if (idx === 0) return this;
    return this.buildSubWorkflow(this.phases.slice(idx));
  }

  /**
   * Return a new Workflow containing only the named phases, preserving
   * their workflow-defined order. on_reject edges pointing outside the
   * selection are stripped (we can't jump to a phase we're not running).
   */
  only(phaseIds: readonly string[]): Workflow {
    const keep = new Set(phaseIds);
    const kept = this.phases.filter((p) => keep.has(p.id));
    if (kept.length === 0) {
      throw new Error(
        `No matching phases found for ${JSON.stringify([...phaseIds])} in workflow "${this.name}"`,
      );
    }
    const allowed = new Set(kept.map((p) => p.id));
    const trimmed = kept.map((p) =>
      p.on_reject && !allowed.has(p.on_reject.goto) ? stripOnReject(p) : p,
    );
    return this.buildSubWorkflow(trimmed);
  }

  private buildSubWorkflow(phases: Phase[]): Workflow {
    return new Workflow({
      name: this.name,
      ...(this.description ? { description: this.description } : {}),
      version: this.version,
      phases,
    });
  }
}

function stripOnReject(phase: Phase): Phase {
  const { on_reject: _omit, ...rest } = phase;
  return rest;
}

export class WorkflowLoader {
  async load(path: string): Promise<Workflow> {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = parseYaml(raw);
    const result = WorkflowSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid workflow at ${path}: ${result.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const workflow = new Workflow(result.data);
    this.validate(workflow, path);
    return workflow;
  }

  private validate(workflow: Workflow, path: string): void {
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
