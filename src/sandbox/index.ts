import type { Broker } from "../broker";
import { PassthroughSandbox } from "./passthrough";
import { SrtSandbox } from "./srt";
import type { Sandbox } from "./types";

/**
 * Run at the very start of the inner ordin process (sandboxed child)
 * before any HTTP client fires. Bun's `http`/`fetch` polyfill natively
 * honors `NO_PROXY`, which srt sets to `localhost,127.0.0.1,...`. Under
 * the sandbox, "skip proxy and go direct" means "kernel-blocked" — we
 * want everything to flow through srt's proxy so its allowlist gates
 * traffic. Clearing NO_PROXY forces Bun to use whatever proxy agent
 * each client wires.
 */
/**
 * True when this process is the sandboxed child (srt sets
 * `SANDBOX_RUNTIME=1` in the wrapped command's env). False in the
 * outer parent and in passthrough mode. The single source of truth
 * for "are we past the sandbox boundary?" — call this rather than
 * inlining the env check.
 */
export function isInnerProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["SANDBOX_RUNTIME"] === "1";
}

export function prepareInnerProcess(env: NodeJS.ProcessEnv = process.env): void {
  if (!isInnerProcess(env)) return;
  delete env["NO_PROXY"];
  delete env["no_proxy"];
  // The outer process sets ipv4first for its broker / proxy lookups, but
  // that's per-process state — the inner inherits nothing. srt's HTTP
  // proxy binds IPv4 only; without this, `localhost:NNNN` resolves to
  // `::1:NNNN` here, hangs ~2s, then ECONNREFUSED. Mirror the outer's
  // setting so HTTP_PROXY env actually reaches the proxy.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dns = require("node:dns") as typeof import("node:dns");
  dns.setDefaultResultOrder("ipv4first");
}

export { PassthroughSandbox } from "./passthrough";
export { SrtSandbox } from "./srt";
export type { Sandbox, SandboxParams, SandboxReadiness } from "./types";

/**
 * Sandbox selection token. `passthrough` is the safe default. `srt`
 * activates kernel-enforced isolation + deny-by-default network egress
 * via `@anthropic-ai/sandbox-runtime` (Phase 9c). Adding a new mode
 * means: implement `Sandbox`, extend this union, extend the switch.
 */
export type SandboxMode = "passthrough" | "srt";

export interface SelectSandboxOptions {
  readonly broker?: Broker;
}

export function selectSandbox(mode: SandboxMode, opts: SelectSandboxOptions = {}): Sandbox {
  switch (mode) {
    case "passthrough":
      return new PassthroughSandbox();
    case "srt":
      return new SrtSandbox(opts.broker ? { broker: opts.broker } : {});
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown sandbox mode: ${String(_exhaustive)}`);
    }
  }
}
