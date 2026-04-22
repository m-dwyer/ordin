import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { FrontmatterReader } from "./frontmatter";

/**
 * Skills are hand-authored markdown files at skills/<name>/SKILL.md.
 *
 * For `ClaudeCliRuntime`, `harness install` symlinks skills into
 * ~/.claude/skills/harness/<name>/ so Claude Code's native progressive
 * disclosure picks them up — only SKILL.md descriptions enter the initial
 * prompt; bodies load on demand when the agent decides they're relevant.
 *
 * For runtimes without native skill discovery (future SdkRuntime), the
 * composer inlines selected skill bodies. Keeping the loader here keeps
 * that swap local.
 */
export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly source: string;
}

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

  /**
   * Scan a skills directory of form `<dir>/<skill-name>/SKILL.md` and
   * return a map keyed by declared skill name.
   */
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
