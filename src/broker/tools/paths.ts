import { isAbsolute, resolve } from "node:path";

export function abs(cwd: string, p: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}
