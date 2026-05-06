import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SandboxParams } from "../types";
import type { NetworkPolicy } from "./policy";

/**
 * Build the `SandboxRuntimeConfig` srt expects from harness-level
 * `SandboxParams` + a `NetworkPolicy`. Pure function — no I/O beyond
 * `realpath()` for symlink canonicalization (sandbox-exec matches
 * resolved paths, so `/var/folders/...` must be normalised to
 * `/private/var/folders/...`).
 *
 * The harness owns the *shape* of what's allowed (workspace + run
 * store + temp writable; harness root readable; ~/.claude readable
 * for ADR-006 Max-plan auth; sensitive credential dirs explicitly
 * denied). srt owns the kernel-level enforcement and the proxy stack.
 */
export interface BuildSrtConfigInput {
  readonly params: SandboxParams;
  readonly policy: NetworkPolicy;
  /**
   * Parent-proxy URL (typically the ordin broker on a localhost TCP
   * port). srt forwards approved egress through this proxy after its
   * own allowlist check. Was `mitmProxy` over a Unix socket originally;
   * switched to parentProxy because Bun ≤1.3.13 mishandles
   * `http.Agent({ socketPath })` paired with absolute-URL `path`,
   * which is the shape srt's mitmProxy hook uses.
   */
  readonly parentProxy?: string;
  /** Inject for tests. Defaults to `os.homedir()`. */
  readonly homeDir?: string;
}

/**
 * Dev-tooling roots ADR-014 commits to making readable: per-user
 * binary install dirs that real workflows reach for (claude, mise,
 * pnpm, etc.). Listed verbatim — the audit value is in being able to
 * cross-reference the rendered profile against the ADR.
 *
 * Resolved relative to `$HOME` at config-build time. Missing dirs are
 * fine — `realpathSync` falls back to the input string and srt
 * tolerates allow rules that don't resolve.
 */
const DEV_TOOLING_ROOTS = [
  ".local",
  ".bun",
  ".cargo",
  ".rustup",
  ".asdf",
  ".nvm",
  ".npm",
  ".pnpm-store",
  ".gem",
  ".composer",
  ".go",
  ".cache",
  ".config/mise",
  "Library/pnpm",
] as const;

export function buildSrtConfig(input: BuildSrtConfigInput): SandboxRuntimeConfig {
  const home = input.homeDir ?? homedir();
  const params = input.params;
  const tempDir = params.tempDir ?? "/tmp";
  const workspaceRoot = resolveSafe(params.workspaceRoot);
  const runStoreDir = resolveSafe(params.runStoreDir);
  const harnessRoot = resolveSafe(params.harnessRoot);
  const tempDirResolved = resolveSafe(tempDir);
  const workerReadRoots = [...(params.workerReadRoots ?? [])].map(resolveSafe);
  const claudeDir = `${home}/.claude`;
  const devToolingRoots = DEV_TOOLING_ROOTS.map((rel) => resolveSafe(`${home}/${rel}`));

  // srt reads are deny-then-allow. Denying the whole home directory
  // and re-allowing only the paths ordin needs is easier to audit than
  // chasing every possible credential/config dotfile.
  const deniedReadRoots: readonly string[] = [home];

  return {
    network: {
      allowedDomains: [...input.policy.allowedDomains],
      deniedDomains: [...input.policy.deniedDomains],
      ...(input.parentProxy ? { parentProxy: { http: input.parentProxy } } : {}),
    },
    // Required for any TUI inside the sandbox: OpenTUI's setRawMode
    // calls TIOCSETA on /dev/ttysNN, and srt's default ioctl allow-list
    // only covers literal /dev/tty. `allowPty` adds the regex match on
    // /dev/ttysNN. Leave it on regardless of TUI/non-TTY mode — the
    // surface gain is negligible (pty devices) and detecting "is the
    // child going to mount a TUI" upfront is fragile.
    allowPty: true,
    filesystem: {
      // Reads are deny-then-allow in srt: deny the user's home by
      // default, then re-permit only the home paths ordin needs.
      denyRead: [...deniedReadRoots],
      allowRead: [
        claudeDir,
        harnessRoot,
        workspaceRoot,
        runStoreDir,
        tempDirResolved,
        ...devToolingRoots,
        ...workerReadRoots,
      ],
      // Writes are allow-only in srt: anything not in allowWrite is
      // denied by default. We deliberately do NOT carve denies inside
      // allowWrite — denyWrite would only matter if it overlapped an
      // allow zone, and a previous attempt to add belt-and-braces
      // denies for harnessRoot/claudeDir/credential dirs actively
      // broke the dev workflow (the fixture workspace
      // `.scratch/target-repo` lives under harnessRoot, so denying
      // harnessRoot also denied the workspace). The allow-only model
      // is sufficient: harnessRoot, ~/.claude, and credential dirs
      // are all denied because none of them appear in allowWrite.
      allowWrite: [workspaceRoot, runStoreDir, tempDirResolved],
      denyWrite: [],
    },
  };
}

function resolveSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
