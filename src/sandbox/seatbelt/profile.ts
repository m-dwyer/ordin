import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

/**
 * macOS Seatbelt profile renderer.
 *
 * Profile shape is narrow-allow with a Chromium-pattern system baseline
 * (ADR-014, supersedes ADR-002). Network is unrestricted in v1
 * (ADR-005). Profile is a TinyScheme `.sb` file passed to
 * `sandbox-exec -p <profile>`.
 *
 * Phase 2 ships the renderer; Phase 3 wires it into the actual reexec.
 *
 * Reference profiles informing this one:
 *   - Chromium's renderer-process profile (system baseline pattern)
 *   - Apple's `/System/Library/Sandbox/Profiles/*.sb`
 *   - Claude Code's published macOS sandbox profile
 *   - Sharkcage (sandbox primitives)
 */
export const ProfileParamsSchema = z.object({
  workspaceRoot: z.string().min(1),
  runStoreDir: z.string().min(1),
  harnessRoot: z.string().min(1),
  tempDir: z.string().min(1),
  homeDir: z.string().min(1),
});
export type ProfileParams = z.infer<typeof ProfileParamsSchema>;

/**
 * Additional system roots beyond what `(import "system.sb")` covers.
 * `system.sb` handles `/System`, `/usr/lib`, `/usr/share`, frameworks,
 * dyld cache, mach services. We add the rest of the typical Unix
 * userland (binaries in /bin, /sbin, /usr/{bin,sbin}, /opt for brew,
 * /Applications, /Library for third-party libs).
 */
const SYSTEM_READ_SUBPATHS: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/private/etc",
  // /private/var/select holds the active-Xcode pointer (`developer_dir`
  // symlink). Tools transitively pulled in by OpenTUI/Solid spawn
  // `xcode-select -p` during init; without read access on this path
  // they print a non-fatal stderr error every run. Tiny system dir,
  // no secrets — just the toolchain pointer.
  "/private/var/select",
  "/Library",
  "/Applications",
  "/opt",
];

/**
 * Per-user dev-tooling roots. Holds language runtimes and per-user tool
 * installs (mise, asdf, bun, cargo, npm, pnpm, etc.). Edits are
 * security-relevant — anything allowed here is readable by the agent.
 */
const DEV_TOOLING_READ_SUBPATHS = (homeDir: string): readonly string[] => [
  `${homeDir}/.local`,
  `${homeDir}/.bun`,
  `${homeDir}/.cargo`,
  `${homeDir}/.rustup`,
  `${homeDir}/.asdf`,
  `${homeDir}/.nvm`,
  `${homeDir}/.npm`,
  `${homeDir}/.pnpm-store`,
  `${homeDir}/.gem`,
  `${homeDir}/.composer`,
  `${homeDir}/.go`,
  `${homeDir}/.cache`,
  `${homeDir}/.config/mise`,
  `${homeDir}/Library/pnpm`,
  // Bun's transpiler cache lives under ~/Library/Caches/bun/. We
  // already allow writes (DEV_TOOLING_WRITE_SUBPATHS includes
  // Library/Caches); add the matching read so bun's read-after-write
  // for cached transcodes doesn't generate kernel denial spam.
  `${homeDir}/Library/Caches`,
];

/**
 * Common shell / git config files some dev tools read at startup.
 * Literal-file allows (not subpath) — narrower than allowing all of `~/`
 * or all of `~/.config`.
 */
const COMMON_CONFIG_READ_LITERALS = (homeDir: string): readonly string[] => [
  `${homeDir}/.gitconfig`,
  `${homeDir}/.bash_profile`,
  `${homeDir}/.bashrc`,
  `${homeDir}/.zshrc`,
  `${homeDir}/.zshenv`,
  `${homeDir}/.profile`,
];

/**
 * Defense-in-depth deny list. Most of these are already denied by
 * default (no allow rule covers them) but explicit denies guard against
 * the allow list ever widening to include their parent dirs.
 */
