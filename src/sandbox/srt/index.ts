import { type ChildProcess, spawn } from "node:child_process";
import { setDefaultResultOrder } from "node:dns";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import {
  SandboxManager as DefaultSandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { Broker } from "../../broker";
import type { Sandbox, SandboxParams, SandboxReadiness, WorkerHandle, WorkerPlan } from "../types";
import { buildSrtConfig } from "./config";
import { defaultPolicy, type NetworkPolicy } from "./policy";

/**
 * Sandbox impl backed by `@anthropic-ai/sandbox-runtime` ("srt"). srt
 * generates a kernel-level Seatbelt profile (or bwrap/seccomp on Linux)
 * and stands up an HTTP+SOCKS proxy stack on the parent's event loop;
 * each wrapped child can only reach hosts in the allowlist (and via
 * the parent broker for everything else).
 *
 * Under L2 the parent stays as the parent. `enterIfNeeded` brings up
 * the broker + srt; `spawnWorker` produces one wrapped child per phase.
 *
 * **Async spawn is non-negotiable.** srt's HTTP+SOCKS proxies live on
 * the parent's JS event loop. `child_process.spawnSync` blocks that
 * loop, the child opens connections to the proxy ports, the proxy
 * cannot service them, every outbound HTTP times out. Use `spawn` and
 * resolve on `exit`. (Phase 9c spike findings, sandboxing-findings.md.)
 */
const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";

/**
 * Env vars stripped from each worker's environment. Each is a
 * credential the broker injects on the worker's behalf, so the worker
 * has no need (and no business) seeing it. Add new entries here when
 * a new broker-mediated service is introduced.
 */
const INNER_ENV_DENYLIST = [
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "LANGFUSE_HOST",
  "LITELLM_MASTER_KEY",
] as const;

export interface SrtSandboxDeps {
  readonly policy?: NetworkPolicy;
  /** Broker that fronts local services as srt's parentProxy. Owned by
   * the harness; SrtSandbox starts it on `enterIfNeeded` and stops it
   * on `shutdown`. srt's allowlist filters first; approved requests
   * are forwarded to the broker's localhost TCP port for upstream-
   * routing + auth injection + audit. */
  readonly broker?: Broker;
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
  /**
   * Inject for test seams. Defaults to spawning `/bin/sh -c <wrapped>`
   * with stdio inherited and resolving with the child's exit code.
   */
  readonly spawnWrapped?: (wrapped: string, opts: SpawnWrappedOpts) => SpawnedChild;
}

export interface SpawnWrappedOpts {
  readonly env: NodeJS.ProcessEnv;
  /** Override the worker's cwd. Omit to inherit from the parent. */
  readonly cwd?: string;
}

export interface SpawnedChild {
  readonly exit: Promise<number>;
  kill(signal?: NodeJS.Signals): void;
}

export class SrtSandbox implements Sandbox {
  readonly name = "srt";

  private readonly policy: NetworkPolicy;
  private readonly broker?: Broker;
  private readonly manager: typeof DefaultSandboxManager;
  private readonly platform: () => string;
  private readonly homeDir: () => string;
  private readonly hasFile: (path: string) => boolean;
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly spawnWrapped: (wrapped: string, opts: SpawnWrappedOpts) => SpawnedChild;
  private initialized = false;

  constructor(deps: SrtSandboxDeps = {}) {
    this.broker = deps.broker;
    this.policy =
      deps.policy ??
      defaultPolicy({ localServiceNames: this.broker?.services.map((s) => s.name) ?? [] });
    this.manager = deps.manager ?? DefaultSandboxManager;
    this.platform = deps.platform ?? platform;
    this.homeDir = deps.homeDir ?? homedir;
    this.hasFile = deps.hasFile ?? existsSync;
    this.env = deps.env ?? (() => process.env);
    this.spawnWrapped = deps.spawnWrapped ?? defaultSpawnWrapped;
  }

  async enterIfNeeded(params: SandboxParams): Promise<void> {
    if (this.initialized) return;
    // srt's HTTP proxy and our broker (both in this parent process)
    // dial outbound by hostname. Default getaddrinfo prefers IPv6 on
    // recent Node/Bun, but Docker Desktop binds host ports to IPv4
    // only by default — `localhost:3000` resolves to `::1:3000` which
    // has no listener, hangs ~2s, then ECONNREFUSED. ipv4first
    // matches the typical local-services bind shape.
    setDefaultResultOrder("ipv4first");
    const config = this.buildConfig(params);
    // srt's askCallback fires for hosts that fall through
    // allowedDomains/deniedDomains. Routed through the broker so
    // approvals are cached and audit-emitted in one place; the broker's
    // own request/CONNECT path also consults the cache to passthrough
    // approved external hosts. Without a broker (defensive — current
    // wiring always provides one for srt mode), srt falls back to its
    // built-in "no callback = deny" behaviour.
    const askCallback = this.broker
      ? (params: { host: string; port: number | undefined }) =>
          this.broker?.askApproval(params.host, params.port) ?? Promise.resolve(false)
      : undefined;
    await this.manager.initialize(config, askCallback);
    await this.manager.waitForNetworkInitialization();
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.initialized = false;
  }

  spawnWorker(plan: WorkerPlan): WorkerHandle {
    if (!this.initialized) {
      throw new Error("SrtSandbox.spawnWorker called before enterIfNeeded");
    }
    const command = argvToShellCommand(plan.argv);
    const wrappedPromise = this.manager.wrapWithSandbox(command);
    const env = this.applyEnvDenylist(plan.env);
    let killed: SpawnedChild | undefined;
    const exit = wrappedPromise.then((wrapped) => {
      const opts: SpawnWrappedOpts = { env, ...(plan.cwd ? { cwd: plan.cwd } : {}) };
      killed = this.spawnWrapped(wrapped, opts);
      return killed.exit;
    });
    return {
      exit,
      kill: (signal?: NodeJS.Signals) => killed?.kill(signal),
    };
  }

  /**
   * Strip parent-only secrets (telemetry creds, gateway tokens —
   * anything the broker injects on the worker's behalf) and set
   * ORDIN_TRACING_ENABLED / ORDIN_AUDIT_ENABLED based on the broker's
   * registered services. Workers inherit PATH, HOME, terminal vars,
   * etc. from `plan.env` unmodified.
   */
  private applyEnvDenylist(planEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = { ...planEnv };
    for (const key of INNER_ENV_DENYLIST) {
      delete env[key];
    }
    const otel = this.broker?.services.find((s) => s.name === "otel");
    if (otel?.kind === "forward" && otel.authHeader) {
      env["ORDIN_TRACING_ENABLED"] = "1";
    } else {
      delete env["ORDIN_TRACING_ENABLED"];
    }
    const audit = this.broker?.services.find((s) => s.name === "audit");
    if (audit?.kind === "internal") {
      env["ORDIN_AUDIT_ENABLED"] = "1";
    } else {
      delete env["ORDIN_AUDIT_ENABLED"];
    }
    return env;
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
      ...(this.broker ? { parentProxy: this.broker.proxyUrl() } : {}),
    });
  }
}

function defaultSpawnWrapped(wrapped: string, opts: SpawnWrappedOpts): SpawnedChild {
  const child: ChildProcess = spawn(wrapped, {
    shell: true,
    stdio: ["inherit", "pipe", "pipe"],
    env: opts.env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  // Pipe worker output to the parent's stderr — keeps it visible
  // alongside the TUI's stderr but out of stdout (the TUI owns that).
  child.stdout?.pipe(process.stderr);
  child.stderr?.pipe(process.stderr);
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
    kill: (signal?: NodeJS.Signals) => {
      if (!child.killed) child.kill(signal ?? "SIGTERM");
    },
  };
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
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
