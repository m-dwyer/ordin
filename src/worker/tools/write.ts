import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { abs } from "./paths";

export interface WriteInput {
  readonly file_path: string;
  readonly content: string;
}

export async function executeWrite(cwd: string, input: WriteInput): Promise<string> {
  const p = abs(cwd, input.file_path);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, input.content, "utf8");
  return `Wrote ${input.content.length} bytes to ${input.file_path}`;
}
