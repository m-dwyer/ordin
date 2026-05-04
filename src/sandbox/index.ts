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
