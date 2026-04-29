import { PassthroughSandbox } from "./passthrough";
import { SeatbeltSandbox } from "./seatbelt";
import type { Sandbox } from "./types";

export { PassthroughSandbox } from "./passthrough";
export { SeatbeltSandbox } from "./seatbelt";
export type { Sandbox, SandboxParams, SandboxReadiness } from "./types";

/**
 * Sandbox selection token. v1 ships `passthrough` (default) and
 * `seatbelt` (macOS, kernel-enforced). Linux / Docker land in v2 as
 * additional variants behind the same interface.
 */
export type SandboxMode = "passthrough" | "seatbelt";

/**
 * Construct a Sandbox impl from a mode token.
 */
export function selectSandbox(mode: SandboxMode): Sandbox {
  switch (mode) {
    case "passthrough":
      return new PassthroughSandbox();
    case "seatbelt":
      return new SeatbeltSandbox();
    default: {
      const _exhaustive: never = mode;
      throw new Error(`Unknown sandbox mode: ${String(_exhaustive)}`);
    }
  }
}
