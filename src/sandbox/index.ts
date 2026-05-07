import type { Broker } from "../broker";
import { PassthroughSandbox } from "./passthrough";
import { SrtSandbox } from "./srt";
import type { Sandbox } from "./types";

export { PassthroughSandbox } from "./passthrough";
export { SrtSandbox } from "./srt";
export type { Sandbox, SandboxParams, SandboxReadiness } from "./types";

/**
 * Sandbox selection token. `passthrough` is the safe default. `srt`
 * activates kernel-enforced isolation + deny-by-default network egress
 * via `@anthropic-ai/sandbox-runtime`. `claude-self` runs without a
 * kernel wrapper but pins claude-cli's outbound traffic to the broker
 * — claude-cli's per-tool `sandbox-exec` handles inner isolation.
 *
 * Adding a new mode: implement `Sandbox` if a new wrapping shape is
 * needed, extend this union and `SandboxModeSchema`, extend the switch.
 * `claude-self` reuses `PassthroughSandbox` because its worker spawn
 * shape is identical — the difference lives in `buildWorkerEnv`
 * (HTTP_PROXY pinning) and `dispatchPhase` (subprocess instead of
 * in-process).
 */
export type SandboxMode = "passthrough" | "claude-self" | "srt";

export interface SelectSandboxOptions {
  readonly broker?: Broker;
}

export function selectSandbox(mode: SandboxMode, opts: SelectSandboxOptions = {}): Sandbox {
  switch (mode) {
    case "passthrough":
    case "claude-self":
      return new PassthroughSandbox();
    case "srt":
      return new SrtSandbox(opts.broker ? { broker: opts.broker } : {});
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown sandbox mode: ${String(_exhaustive)}`);
    }
  }
}
