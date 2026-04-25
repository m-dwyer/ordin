import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import { FrontmatterReader } from "./frontmatter";
import type { Skill } from "./skill";

/**
 * Agents are markdown files with YAML frontmatter. Example:
 *
 *   ---
 *   name: planner
 *   runtime: claude-cli
 *   model: claude-opus-4-7     # optional; overrides ordin.config.yaml
 *   tools: [Read, Grep, ...]   # optional; overrides ordin.config.yaml
 *   skills: [rfc-template]     # optional; resolved against skill registry at load time
 *   ---
 *   <markdown body — used as the system prompt>
 *
 * Skills are bound to the agent at load time: `skills:` names are
 * resolved against the loaded skill registry and stored on the agent
 * as fully-resolved `Skill[]`. The agent is the self-describing unit
 * that crosses every boundary below the harness.
 */
export const AgentFrontmatterSchema = z.object({
  name: z.string().min(1),
  runtime: z.string().min(1),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  description: z.string().optional(),
  skills: z.array(z.string()).optional(),
});
export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

export interface Agent {
  readonly name: string;
  readonly runtime: string;
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

export class AgentLoader {
  constructor(private readonly frontmatter: FrontmatterReader = new FrontmatterReader()) {}

  async load(path: string, skills: ReadonlyMap<string, Skill>): Promise<Agent> {
    const raw = await readFile(path, "utf8");
    const { meta, body } = this.frontmatter.read(raw, AgentFrontmatterSchema, path);
    const { skills: skillNames, ...rest } = meta;
    return {
      ...rest,
      skills: resolveSkills(skillNames, skills, path),
      body,
      source: path,
    };
  }

  async loadAll(dir: string, skills: ReadonlyMap<string, Skill>): Promise<Map<string, Agent>> {
    const entries = await readdir(dir, { withFileTypes: true });
    const agents = new Map<string, Agent>();
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name) !== ".md") continue;
      const agent = await this.load(join(dir, entry.name), skills);
      if (agents.has(agent.name)) {
        throw new Error(
          `Duplicate agent name "${agent.name}" (in ${agent.source} and ${agents.get(agent.name)?.source})`,
        );
      }
      agents.set(agent.name, agent);
    }
    return agents;
  }
}

function resolveSkills(
  names: readonly string[] | undefined,
  registry: ReadonlyMap<string, Skill>,
  source: string,
): readonly Skill[] {
  if (!names || names.length === 0) return [];
  const resolved: Skill[] = [];
  for (const name of names) {
    const skill = registry.get(name);
    if (!skill) {
      throw new Error(`Agent at ${source} references unknown skill "${name}"`);
    }
    resolved.push(skill);
  }
  return resolved;
}
