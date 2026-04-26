import { z } from "@hono/zod-openapi";

export const TierSchema = z.enum(["S", "M", "L"]).openapi("Tier");

export const GateKindSchema = z.enum(["human", "auto", "pre-commit"]).openapi("GateKind");

export const StartRunRequestSchema = z
  .object({
    task: z.string().min(1),
    slug: z.string().min(1),
    projectName: z.string().optional(),
    repoPath: z.string().optional(),
    tier: TierSchema.optional(),
    startAt: z.string().optional(),
    onlyPhases: z.array(z.string()).optional(),
  })
  .openapi("StartRunRequest");

export const RunIdResponseSchema = z.object({ runId: z.string() }).openapi("RunIdResponse");

export const GateDecisionSchema = z
  .discriminatedUnion("status", [
    z.object({
      status: z.literal("approved"),
      note: z.string().optional(),
    }),
    z.object({
      status: z.literal("rejected"),
      reason: z.string(),
    }),
  ])
  .openapi("GateDecision");

export const ResolveGateResponseSchema = z
  .object({ resolved: z.boolean() })
  .openapi("ResolveGateResponse");

export const ArtefactPointerSchema = z
  .object({ label: z.string(), path: z.string() })
  .openapi("ArtefactPointer");

export const PendingGateSchema = z
  .object({
    runId: z.string(),
    phaseId: z.string(),
    cwd: z.string(),
    artefacts: z.array(ArtefactPointerSchema),
    summary: z.string().optional(),
  })
  .openapi("PendingGate");

export const RunStatusSchema = z
  .enum(["running", "completed", "failed", "halted"])
  .openapi("RunStatus");

export const PhaseStatusSchema = z
  .enum(["running", "completed", "failed", "rejected"])
  .openapi("PhaseStatus");

export const PhaseMetaSchema = z
  .object({
    phaseId: z.string(),
    startedAt: z.string(),
    completedAt: z.string().optional(),
    status: PhaseStatusSchema,
    iteration: z.number(),
    runtime: z.string().optional(),
    model: z.string().optional(),
    durationMs: z.number().optional(),
    exitCode: z.number().optional(),
    gateDecision: z.enum(["approved", "rejected", "auto"]).optional(),
    gateNote: z.string().optional(),
    transcriptPath: z.string().optional(),
    error: z.string().optional(),
    tokens: z
      .object({
        input: z.number(),
        output: z.number(),
        cacheReadInput: z.number(),
        cacheCreationInput: z.number(),
      })
      .optional(),
  })
  .openapi("PhaseMeta");

export const RunMetaSchema = z
  .object({
    runId: z.string(),
    workflow: z.string(),
    tier: TierSchema,
    task: z.string(),
    slug: z.string(),
    repo: z.string(),
    startedAt: z.string(),
    completedAt: z.string().optional(),
    status: RunStatusSchema,
    phases: z.array(PhaseMetaSchema),
  })
  .openapi("RunMeta");

export const PhasePreviewSchema = z
  .object({
    phaseId: z.string(),
    agent: z.string(),
    gate: GateKindSchema,
    runtimeName: z.string(),
    model: z.string(),
    cwd: z.string(),
    tier: TierSchema,
    tools: z.array(z.string()),
    skills: z.array(z.string()),
    systemPrompt: z.string(),
    userPrompt: z.string(),
  })
  .openapi("PhasePreview");

export const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
