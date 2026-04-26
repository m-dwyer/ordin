import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { HarnessConfig, HarnessConfigSchema } from "../domain/config";

export class HarnessConfigLoader {
  async load(path: string): Promise<HarnessConfig> {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = parseYaml(raw);
    const result = HarnessConfigSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Invalid ${path}: ${result.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    }
    const runStore = {
      ...result.data.run_store,
      base_dir: expandHome(result.data.run_store.base_dir),
    };
    return new HarnessConfig(
      runStore,
      result.data.default_runtime,
      result.data.default_model,
      result.data.allowed_tools,
      result.data.runtimes,
      result.data.tiers,
    );
  }
}

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return resolve(homedir(), p.slice(2));
  }
  return isAbsolute(p) ? p : resolve(p);
}
