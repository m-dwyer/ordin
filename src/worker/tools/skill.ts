import type { Skill } from "../../domain/skill";

export interface SkillInput {
  readonly name: string;
}

/**
 * Skill execution is special: the input names a skill from the per-
 * phase skills list. Returns the skill body as a string. Caller is
 * responsible for binding the available skills.
 */
export async function executeSkill(skills: readonly Skill[], input: SkillInput): Promise<string> {
  const skill = skills.find((s) => s.name === input.name);
  if (!skill) {
    const known = skills.map((s) => s.name).join(", ");
    throw new Error(
      `Unknown skill "${input.name}". Available: ${known || "(none for this phase)"}.`,
    );
  }
  return skill.body;
}