const DEFENSE_IN_DEPTH_DENY_SUBPATHS = (homeDir: string): readonly string[] => [
  `${homeDir}/.ssh`,
  `${homeDir}/.aws`,
  `${homeDir}/.gnupg`,
  `${homeDir}/.docker`,
  `${homeDir}/.config/gh`,
  `${homeDir}/.config/op`,
  `${homeDir}/.config/1Password`,
];

const DEFENSE_IN_DEPTH_DENY_LITERALS = (homeDir: string): readonly string[] => [
  `${homeDir}/.netrc`,
  `${homeDir}/.git-credentials`,
  `${homeDir}/.npmrc`,
  `${homeDir}/.pypirc`,
];

/**
 * Per-user dev-tooling cache / state dirs. These are *writable* — most
 * tools fail to function without writing to their own cache (bun
 * install cache, npm cache, cargo registry, etc.). Edits to this list
 * are security-relevant: anything on this list is writable by the
 * agent, including any creds the tool happens to store there.
 *
 * Notably *not* on this list: `~/.npmrc`, `~/.cargo/credentials`,
 * `~/.docker/config.json` — those have explicit literal denies in
 * the defense-in-depth section below.
 */
const DEV_TOOLING_WRITE_SUBPATHS = (homeDir: string): readonly string[] => [
  `${homeDir}/.bun`, // bun install cache + internal tempdir
  `${homeDir}/.npm`, // npm cache
  `${homeDir}/.cache`, // XDG cache
  `${homeDir}/.cargo/registry`, // cargo registry cache (NOT credentials)
  `${homeDir}/.pnpm-store`, // pnpm content store
  `${homeDir}/Library/Caches`, // macOS standard cache location
];

/**
 * Writable paths. Workspace + run store + per-process temp + macOS
 * shared `/private/tmp` + dev-tooling caches. Plus stdio devices.
 */
const WRITE_ALLOW_SUBPATHS = (params: ProfileParams): readonly string[] => [
  params.workspaceRoot,
  params.runStoreDir,
  params.tempDir,
  "/private/tmp",
  ...DEV_TOOLING_WRITE_SUBPATHS(params.homeDir),
];

const WRITE_ALLOW_LITERALS: readonly string[] = [
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/dtracehelper",
];

