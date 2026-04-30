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
export function prepareInnerProcess(env: NodeJS.ProcessEnv = process.env): void {
  if (env["SANDBOX_RUNTIME"] !== "1") return;
  delete env["NO_PROXY"];
  delete env["no_proxy"];
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
