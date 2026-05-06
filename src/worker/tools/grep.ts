import { glob as fsGlob, readFile } from "node:fs/promises";
import { relative } from "node:path";
import { abs } from "./paths";

export interface GrepInput {
  readonly pattern: string;
  readonly path?: string;
}

export async function executeGrep(cwd: string, input: GrepInput): Promise<string> {
  const regex = new RegExp(input.pattern);
  const scope = input.path && input.path.length > 0 ? input.path : "**/*";
  const hits: string[] = [];
  outer: for await (const entry of fsGlob(scope, { cwd })) {
    const rel = typeof entry === "string" ? entry : relative(cwd, String(entry));
    let content: string;
    try {
      content = await readFile(abs(cwd, rel), "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i] ?? "")) {
        hits.push(`${rel}:${i + 1}: ${lines[i]}`);
        if (hits.length >= 200) break outer;
      }
    }
  }
  return hits.length > 0 ? hits.join("\n") : "(no matches)";
}
