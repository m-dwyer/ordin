import type { z } from "@hono/zod-openapi";
import type { PhasePreview } from "../domain/phase-preview";
import type { PendingGate } from "../run-service/deferred-gate-prompter";
import type { PendingGateSchema, PhasePreviewSchema } from "./schemas";

/**
 * I/O boundary translation. Internal types use `readonly` arrays
 * (codebase convention); wire types come from `z.infer<typeof Schema>`
 * and are mutable per the OpenAPI/JSON contract. Mappers turn one into
 * the other field-by-field — no casts, no escape hatches.
 */
export type PendingGateWire = z.infer<typeof PendingGateSchema>;
export type PhasePreviewWire = z.infer<typeof PhasePreviewSchema>;

export function toPendingGateWire(gate: PendingGate): PendingGateWire {
  return {
    runId: gate.runId,
    phaseId: gate.phaseId,
    cwd: gate.cwd,
    artefacts: gate.artefacts.map((a) => ({ label: a.label, path: a.path })),
    ...(gate.summary !== undefined ? { summary: gate.summary } : {}),
  };
}

export function toPhasePreviewWire(preview: PhasePreview): PhasePreviewWire {
  return {
    phaseId: preview.phase.id,
    agent: preview.phase.agent,
    gate: preview.phase.gate,
    runtimeName: preview.runtimeName,
    model: preview.prompt.model,
    cwd: preview.prompt.cwd,
    tier: preview.prompt.tier,
    tools: [...preview.prompt.tools],
    skills: preview.prompt.skills.map((s) => s.name),
    systemPrompt: preview.prompt.systemPrompt,
    userPrompt: preview.prompt.userPrompt,
  };
}
