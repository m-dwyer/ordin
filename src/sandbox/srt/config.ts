import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { SandboxParams } from "../types";
import type { NetworkPolicy } from "./policy";

export interface MitmProxyConfig {
  readonly socketPath: string;
  readonly domains: readonly string[];
}

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
  /** Routes listed domains through our broker's Unix socket. */
  readonly mitmProxy?: MitmProxyConfig;
  /** Inject for tests. Defaults to `os.homedir()`. */
  readonly homeDir?: string;
}

export function buildSrtConfig(input: BuildSrtConfigInput): SandboxRuntimeConfig {
  const home = input.homeDir ?? homedir();
  const params = input.params;
  const tempDir = params.tempDir ?? "/tmp";
  const workspaceRoot = resolveSafe(params.workspaceRoot);
  const runStoreDir = resolveSafe(params.runStoreDir);
  const harnessRoot = resolveSafe(params.harnessRoot);
  const tempDirResolved = resolveSafe(tempDir);
  const claudeDir = `${home}/.claude`;

  // Credential / private dirs the agent must not read. srt's read
  // model is deny-then-allow (default broadly allowed) so this list
  // is the gate that actually blocks reads.
  const sensitiveDenies: readonly string[] = [
    `${home}/.ssh`,
    `${home}/.aws`,
    `${home}/.gnupg`,
    `${home}/.docker`,
    `${home}/.config/gh`,
    `${home}/.config/op`,
    `${home}/.config/1Password`,
    `${home}/.netrc`,
    `${home}/.git-credentials`,
    `${home}/.npmrc`,
    `${home}/.pypirc`,
  ];

  return {
    network: {
      allowedDomains: [...input.policy.allowedDomains],
      deniedDomains: [...input.policy.deniedDomains],
      ...(input.mitmProxy
        ? {
            mitmProxy: {
              socketPath: input.mitmProxy.socketPath,
              domains: [...input.mitmProxy.domains],
            },
          }
        : {}),
    },
    // Required for any TUI inside the sandbox: OpenTUI's setRawMode
    // calls TIOCSETA on /dev/ttysNN, and srt's default ioctl allow-list
    // only covers literal /dev/tty. `allowPty` adds the regex match on
    // /dev/ttysNN. Leave it on regardless of TUI/non-TTY mode — the
    // surface gain is negligible (pty devices) and detecting "is the
    // child going to mount a TUI" upfront is fragile.
    allowPty: true,
    filesystem: {
      // Reads are deny-then-allow in srt: default broadly permitted,
      // denyRead is the gate. allowRead re-permits inside denied zones
      // (only matters for paths nested under a denyRead — empty here
      // because none of our allows nest under any sensitiveDeny).
      denyRead: [...sensitiveDenies],
      allowRead: [claudeDir, harnessRoot, workspaceRoot, runStoreDir, tempDirResolved],
      // Writes are allow-only in srt: anything not in allowWrite is
      // denied by default. We deliberately do NOT carve denies inside
      // allowWrite — denyWrite would only matter if it overlapped an
      // allow zone, and a previous attempt to add belt-and-braces
      // denies for harnessRoot/claudeDir/sensitiveDenies actively
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
