import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import {
  SandboxManager as DefaultSandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { Sandbox, SandboxParams, SandboxReadiness } from "../types";
import { buildSrtConfig } from "./config";
import { defaultLiteLlmOnlyPolicy, type NetworkPolicy } from "./policy";

/**
 * Sandbox impl backed by `@anthropic-ai/sandbox-runtime` ("srt"). srt
 * generates a kernel-level Seatbelt profile (or bwrap/seccomp on Linux)
 * and stands up an HTTP+SOCKS proxy stack on the parent's event loop;
 * the wrapped child can only reach hosts in the allowlist. Replaces our
 * v1 hand-built profile + reexec (Phase 9c).
 *
 * B-process semantics are preserved: the outer ordin process calls
 * `enterIfNeeded`, srt wraps `process.argv`, the wrapped command is
 * spawned, and the outer process waits for the child and exits with
 * its status. The TUI runs in the inner (post-spawn) process.
 *
 * **Async spawn is non-negotiable.** srt's HTTP+SOCKS proxies live on
 * the parent's JS event loop. `child_process.spawnSync` blocks that
 * loop, the child opens connections to the proxy ports, the proxy
 * cannot service them, every outbound HTTP times out. Use `spawn` and
 * resolve on `exit`. (Phase 9c spike findings, sandboxing-findings.md.)
 *
 * Loop guard: srt sets `SANDBOX_RUNTIME=1` in the wrapped command's
 * env. We use that as the "already inside" marker — no separate env
 * var needed.
 */
const ALREADY_INSIDE_ENV = "SANDBOX_RUNTIME";
const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";

export interface SrtSandboxDeps {
  readonly policy?: NetworkPolicy;
  /** Inject for test seams. Defaults to the singleton from srt. */
  readonly manager?: typeof DefaultSandboxManager;
  /** Inject for test seams. Defaults to `os.platform()`. */
  readonly platform?: () => string;
  /** Inject for test seams. Defaults to `os.homedir()`. */
  readonly homeDir?: () => string;
  /** Inject for test seams. Defaults to `fs.existsSync`. */
  readonly hasFile?: (path: string) => boolean;
  /** Inject for test seams. Defaults to `process.env`. */
  readonly env?: () => NodeJS.ProcessEnv;
  /** Inject for test seams. Defaults to `process.argv`. */
  readonly argv?: () => readonly string[];
  /**
   * Inject for test seams. Defaults to spawning `/bin/sh -c <wrapped>`
   * with stdio inherited and resolving with the child's exit code.
   */
  readonly runWrapped?: (wrapped: string) => Promise<number>;
  /** Inject for test seams. Defaults to `process.exit`. */
  readonly exit?: (code: number) => never;
}

export class SrtSandbox implements Sandbox {
  readonly name = "srt";

  private readonly policy: NetworkPolicy;
  private readonly manager: typeof DefaultSandboxManager;
  private readonly platform: () => string;
  private readonly homeDir: () => string;
  private readonly hasFile: (path: string) => boolean;
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly argv: () => readonly string[];
  private readonly runWrapped: (wrapped: string) => Promise<number>;
  private readonly exit: (code: number) => never;

  constructor(deps: SrtSandboxDeps = {}) {
    this.policy = deps.policy ?? defaultLiteLlmOnlyPolicy();
    this.manager = deps.manager ?? DefaultSandboxManager;
    this.platform = deps.platform ?? platform;
    this.homeDir = deps.homeDir ?? homedir;
    this.hasFile = deps.hasFile ?? existsSync;
    this.env = deps.env ?? (() => process.env);
    this.argv = deps.argv ?? (() => process.argv);
    this.runWrapped = deps.runWrapped ?? defaultRunWrapped;
    this.exit = deps.exit ?? ((code: number) => process.exit(code));
  }

  async enterIfNeeded(params: SandboxParams): Promise<void> {
    if (this.alreadyInside()) return;
    const config = this.buildConfig(params);
    await this.manager.initialize(config);
    await this.manager.waitForNetworkInitialization();
    const command = argvToShellCommand(this.argv());
    const wrapped = await this.manager.wrapWithSandbox(command);
    const code = await this.runWrapped(wrapped);
    this.exit(code);
  }

  async readiness(): Promise<SandboxReadiness> {
    const reasons: string[] = [];
    const plat = this.platform();
    if (plat !== "darwin") {
      reasons.push(`SrtSandbox requires macOS in v1 (current platform: ${plat}).`);
    }
    if (plat === "darwin" && !this.hasFile(SANDBOX_EXEC_BIN)) {
      reasons.push(`sandbox-exec binary not found at ${SANDBOX_EXEC_BIN}.`);
    }
    return { ok: reasons.length === 0, reasons };
  }

  /**
   * Public so callers (doctor, future per-phase config derivation)
   * can inspect the rendered srt config without entering the sandbox.
   */
  buildConfig(params: SandboxParams): SandboxRuntimeConfig {
    return buildSrtConfig({
      params,
      policy: this.policy,
      homeDir: this.homeDir(),
    });
  }

  private alreadyInside(): boolean {
    return this.env()[ALREADY_INSIDE_ENV] === "1";
  }
}

function defaultRunWrapped(wrapped: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(wrapped, {
      shell: true,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (typeof code === "number") return resolve(code);
      if (signal) return resolve(128 + signalToNumber(signal));
      resolve(1);
    });
  });
}

function signalToNumber(signal: NodeJS.Signals): number {
  // Conventional shell exit code is 128 + signal number. Best-effort —
  // node doesn't expose the numeric mapping, but we only care about a
  // non-zero exit code; the exact value matters less than "the parent
  // exits non-zero when the child was killed".
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

/**
 * Quote argv into a `/bin/sh -c` safe command string. srt's
 * `wrapWithSandbox` accepts a string, then re-shell-quotes internally
 * for the inner `bash -c` it generates. We single-quote each arg
 * (escaping embedded single quotes) — the simplest shell-safe encoding
 * that survives both layers.
 */
function argvToShellCommand(argv: readonly string[]): string {
  return argv.map(shellSingleQuote).join(" ");
}

function shellSingleQuote(s: string): string {
  // Replace each single quote with: ' "'" '
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
