import { existsSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import type { Sandbox, SandboxParams, SandboxReadiness } from "../types";
import { type ProfileParams, renderProfile } from "./profile";
import { type ReexecArgs, reexec, shouldReexec } from "./reexec";

/**
 * macOS Seatbelt sandbox — wraps `ordin run` in a kernel-enforced
 * `sandbox-exec` profile (B-process; ADR-001).
 *
 * Phase 2 ships the profile renderer + readiness check. Phase 3 fills
 * in `enterIfNeeded` with the self-reexec mechanic (ADR-009).
 */
export interface SeatbeltSandboxDeps {
  /** Inject for test seams. Defaults to `os.platform()`. */
  readonly platform?: () => string;
  /** Inject for test seams. Defaults to `fs.existsSync`. */
  readonly hasFile?: (path: string) => boolean;
  /** Inject for test seams. Defaults to `os.homedir()`. */
  readonly homeDir?: () => string;
  /** Inject for test seams. Defaults to `os.tmpdir()`. */
  readonly tempDir?: () => string;
  /** Inject for test seams. Defaults to `process.env`. */
  readonly env?: () => NodeJS.ProcessEnv;
  /** Inject for test seams. Defaults to `process.argv`. */
  readonly argv?: () => readonly string[];
  /**
   * Inject for test seams. Defaults to the production `reexec` from
   * `./reexec`, which spawns sandbox-exec and exits the parent.
   */
  readonly reexec?: (args: ReexecArgs) => never;
}

const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";

export class SeatbeltSandbox implements Sandbox {
  readonly name = "seatbelt";

  private readonly platform: () => string;
  private readonly hasFile: (path: string) => boolean;
  private readonly homeDir: () => string;
  private readonly tempDir: () => string;
  private readonly env: () => NodeJS.ProcessEnv;
  private readonly argv: () => readonly string[];
  private readonly reexec: (args: ReexecArgs) => never;

  constructor(deps: SeatbeltSandboxDeps = {}) {
    this.platform = deps.platform ?? platform;
    this.hasFile = deps.hasFile ?? existsSync;
    this.homeDir = deps.homeDir ?? homedir;
    this.tempDir = deps.tempDir ?? tmpdir;
    this.env = deps.env ?? (() => process.env);
    this.argv = deps.argv ?? (() => process.argv);
    this.reexec = deps.reexec ?? reexec;
  }

  async enterIfNeeded(params: SandboxParams): Promise<void> {
    if (!shouldReexec(this.env())) {
      // Already inside the sandbox (post-reexec); proceed normally.
      return;
    }
    const profile = this.renderProfile(params);
    this.reexec({ profile, argv: this.argv() });
    // reexec() does not return on the production path — the process is
    // replaced. Tests injecting a reexec stub may return; nothing more
    // to do here either way.
  }

  async readiness(): Promise<SandboxReadiness> {
    const reasons: string[] = [];
    const plat = this.platform();
    if (plat !== "darwin") {
      reasons.push(`SeatbeltSandbox requires macOS (current platform: ${plat}).`);
    }
    if (!this.hasFile(SANDBOX_EXEC_BIN)) {
      reasons.push(`sandbox-exec binary not found at ${SANDBOX_EXEC_BIN}.`);
    }
    return { ok: reasons.length === 0, reasons };
  }

  /**
   * Render the profile for the given run. Public so callers (Phase 3
   * reexec, Phase 5 smoke tests, Phase 6 probes) all use the same path.
   */
  renderProfile(params: SandboxParams): string {
    const profileParams: ProfileParams = {
      workspaceRoot: params.workspaceRoot,
      runStoreDir: params.runStoreDir,
      harnessRoot: params.harnessRoot,
      tempDir: params.tempDir ?? this.tempDir(),
      homeDir: this.homeDir(),
    };
    return renderProfile(profileParams);
  }
}
