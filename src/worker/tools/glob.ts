import { glob as fsGlob } from "node:fs/promises";
import { relative } from "node:path";

export interface GlobInput {
  readonly pattern: string;
}

export async function executeGlob(cwd: string, input: GlobInput): Promise<string> {
  const matches: string[] = [];
  for await (const entry of fsGlob(input.pattern, { cwd })) {
    matches.push(typeof entry === "string" ? entry : relative(cwd, String(entry)));
    if (matches.length >= 200) break;
  }
  return matches.length > 0 ? matches.join("\n") : "(no matches)";
}
