import type { Agent } from "./agent";
import type { ArtefactPointer, ComposedPrompt, Feedback } from "./composer";
import { Composer } from "./composer";
import type { HarnessConfig } from "./config";
import {
  type Phase,
  resolveArtefactPath,
  resolvePhaseRuntime,
  resolvePromptDefaults,
  type WorkflowManifest,
} from "./workflow";

/**
 * `PhasePreview` is the unit of work both `--dry-run` and real runs
 * consume. It captures everything needed to invoke (or print) one
 * phase: the phase definition, the runtime name resolved against
 * workflow + config defaults, and the fully composed prompt.
 *
 * Sharing this type across both paths means there is exactly one
 * composition pipeline. Dry-run prints the prompt; real run hands
 * the same prompt to `PhaseRunner` for invocation. On `on_reject`
 * retries, the engine re-prepares the looped phase with feedback —
 * composition is cheap string assembly, so re-running it is fine.
 */
export interface PhasePreview {
  readonly phase: Phase;
  readonly runtimeName: string;
  readonly prompt: ComposedPrompt;
}

export interface PreparePhaseInput {
  readonly phase: Phase;
  readonly agent: Agent;
  readonly workflow: WorkflowManifest;
  readonly config: HarnessConfig;
  readonly task: string;
  readonly cwd: string;
  readonly tier: "S" | "M" | "L";
  readonly artefactInputs: readonly ArtefactPointer[];
  readonly artefactOutputs: readonly ArtefactPointer[];
  readonly feedback?: Feedback;
}

/**
 * Resolves a phase's declared artefact contracts (with `{slug}`
 * placeholders) to concrete `ArtefactPointer`s the engine threads
 * through prompt composition and on-disk verification. Same helper
 * used by every consumer so contract → pointer is a single rule.
 */
export function resolveArtefacts(
  contracts: Phase["inputs"] | Phase["outputs"],
  slug: string,
): readonly ArtefactPointer[] {
  if (!contracts) return [];
  return contracts.map((contract) => ({
    label: contract.label,
    path: resolveArtefactPath(contract, slug),
    ...(contract.description ? { description: contract.description } : {}),
  }));
}

export class PhasePreparer {
  private readonly composer = new Composer();

  prepare(input: PreparePhaseInput): PhasePreview {
    const runtimeName = resolvePhaseRuntime(
      input.phase,
      input.workflow,
      input.config.defaultRuntime,
    );
    const defaults = resolvePromptDefaults(
      input.phase,
      input.workflow,
      input.config.tierModel(input.tier),
      input.config.defaultModel,
      input.config.allowedTools,
    );
    const prompt = this.composer.compose({
      phase: input.phase,
      agent: input.agent,
      defaults,
      task: input.task,
      cwd: input.cwd,
      tier: input.tier,
      artefactInputs: input.artefactInputs,
      artefactOutputs: input.artefactOutputs,
      ...(input.feedback ? { feedback: input.feedback } : {}),
    });
    return { phase: input.phase, runtimeName, prompt };
  }
}
