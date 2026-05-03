import { type ChildProcess, spawn } from "node:child_process";
import { setDefaultResultOrder } from "node:dns";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import {
  SandboxManager as DefaultSandboxManager,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import type { Broker } from "../../broker";
import type { Sandbox, SandboxParams, SandboxReadiness } from "../types";
import { buildSrtConfig } from "./config";
import { defaultPolicy, type NetworkPolicy } from "./policy";

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

/**
 * Env vars stripped from the inner ordin's environment. Each is a
 * credential the broker injects on the inner's behalf, so the inner
 * has no need (and no business) seeing it. Add new entries here when
 * a new broker-mediated service is introduced.
 *
 * LITELLM_MASTER_KEY stays in the inner for now — the AI SDK runtime
 * still talks to `http://localhost:4000` directly. Step 1.5 will move
 * it through the broker (`http://llm-gateway/`) and add it here.
 */
const INNER_ENV_DENYLIST = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "LANGFUSE_HOST"] as const;

export interface SrtSandboxDeps {
  readonly policy?: NetworkPolicy;
  /** Broker that fronts local services as srt's parentProxy. Owned by
   * the harness; SrtSandbox starts/stops it around the wrapped spawn.
   * srt's allowlist filters first; approved requests are forwarded to
   * the broker's localhost TCP port for upstream-routing + auth
   * injection (and, in future, gate decisions / audit logging). */
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
  /** Inject for test seams. Defaults to `process.argv`. */
  readonly argv?: () => readonly string[];
  /**
   * Inject for test seams. Defaults to spawning `/bin/sh -c <wrapped>`
   * with stdio inherited and resolving with the child's exit code.
   */
  readonly runWrapped?: (wrapped: string, env: NodeJS.ProcessEnv) => Promise<number>;
  /** Inject for test seams. Defaults to `process.exit`. */
  readonly exit?: (code: number) => never;
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
  private readonly argv: () => readonly string[];
  private readonly runWrapped: (wrapped: string, env: NodeJS.ProcessEnv) => Promise<number>;
  private readonly exit: (code: number) => never;

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
    this.argv = deps.argv ?? (() => process.argv);
    this.runWrapped = deps.runWrapped ?? defaultRunWrapped;
    this.exit = deps.exit ?? ((code: number) => process.exit(code));
  }

  async enterIfNeeded(params: SandboxParams): Promise<void> {
    if (this.alreadyInside()) return;
    // srt's HTTP proxy and our broker (both in this parent process)
    // dial outbound by hostname. Default getaddrinfo prefers IPv6 on
    // recent Node/Bun, but Docker Desktop binds host ports to IPv4
    // only by default — `localhost:3000` resolves to `::1:3000` which
    // has no listener, hangs ~2s, then ECONNREFUSED. ipv4first
    // matches the typical local-services bind shape.
    setDefaultResultOrder("ipv4first");
    // Broker must start BEFORE buildConfig — we need its bound port
    // to wire as srt's parentProxy in the runtime config.
    if (this.broker) await this.broker.start();
    const config = this.buildConfig(params);
    await this.manager.initialize(config);
    await this.manager.waitForNetworkInitialization();
    const command = argvToShellCommand(this.argv());
    const wrapped = await this.manager.wrapWithSandbox(command);
    const innerEnv = this.buildInnerEnv();
    const code = await this.runWrapped(wrapped, innerEnv);
    if (this.broker) await this.broker.stop();
    this.exit(code);
  }

  /**
   * Compute the env the inner ordin sees. Strips parent-only secrets
   * (telemetry creds, gateway tokens — anything the broker injects on
   * the inner's behalf) and sets ORDIN_TRACING_ENABLED iff the broker
   * has an authenticated `otel` service. Everything else is inherited
   * from the parent so PATH, HOME, terminal vars, NODE_*, etc. flow
   * through unchanged.
   *
   * Stripping is by deny-list. An allowlist would be cleaner but breaks
   * tooling that legitimately needs broad parent env (mise shims, user
   * locale, etc.). Move to allowlist when we have a clearer picture of
   * what the inner actually requires.
   */
  private buildInnerEnv(): NodeJS.ProcessEnv {
    const env = { ...this.env() };
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

  private alreadyInside(): boolean {
    return this.env()[ALREADY_INSIDE_ENV] === "1";
  }
}

function defaultRunWrapped(wrapped: string, env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(wrapped, {
      shell: true,
      stdio: "inherit",
      env,
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
