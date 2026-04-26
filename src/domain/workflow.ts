import { z } from "zod";

/**
 * Workflow schema — see harness-plan.md Appendix C.
 * YAML orders phases, declares orchestration concerns, and optionally
 * declares per-phase artefact `inputs` / `outputs` (paths support a
 * `{slug}` placeholder resolved at run time). When a phase omits those
 * declarations the agent's prompt is the sole source of truth — engines
 * just don't thread artefacts for that phase.
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

export const PromptDefaultsSchema = z.object({
  model: z.string().min(1).optional(),
  allowed_tools: z.array(z.string()).optional(),
  budgets: BudgetsSchema.optional(),
});
export type PromptDefaults = z.infer<typeof PromptDefaultsSchema>;

export const ArtefactContractSchema = z.object({
  label: z.string().min(1),
  path: z.string().min(1),
  description: z.string().optional(),
});
export type ArtefactContract = z.infer<typeof ArtefactContractSchema>;

export const PhaseSchema = z.object({
  id: z.string().min(1),
  agent: z.string().min(1),
  runtime: z.string().min(1).optional(),
  gate: GateKindSchema,
  model: z.string().min(1).optional(),
  allowed_tools: z.array(z.string()).optional(),
  fresh_context: z.boolean().optional(),
  on_reject: OnRejectSchema.optional(),
  budgets: BudgetsSchema.optional(),
  inputs: z.array(ArtefactContractSchema).optional(),
  outputs: z.array(ArtefactContractSchema).optional(),
});
export type Phase = z.infer<typeof PhaseSchema>;

/**
 * Substitute `{slug}` in an `ArtefactContract.path` with the run's
 * slug. Other placeholders are left untouched (forward-compatible
 * with future ones if needed).
 */
export function resolveArtefactPath(contract: ArtefactContract, slug: string): string {
  return contract.path.replace(/\{slug\}/g, slug);
}

export const WorkflowManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.union([z.string(), z.number()]).transform((v) => String(v)),
  runtime: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  allowed_tools: z.array(z.string()).optional(),
  budgets: BudgetsSchema.optional(),
  phases: z.array(PhaseSchema).min(1),
});
export const WorkflowSchema = WorkflowManifestSchema;
type WorkflowManifestShape = z.infer<typeof WorkflowManifestSchema>;

export class WorkflowManifest {
  readonly name: string;
  readonly description?: string;
  readonly version: string;
  readonly runtime?: string;
  readonly model?: string;
  readonly allowedTools?: readonly string[];
  readonly budgets?: Budgets;
  readonly phases: readonly Phase[];

  constructor(shape: WorkflowManifestShape) {
    this.name = shape.name;
    this.description = shape.description;
    this.version = shape.version;
    this.runtime = shape.runtime;
    this.model = shape.model;
    this.allowedTools = shape.allowed_tools;
    this.budgets = shape.budgets;
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
   * Return a new manifest that begins at `phaseId`. Earlier phases are
   * dropped; on_reject edges that point into the dropped range are
   * preserved only if the target still exists in the slice.
   */
  startingAt(phaseId: string): WorkflowManifest {
    const idx = this.phases.findIndex((p) => p.id === phaseId);
    if (idx < 0) {
      throw new Error(`Phase "${phaseId}" not found in workflow "${this.name}"`);
    }
    if (idx === 0) return this;
    return this.buildSubWorkflow(stripRejectsOutsideSelection(this.phases.slice(idx)));
  }

  /**
   * Return a new manifest containing only the named phases, preserving
   * their workflow-defined order. on_reject edges pointing outside the
   * selection are stripped (we can't jump to a phase we're not running).
   */
  only(phaseIds: readonly string[]): WorkflowManifest {
    const keep = new Set(phaseIds);
    const kept = this.phases.filter((p) => keep.has(p.id));
    if (kept.length === 0) {
      throw new Error(
        `No matching phases found for ${JSON.stringify([...phaseIds])} in workflow "${this.name}"`,
      );
    }
    return this.buildSubWorkflow(stripRejectsOutsideSelection(kept));
  }

  private buildSubWorkflow(phases: Phase[]): WorkflowManifest {
    return new WorkflowManifest({
      name: this.name,
      ...(this.description ? { description: this.description } : {}),
      version: this.version,
      ...(this.runtime ? { runtime: this.runtime } : {}),
      ...(this.model ? { model: this.model } : {}),
      ...(this.allowedTools ? { allowed_tools: [...this.allowedTools] } : {}),
      ...(this.budgets ? { budgets: this.budgets } : {}),
      phases,
    });
  }
}

export function resolvePhaseRuntime(
  phase: Phase,
  workflow: WorkflowManifest,
  agentRuntime: string | undefined,
  defaultRuntime: string,
): string {
  return phase.runtime ?? workflow.runtime ?? agentRuntime ?? defaultRuntime;
}

export interface ResolvedPromptDefaults {
  readonly model: string;
  readonly allowedTools: readonly string[];
  readonly softTokenBudget?: number;
}

export function resolvePromptDefaults(
  phase: Phase,
  workflow: WorkflowManifest,
  tierModel: string | undefined,
  globalModel: string,
  globalAllowedTools: readonly string[],
): ResolvedPromptDefaults {
  const softTokenBudget = phase.budgets?.soft_tokens ?? workflow.budgets?.soft_tokens;
  return {
    model: phase.model ?? workflow.model ?? tierModel ?? globalModel,
    allowedTools: phase.allowed_tools ?? workflow.allowedTools ?? globalAllowedTools,
    ...(softTokenBudget !== undefined ? { softTokenBudget } : {}),
  };
}

export type Workflow = WorkflowManifest;

function stripOnReject(phase: Phase): Phase {
  const { on_reject: _omit, ...rest } = phase;
  return rest;
}

function stripRejectsOutsideSelection(phases: readonly Phase[]): Phase[] {
  const allowed = new Set(phases.map((p) => p.id));
  return phases.map((p) => (p.on_reject && !allowed.has(p.on_reject.goto) ? stripOnReject(p) : p));
}
