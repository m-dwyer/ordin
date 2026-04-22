import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import type { ZodType } from "zod";

/**
 * Wrapper around gray-matter that validates frontmatter against a zod
 * schema and routes YAML through our primary `yaml` dep (so we don't ship
 * two YAML parsers — gray-matter bundles js-yaml@3 by default).
 */
export interface FrontmatterDoc<T> {
  readonly meta: T;
  readonly body: string;
}

export class FrontmatterReader {
  private static readonly YAML_ENGINES = {
    // gray-matter types expect `object`; YAML frontmatter always parses to one.
    yaml: (input: string): object => (parseYaml(input) ?? {}) as object,
  };

  read<T>(raw: string, schema: ZodType<T>, source: string): FrontmatterDoc<T> {
    const parsed = matter(raw, { engines: FrontmatterReader.YAML_ENGINES });
    if (!parsed.matter.trim()) {
      throw new Error(`${source} is missing a YAML frontmatter block ("---" fenced)`);
    }
    const result = schema.safeParse(parsed.data);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new Error(`Invalid frontmatter in ${source}: ${issues}`);
    }
    return { meta: result.data, body: parsed.content.trim() };
  }
}
