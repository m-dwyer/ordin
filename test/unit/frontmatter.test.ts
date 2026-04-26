import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FrontmatterReader } from "../../src/infrastructure/frontmatter";

describe("FrontmatterReader", () => {
  const reader = new FrontmatterReader();
  const schema = z.object({ name: z.string(), flag: z.boolean().optional() });

  it("parses YAML frontmatter and returns trimmed body", () => {
    const raw = "---\nname: foo\nflag: true\n---\n\nbody text here\n";
    const { meta, body } = reader.read(raw, schema, "test");
    expect(meta).toEqual({ name: "foo", flag: true });
    expect(body).toBe("body text here");
  });

  it("throws when frontmatter is missing", () => {
    expect(() => reader.read("no fences here", schema, "missing.md")).toThrow(
      /missing a YAML frontmatter block/,
    );
  });

  it("surfaces schema errors with the source path", () => {
    const raw = "---\nname: 5\n---\nbody";
    expect(() => reader.read(raw, schema, "bad.md")).toThrow(/Invalid frontmatter in bad\.md/);
  });
});
