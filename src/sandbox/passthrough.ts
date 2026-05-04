import { type ChildProcess, spawn } from "node:child_process";
import type { Sandbox, SandboxParams, SandboxReadiness, WorkerHandle, WorkerPlan } from "./types";

/**
 * No-op Sandbox. Runs each worker with the user's full privileges —
 * same behaviour ordin had before the sandbox interface existed. The
 * harness default; opt-in to a real sandbox via config or `--sandbox`
 * flag (see ADR-007).
 */
export class PassthroughSandbox implements Sandbox {
  readonly name = "passthrough";

  async enterIfNeeded(_params: SandboxParams): Promise<void> {
    // Intentional no-op.
  }

  async shutdown(): Promise<void> {
    // Intentional no-op.
  }

  spawnWorker(plan: WorkerPlan): WorkerHandle {
    const [bin, ...args] = plan.argv;
    if (!bin) throw new Error("PassthroughSandbox.spawnWorker: argv[0] required");
    const child: ChildProcess = spawn(bin, args, {
      env: plan.env,
      // stdin inherits (allow interactive runtimes to read tty if any);
      // stdout is piped so the parent can stream JSONL events; stderr
      // inherits so worker diagnostics show up alongside parent's.
      stdio: ["inherit", "pipe", "inherit"],
      ...(plan.cwd ? { cwd: plan.cwd } : {}),
    });
    if (!child.stdout) {
      throw new Error("PassthroughSandbox.spawnWorker: child.stdout missing");
    }
    const stdout = child.stdout;
    const exit = new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (typeof code === "number") return resolve(code);
        if (signal) return resolve(128 + signalToNumber(signal));
        resolve(1);
      });
    });
    return {
      exit,
      stdout,
      kill: (signal?: NodeJS.Signals) => {
        if (!child.killed) child.kill(signal ?? "SIGTERM");
      },
    };
  }

  async readiness(): Promise<SandboxReadiness> {
    return { ok: true, reasons: [] };
  }
}

function signalToNumber(signal: NodeJS.Signals): number {
  switch (signal) {
    case "SIGINT":
      return 2;
    case "SIGTERM":
      return 15;
    case "SIGKILL":
      return 9;
    default:
      return 1;
  }
}
