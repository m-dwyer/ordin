import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type Skill, SkillFrontmatterSchema } from "../domain/skill";
import { FrontmatterReader } from "./frontmatter";

export class SkillLoader {
  constructor(private readonly frontmatter: FrontmatterReader = new FrontmatterReader()) {}

  async load(path: string): Promise<Skill> {
    const raw = await readFile(path, "utf8");
    const { meta, body } = this.frontmatter.read(raw, SkillFrontmatterSchema, path);
    return {
      name: meta.name,
      description: meta.description,
      body,
      source: path,
    };
  }

  async loadAll(dir: string): Promise<Map<string, Skill>> {
    const entries = await readdir(dir, { withFileTypes: true });
    const skills = new Map<string, Skill>();
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(dir, entry.name, "SKILL.md");
      if (!(await fileExists(skillFile))) continue;
      const skill = await this.load(skillFile);
      if (skills.has(skill.name)) {
        throw new Error(
          `Duplicate skill name "${skill.name}" (in ${skill.source} and ${skills.get(skill.name)?.source})`,
        );
      }
      skills.set(skill.name, skill);
    }
    return skills;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
