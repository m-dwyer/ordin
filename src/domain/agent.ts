import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { z } from "zod";
import { FrontmatterReader } from "./frontmatter";

/**
 * Agents are markdown files with YAML frontmatter. Example:
 *
 *   ---
 *   name: planner
 *   runtime: claude-cli
 *   model: claude-opus-4-7     # optional; overrides ordin.config.yaml
 *   tools: [Read, Grep, ...]   # optional; overrides ordin.config.yaml
 *   ---
 *   <markdown body — used as the system prompt>
 */
export const AgentFrontmatterSchema = z.object({
  name: z.string().min(1),
  runtime: z.string().min(1),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  description: z.string().optional(),
});
export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

export interface Agent {
  readonly name: string;
  readonly runtime: string;
  readonly model?: string;
  readonly tools?: readonly string[];
  readonly description?: string;
  /** Markdown body after frontmatter — used as the system prompt. */
  readonly body: string;
  /** Absolute path the agent was loaded from. */
  readonly source: string;
}

export class AgentLoader {
  constructor(private readonly frontmatter: FrontmatterReader = new FrontmatterReader()) {}

  async load(path: string): Promise<Agent> {
    const raw = await readFile(path, "utf8");
    const { meta, body } = this.frontmatter.read(raw, AgentFrontmatterSchema, path);
    return { ...meta, body, source: path };
  }

  async loadAll(dir: string): Promise<Map<string, Agent>> {
    const entries = await readdir(dir, { withFileTypes: true });
    const agents = new Map<string, Agent>();
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name) !== ".md") continue;
      const agent = await this.load(join(dir, entry.name));
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
