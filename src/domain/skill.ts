import { z } from "zod";

/**
 * Skills are hand-authored markdown files at skills/<name>/SKILL.md.
 *
 * The bundled `.claude-plugin/plugin.json` is passed to claude via
 * `--plugin-dir` per run; Claude Code's native progressive disclosure
 * picks the skills up — only SKILL.md descriptions enter the initial
 * prompt; bodies load on demand when the agent decides they're relevant.
 *
 * For runtimes without native skill discovery, the composer inlines
 * selected skill bodies. Keeping the loader here keeps that swap local.
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