export function renderProfile(params: ProfileParams): string {
  const parsed = ProfileParamsSchema.parse(params);
  // Canonicalize paths — macOS sandbox-exec matches on resolved paths.
  // `/var/folders/...` resolves to `/private/var/folders/...`,
  // `/tmp` to `/private/tmp`, etc. Without this, allow/deny rules
  // silently miss symlinked paths.
  const v: ProfileParams = {
    workspaceRoot: resolveSafe(parsed.workspaceRoot),
    runStoreDir: resolveSafe(parsed.runStoreDir),
    harnessRoot: resolveSafe(parsed.harnessRoot),
    tempDir: resolveSafe(parsed.tempDir),
    homeDir: resolveSafe(parsed.homeDir),
  };
  const systemReads = formatSubpathClauses(SYSTEM_READ_SUBPATHS);
  const devToolingReads = formatSubpathClauses(DEV_TOOLING_READ_SUBPATHS(v.homeDir));
  const commonConfigReads = formatLiteralClauses(COMMON_CONFIG_READ_LITERALS(v.homeDir));
  const denySubpaths = formatSubpathClauses(DEFENSE_IN_DEPTH_DENY_SUBPATHS(v.homeDir));
  const denyLiterals = formatLiteralClauses(DEFENSE_IN_DEPTH_DENY_LITERALS(v.homeDir));
  const writeSubpaths = formatSubpathClauses(WRITE_ALLOW_SUBPATHS(v));
  const writeLiterals = formatLiteralClauses(WRITE_ALLOW_LITERALS);
  // Ancestor literals for parent-walking config-discovery libraries
  // (browserslist, npm tsconfig scan, etc.). De-duplicated across
  // workspace and harness chains.
  const ancestorReadMetadata = formatLiteralClauses([
    ...new Set([...ancestorLiterals(v.workspaceRoot), ...ancestorLiterals(v.harnessRoot)]),
  ]);
  const ancestorProbedFiles = formatLiteralClauses([
    ...new Set([
      ...ancestorProbedFileLiterals(v.workspaceRoot),
      ...ancestorProbedFileLiterals(v.harnessRoot),
    ]),
  ]);

  return `(version 1)
(deny default)

;; macOS system baseline — dyld, frameworks, mach services, system
;; libs, system config. Apple ships and maintains this; using their
;; import keeps us in sync with macOS evolution (ADR-014).
(import "system.sb")

;; system.sb sets *import-path* which suppresses its mach-bootstrap and
;; syscall allows. Add them back — every process needs them to run.
(allow mach-bootstrap)
(allow syscall*)

;; Process management — fork/exec/signal-self for normal child processes.
(allow process-fork)
(allow process-exec)
(allow signal (target self))

;; JIT / dynamic code generation. Required by Bun, V8 (node), JVMs,
;; LuaJIT, etc. Without this, agent runtimes that compile code at
;; runtime (very common in JS/TS toolchains) silently fail with
;; "Unexpected" errors during init.
(allow dynamic-code-generation)
(allow process-info-codesignature)
(allow process-info-pidinfo)

;; system.sb covers most lookups; broad mach-lookup keeps third-party
;; service dependencies (notification center, fonts, etc.) working.
(allow mach-lookup)
(allow sysctl-read)
(allow iokit-open)

;; Allow IPC primitives processes commonly need.
(allow ipc-posix-shm)
(allow ipc-posix-sem)

;; Terminal / device ioctls — required by interactive TUI runtimes
;; (OpenTUI's CliRenderer.setupInput calls TIOCSETA via Node's
;; setRawMode). Scoped to /dev so we don't broadly grant ioctl on
;; arbitrary file descriptors. Defense-in-depth: /dev contains only
;; device files (no secrets), so the surface gain is minimal.
(allow file-ioctl
  (subpath "/dev"))

;; Network: v1 unrestricted (ADR-005). v2 layers SOCKS5 + per-phase allowlist.
(allow network*)

;; Additional system roots beyond what system.sb covers (binaries in
;; /bin, /sbin, brew under /opt, /Applications, third-party /Library).
;; file-map-executable is needed for loading dylibs / native modules.
(allow file-read* file-map-executable
${systemReads})

;; Per-user dev-tooling roots (ADR-014). Enumerated finite list.
;; file-map-executable for native addons (better-sqlite3, etc.).
(allow file-read* file-map-executable
${devToolingReads})

;; Common shell/git config files some tools read at startup.
(allow file-read*
${commonConfigReads})

;; ~/.claude — read-only allowed for Claude Max-plan auth (ADR-006).
(allow file-read*
  (subpath ${schemeQuote(`${v.homeDir}/.claude`)}))

;; Harness content root — workflows, agents, skills (and source in dev
;; mode). Read-only: the agent cannot modify ordin's own content.
;; file-map-executable for any vendored native modules.
(allow file-read* file-map-executable
  (subpath ${schemeQuote(v.harnessRoot)}))

;; Workspace + run store + temp — read access (writes below).
(allow file-read* file-map-executable
${formatSubpathClauses([v.workspaceRoot, v.runStoreDir, v.tempDir, "/private/tmp"])})

;; Read access (stat + readdir) on ancestor *directories* of the
;; workspace + harness roots — literal allows only, NOT subpath. Some
;; libraries walk parent directories during config discovery
;; (browserslist's eachParent, bun's package.json scan) and call both
;; statSync (file-read-metadata) and readdirSync (file-read-data) on
;; ancestors. Without both, the scan throws fatal EPERM (browserslist)
;; or prints non-fatal stderr noise (bun). Literal scope means the
;; agent can list the ancestor dir but cannot read files within it
;; or traverse into its other children — those would need their own
;; rules. Sensitive paths under the ancestors stay denied because
;; the deny rules below come last with last-match-wins.
(allow file-read*
${ancestorReadMetadata})

;; Specific config files libraries probe at each ancestor during
;; workspace-root discovery (bun's package.json / bun.lock, tsconfig).
;; Each ancestor stat succeeds via the rule above; this rule lets the
;; subsequent file-open also succeed. Without it bun spams a "Cannot
;; read file '/Users/em/'" line per non-found ancestor.
(allow file-read*
${ancestorProbedFiles})

;; Filesystem writes — workspace, run store, temp + standard stdio.
(allow file-write*
${writeSubpaths}
${writeLiterals})

;; Defense-in-depth (ADR-014). Most of these are denied by default;
;; explicit denies protect against future allow-list widening.
(deny file-read*
${denySubpaths})

(deny file-read*
${denyLiterals})
`;
}

