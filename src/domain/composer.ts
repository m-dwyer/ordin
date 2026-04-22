import type { Agent } from "./agent";
import type { Phase } from "./workflow";

/**
 * Output of the composer. A runtime-neutral representation of what a
 * phase should run: system prompt (agent body), user prompt (task +
 * artefact pointers), tool allowlist, model, and CWD.
 *
 * Kept in the domain layer so runtimes depend on this shape, not vice
 * versa. Orchestrator converts this into the runtime-specific request.
 */
export interface ComposedPrompt {
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly tools: readonly string[];
  readonly model: string;
  readonly cwd: string;
  readonly phaseId: string;
  /** Harness-level hint runtimes use to pick their own quality/effort knobs. */
  readonly tier: "S" | "M" | "L";
  readonly freshContext: boolean;
  readonly softTokenBudget?: number;
}

/**
 * Per-phase defaults from ordin.config.yaml. Agent frontmatter wins
 * where specified, then workflow phase.budgets, then phase defaults.
 */
export interface PhaseDefaults {
  readonly model: string;
  readonly allowedTools: readonly string[];
  readonly softTokenBudget?: number;
}

export interface ComposeInput {
  readonly phase: Phase;
  readonly agent: Agent;
  readonly defaults: PhaseDefaults;
  readonly task: string;
  readonly cwd: string;
  readonly tier: "S" | "M" | "L";
  /**
   * Artefacts the phase should read. Listed as paths so the agent
   * consults them via its Read tool rather than inlining contents.
   */
  readonly artefactInputs?: readonly ArtefactPointer[];
  /**
   * Artefacts the phase is expected to produce. Shown to the agent
   * so the output contract is explicit in the prompt.
   */
  readonly artefactOutputs?: readonly ArtefactPointer[];
  /**
   * Skills the agent should consider. Bodies are not inlined for
   * runtimes with native skill discovery — names + descriptions suffice.
   */
  readonly skills?: readonly SkillHint[];
  /** Optional prior-iteration context (e.g. reviewer findings on a re-Build). */
  readonly iterationContext?: string;
}

export interface ArtefactPointer {
  readonly label: string;
  readonly path: string;
  readonly description?: string;
}

export interface SkillHint {
  readonly name: string;
  readonly description: string;
}

export class Composer {
  compose(input: ComposeInput): ComposedPrompt {
    const model = input.agent.model ?? input.defaults.model;
    const tools = input.agent.tools ?? input.defaults.allowedTools;

    return {
      systemPrompt: input.agent.body,
      userPrompt: this.buildUserPrompt(input),
      tools: [...tools],
      model,
      cwd: input.cwd,
      phaseId: input.phase.id,
      tier: input.tier,
      freshContext: input.phase.fresh_context ?? true,
      softTokenBudget: input.phase.budgets?.soft_tokens ?? input.defaults.softTokenBudget,
    };
  }

  private buildUserPrompt(input: ComposeInput): string {
    const sections: string[] = [];
    sections.push(`# Phase: ${input.phase.id}`);
    sections.push("");
    sections.push("## Task");
    sections.push(input.task.trim());

    if (input.artefactInputs && input.artefactInputs.length > 0) {
      sections.push("");
      sections.push("## Read these artefacts before starting");
      for (const a of input.artefactInputs) {
        const desc = a.description ? ` — ${a.description}` : "";
        sections.push(`- **${a.label}**: \`${a.path}\`${desc}`);
      }
    }

    if (input.artefactOutputs && input.artefactOutputs.length > 0) {
      sections.push("");
      sections.push("## Produce these artefacts");
      for (const a of input.artefactOutputs) {
        const desc = a.description ? ` — ${a.description}` : "";
        sections.push(`- **${a.label}**: \`${a.path}\`${desc}`);
      }
    }

    if (input.skills && input.skills.length > 0) {
      sections.push("");
      sections.push("## Available skills");
      sections.push(
        "Progressive disclosure: skill bodies load on demand when you determine they're relevant.",
      );
      for (const s of input.skills) {
        sections.push(`- **${s.name}** — ${s.description}`);
      }
    }

    if (input.iterationContext) {
      sections.push("");
      sections.push("## Prior-iteration context");
      sections.push(input.iterationContext.trim());
    }

    sections.push("");
    sections.push(`Working directory: \`${input.cwd}\``);

    return sections.join("\n");
  }
}
