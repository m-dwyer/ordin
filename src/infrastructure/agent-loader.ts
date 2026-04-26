import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { type Agent, AgentFrontmatterSchema } from "../domain/agent";
import type { Skill } from "../domain/skill";
import { FrontmatterReader } from "./frontmatter";

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