function formatSubpathClauses(paths: readonly string[]): string {
  return paths.map((p) => `  (subpath ${schemeQuote(p)})`).join("\n");
}

function formatLiteralClauses(paths: readonly string[]): string {
  return paths.map((p) => `  (literal ${schemeQuote(p)})`).join("\n");
}

/**
 * Quote a path for the TinyScheme profile language. Escapes backslashes
 * and double-quotes; nothing else needs escaping in a sandbox-exec
 * profile string literal.
 */
function schemeQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Resolve symlinks; tolerate missing paths by falling back to the
 * input unchanged. (HarnessRuntime sometimes hands the renderer a
 * path that hasn't been created yet, e.g. a per-run dir under the
 * run store; that's fine — when sandbox-exec sees a non-existent
 * path it just won't match, no syntax error.)
 */
function resolveSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Compute the chain of ancestor directory literals for a path,
 * stopping at root. Used to grant `file-read*` access on exactly the
 * parents libraries walk during config discovery (browserslist's
 * `eachParent`, npm's tsconfig scan, bun's package.json scan).
 *
 * Each ancestor is emitted twice — once without a trailing slash
 * and once with — because some libraries (Bun's parent-walker among
 * them) call `open()` / `readdir()` on the trailing-slash form, and
 * `sandbox-exec`'s literal-path matching is exact: `(literal "/Users/em")`
 * does NOT match `/Users/em/`. Cheaper than emitting a regex per
 * ancestor and easier to reason about.
 *
 * Returns parents in walking order (immediate parent first,
 * progressing toward root); each followed by its trailing-slash
 * counterpart.
 */
function ancestorLiterals(p: string): readonly string[] {
  const out: string[] = [];
  let current = resolve(p);
  while (true) {
    const parent = dirname(current);
    if (parent === current) break;
    out.push(parent);
    if (parent !== "/") out.push(`${parent}/`);
    current = parent;
  }
  return out;
}

/**
 * Filenames libraries probe in ancestor directories during workspace-
 * root discovery. Bun reads `package.json` / `bun.lock`; npm and
 * tsconfig-aware tools read `tsconfig.json`. Without these explicit
 * literal allows, the parent-walk stat succeeds but the open()-then-
 * read fails with EPERM — surfaces as a noisy stderr line per ancestor
 * even though the run continues.
 */
const ANCESTOR_PROBED_FILES = ["package.json", "bun.lock", "bun.lockb", "tsconfig.json"] as const;

function ancestorProbedFileLiterals(p: string): readonly string[] {
  const out: string[] = [];
  // Same walk as ancestorLiterals, but emit `<dir>/<filename>` for
  // each probed file at each level.
  let current = resolve(p);
  while (true) {
    const parent = dirname(current);
    if (parent === current) break;
    if (parent !== "/") {
      for (const filename of ANCESTOR_PROBED_FILES) {
        out.push(`${parent}/${filename}`);
      }
    }
    current = parent;
  }
  return out;
}
