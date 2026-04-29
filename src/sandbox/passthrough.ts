import type { Sandbox, SandboxParams, SandboxReadiness } from "./types";

/**
 * No-op Sandbox. Runs the agent process with the user's full
 * privileges — same behaviour ordin had before the sandbox interface
 * existed. The harness default; opt-in to a real sandbox via config or
 * `--sandbox` flag (see ADR-007).
 */
export class PassthroughSandbox implements Sandbox {
  readonly name = "passthrough";

  async enterIfNeeded(_params: SandboxParams): Promise<void> {
    // Intentional no-op.
  }

  async readiness(): Promise<SandboxReadiness> {
    return { ok: true, reasons: [] };
  }
}
