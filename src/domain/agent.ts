import { z } from "zod";
import type { Skill } from "./skill";

/**
 * Agents are markdown files with YAML frontmatter. Example:
 *
 *   ---
 *   name: planner
 *   model: claude-opus-4-7     # optional; overrides ordin.config.yaml
 *   tools: [Read, Grep, ...]   # optional; overrides ordin.config.yaml
 *   skills: [rfc-template]     # optional; resolved against skill registry at load time
 *   ---
 *   <markdown body — used as the system prompt>
 *
 * Runtime is a deployment concern (chosen at the workflow or phase
 * level), not an agent property — agents are runtime-agnostic.
 *
 * Skills are bound to the agent at load time: `skills:` names are
 * resolved against the loaded skill registry and stored on the agent
 * as fully-resolved `Skill[]`. The agent is the self-describing unit
 * that crosses every boundary below the harness.
 */
export const AgentFrontmatterSchema = z.object({
  name: z.string().min(1),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  description: z.string().optional(),
  skills: z.array(z.string()).optional(),
});
export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

export interface Agent {
  readonly name: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly description?: string;
  /** Skills this agent may invoke, fully resolved at load time. */
  readonly skills: readonly Skill[];
  /** Markdown body after frontmatter — used as the system prompt. */
  readonly body: string;
  /** Absolute path the agent was loaded from. */
  readonly source: string;
}
