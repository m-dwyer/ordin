import { readFile } from "node:fs/promises";
import { abs } from "./paths";

export interface ReadInput {
  readonly file_path: string;
}

export async function executeRead(cwd: string, input: ReadInput): Promise<string> {
  return readFile(abs(cwd, input.file_path), "utf8");
}
