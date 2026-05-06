import { spawn } from "node:child_process";

export interface BashInput {
  readonly command: string;
}

export async function executeBash(cwd: string, input: BashInput): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("bash", ["-c", input.command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: bashToolEnv(process.env),
    });
    const out: string[] = [];
    const err: string[] = [];
    child.stdout?.on("data", (b: Buffer) => out.push(b.toString("utf8")));
    child.stderr?.on("data", (b: Buffer) => err.push(b.toString("utf8")));
    child.on("close", (code) => {
      const stdout = out.join("");
      const stderr = err.join("");
      if (code === 0) {
        resolvePromise(stdout);
      } else {
        const msg = [stdout, stderr].filter(Boolean).join("\n");
        reject(new Error(`${msg}\n(exit ${code ?? "?"})`.trim()));
      }
    });
  });
}

function bashToolEnv(parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...parentEnv };
  delete env["BASH_ENV"];
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  return env;
}
