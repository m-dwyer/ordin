import { readFile, writeFile } from "node:fs/promises";
import { abs } from "./paths";

export interface EditInput {
  readonly file_path: string;
  readonly old_string: string;
  readonly new_string: string;
}

export async function executeEdit(cwd: string, input: EditInput): Promise<string> {
  const p = abs(cwd, input.file_path);
  const original = await readFile(p, "utf8");
  const count = original.split(input.old_string).length - 1;
  if (count === 0) throw new Error(`old_string not found in ${input.file_path}`);
  if (count > 1) throw new Error(`old_string appears ${count}× in ${input.file_path}`);
  await writeFile(p, original.replace(input.old_string, input.new_string), "utf8");
  return `Edited ${input.file_path}`;
}
