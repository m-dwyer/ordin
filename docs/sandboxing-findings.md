# Sandboxing — implementation findings

Real-world discoveries from Phase 5 smoke testing of the macOS Seatbelt profile. Each finding has a symptom, diagnosis, fix, and "why it matters" — captured here so future maintainers don't repeat the same debugging when extending the profile.

For the full design see [`decisions/sandboxing.md`](./decisions/sandboxing.md). For the implementation phases see [`sandboxing-implementation.md`](./sandboxing-implementation.md).

## Finding 1 — `(import "system.sb")` is the right baseline

**Symptom:** With a hand-rolled system baseline (explicit allows for `/usr`, `/System`, `/Library`, etc.), even `/usr/bin/echo` died with `SIGABRT` under the sandbox. Bun didn't even start; `/usr/bin/true` was killed before it could exit.

**Diagnosis:** macOS dyld needs more than just file reads on system paths — it needs `file-map-executable` permissions on frameworks, specific mach service lookups (`com.apple.system.notification_center`, `com.apple.system.opendirectoryd.libinfo`, etc.), and access to the dyld shared cache (`/private/var/db/dyld`). Apple ships a profile import (`system.sb`) that handles all of this and is kept current as macOS evolves. ADR-014's original reasoning — "import system.sb is unreliable across macOS versions" — was wrong; the file is part of Apple's stable system profile suite (`/System/Library/Sandbox/Profiles/`) used by Chromium, Firefox, and every Apple internal sandbox.

**Fix:** Replace the hand-rolled baseline with `(import "system.sb")`, plus a small set of explicit additions for what the import suppresses (see Finding 2).

**Why it matters:** Trying to hand-roll the system baseline means re-deriving Apple's internal IPC + dyld plumbing from scratch — fragile, version-specific, and the failure mode (SIGABRT with no log message) is opaque.

## Finding 2 — `system.sb` suppresses key allows when imported

**Symptom:** Even after `(import "system.sb")`, processes still failed to start.

**Diagnosis:** `system.sb` contains:

```scheme
(unless *import-path*
  (allow mach-bootstrap)
  (allow syscall*))
```

When `system.sb` is *imported* (rather than used as the top-level profile), `*import-path*` is set, so those allows are *skipped*. Apple's design: when you embed system.sb in your own profile, you opt into deciding the syscall and bootstrap policy yourself.

**Fix:** Add explicit allows after the import:

```scheme
(import "system.sb")
(allow mach-bootstrap)
(allow syscall*)
(allow mach-lookup)
(allow sysctl-read)
(allow iokit-open)
(allow ipc-posix-shm)
(allow ipc-posix-sem)
```

**Why it matters:** The "import then add" pattern is Apple's intended design. Anyone reading just the import line could assume baseline coverage is complete and end up with a non-functional profile.

## Finding 3 — JIT engines need `(allow dynamic-code-generation)`

**Symptom:** `bun --version` and `bun --help` worked under the sandbox, but `bun -e <code>` failed with `error: An unknown error occurred (Unexpected)`. No useful diagnostic.

**Diagnosis:** Bun's `-e` mode evaluates JavaScript via JavaScriptCore JIT. macOS sandbox has a dedicated operation, `dynamic-code-generation`, gating writable+executable memory mapping (the JIT trampoline). Without it, JIT allocation fails silently and the JS engine reports a generic "Unexpected" error because it can't introspect why the OS denied the mmap.

**Fix:**

```scheme
(allow dynamic-code-generation)
(allow process-info-codesignature)
(allow process-info-pidinfo)
```

**Why it matters:** Affects every JIT-using runtime — Bun, Node.js (V8), JVMs, LuaJIT, modern Python (no — Python doesn't use JIT by default), and likely future Deno releases. The error message is actively misleading; without knowing the right operation name, debugging this consumes hours.

## Finding 4 — `file-map-executable` for native modules

**Symptom:** Tools that load `.dylib` or `.node` files fail with `dlopen` errors despite `file-read*` being allowed.

**Diagnosis:** macOS distinguishes file *reads* from *executable mappings*. `(allow file-read*)` allows read syscalls; `(allow file-map-executable)` allows `mmap` with `PROT_EXEC`. Native node modules (better-sqlite3, sharp, native bun bindings) need both. `system.sb` covers `file-map-executable` for system frameworks; *we* must cover it for our own dev-tooling roots and the harness root.

**Fix:** Pair `file-map-executable` with `file-read*` on every subpath that may contain native binaries:

```scheme
(allow file-read* file-map-executable
  (subpath "/usr") (subpath "/Library") ...
  (subpath "/Users/em/.bun") (subpath "/Users/em/.npm") ...
  (subpath WORKSPACE_ROOT)
  (subpath HARNESS_ROOT))
```

**Why it matters:** Most TypeScript tooling has at least one native dep transitively. Without this, `pnpm install` succeeds but `pnpm test` fails because, e.g., `better-sqlite3.node` can't be loaded.

## Finding 5 — `sandbox-exec` matches resolved paths; symlinks must be canonicalized

**Symptom:** Profile contained `(allow file-write* (subpath "/var/folders/.../T"))`. Bun nonetheless failed with `error: bun is unable to access tempdir: PermissionDenied`.

**Diagnosis:** On macOS:
- `/var` is a symlink to `/private/var`.
- `/tmp` is a symlink to `/private/tmp`.
- `os.tmpdir()` returns the *un-resolved* path (e.g. `/var/folders/...`).
- `sandbox-exec` matches the *resolved* path (`/private/var/folders/...`).

So `(subpath "/var/folders/...")` doesn't match anything the kernel actually sees. Rules silently fail to apply.

**Fix:** Canonicalize all path inputs in the renderer:

```ts
import { realpathSync } from "node:fs";
const resolved = {
  workspaceRoot: realpathSync(params.workspaceRoot),
  runStoreDir: realpathSync(params.runStoreDir),
  // ...
};
```

Wrapped in a try/catch with fallback for non-existent paths (some run-store subpaths are created mid-run).

**Why it matters:** This is a *real production bug*, not a smoke-test artifact. Any user's first sandboxed run would fail because their `os.tmpdir()` lives under `/var/folders/...`. Discovery in Phase 5 saved us from shipping the bug.

## Finding 6 — `(subpath "/dev")` is too broad; use literal device files

**Symptom:** Initially the profile allowed `(allow file-write* (subpath "/dev"))` to cover stdio. This is more permissive than needed — `/dev` contains many devices (disks, ttys, IOKit nodes) that the agent shouldn't write to.

**Fix:** Narrower allow on specific stdio devices:

```scheme
(allow file-write*
  (literal "/dev/null")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/dtracehelper"))
```

**Why it matters:** Defense-in-depth — if a future allow rule accidentally widens write access to `/dev`, it shouldn't matter, because the broader rule wasn't there to begin with. Aligns with the principle-of-least-privilege spirit of ADR-014.

## Finding 7 — Bun scans upward from cwd for `package.json` / workspace root

**Symptom:** Running `bun -e 1` from a non-workspace directory failed even with what looked like a complete profile.

**Diagnosis:** Bun walks parent directories of cwd looking for `package.json`, `bun.lock`, and `tsconfig.json`. Each parent stat / read counts as a sandbox-permission check. Running bun from `/Users/em/src/harness/` scans up to `/Users/em/src/`, `/Users/em/`, `/Users/`, `/` — all of which need (at minimum) `file-read-metadata` access for the scan to succeed.

**Fix (for the smoke tests):** Run sandbox-exec with `cwd` inside `workspaceRoot` so the parent scan stays inside allowed paths.

**Fix (for production):** When the harness invokes a runtime, the spawned process's cwd is the workspace root — already an allowed subpath. Parent-scan walks `<workspace>` → `<workspace>/..` → ... → `/`, and the system.sb baseline covers the metadata reads on `/Users`, `/`, etc. needed for the walk.

**Why it matters:** This was the only finding that was *not* a profile bug — production already gets this right because workspace cwd is always allowed. But it's a sharp edge for the test suite and worth knowing about.

## Finding 8 — B-process couples host and agent lifecycles; TUI state leaks across reexec

**Symptom:** Running `ordin run --sandbox seatbelt …` left the terminal in a wrecked state — mouse-tracking position reports streaming into the prompt, DEC mode query responses (`1R`, `1016;2$y`, etc.) appearing as garbage text, alt-screen mode active, cursor hidden. Effects persisted until a manual `reset`.

**Diagnosis:** The CLI's flow was:
1. Outer process: build `HarnessRuntime`, mount OpenTUI controller (writes init sequences — raw mode, mouse tracking enable, alt-screen, capability queries).
2. Outer process: call `startRun` → `enterIfNeeded` → `execve` under `sandbox-exec`.
3. **Outer process is replaced.** The renderer's cleanup (which would disable mouse tracking, exit alt-screen, restore the cursor) never runs.
4. Inner process: mounts a fresh OpenTUI controller on top of the polluted terminal state.

The capability-query responses sent by the terminal to the *outer* process arrived after the renderer was gone, so the OS dumped them to whatever was reading stdin — the inner process's prompt, the user's shell, or both depending on timing.

**Fix (immediate):** Add `prepareSandbox(input)` to `HarnessRuntime` and call it in `ordinRunSession` *before* any terminal initialisation. Reexec, if it happens, replaces a process that hasn't touched the terminal yet. Backstop: `startRun`'s existing `enterIfNeeded` call still runs (no-op when the inner already entered).

**Why it matters — and why it argues for B-worker eventually:** The B-process design conflates two concerns into one process tree: the *host* (CLI, TUI, RunStore writes, gate prompter) and the *agent* (engine, runtime, model traffic, tool execution). Reexec is a hammer that hits both. Today's `prepareSandbox` fix works because the order of initialisation is explicit, but it's *fragile to refactors* — anyone adding a feature that touches the terminal before `prepareSandbox` re-introduces the bug.

B-worker dissolves the issue structurally:
- Host process never enters the sandbox; TUI / RunStore / gates stay alive across the worker spawn.
- Sandboxed worker is a fresh `spawn`-and-wait child; nothing about it can leak into the host's terminal state.
- Sequencing is trivial — host always controls stdio, worker streams events back as JSONL.

The TUI lifecycle issue alone doesn't justify the IPC complexity yet, but it's the third converging signal alongside per-phase profiles (v2) and server-mode sandboxing (v2). See [ADR-001](./decisions/sandboxing.md#adr-001--sandbox-boundary-b-process-self-reexec) for the updated B-worker trigger list.

## Finding 9 — Bun's "tempdir" error means `~/.bun/install/cache`, not `os.tmpdir()`

**Symptom:** `error: bun is unable to write files to tempdir: PermissionDenied` from a sandboxed `bun` process, despite the profile allowing writes to `os.tmpdir()` (canonicalized via realpath).

**Diagnosis:** The error message is misleading. Bun's "tempdir" in this code path is its own scratch space under `~/.bun/install/cache/...`, not the system temp dir. Triggered when bun starts in a directory with a `package.json` / `bun.lock` and has any dep state to verify or reconcile. Not seen when invoking `bun -e <code>` from a directory with no manifest.

**Fix:** Add per-user dev-tooling cache dirs to the profile's writable subpaths — the `DEV_TOOLING_WRITE_SUBPATHS` constant in `profile.ts`:

```
~/.bun, ~/.npm, ~/.cache, ~/.cargo/registry,
~/.pnpm-store, ~/Library/Caches
```

Distinct from the *read* allow list (`DEV_TOOLING_READ_SUBPATHS`) — most dev tools need to write their own caches to function. Notable exclusions: `~/.npmrc`, `~/.cargo/credentials`, `~/.docker/config.json` — explicit literal denies remain in the defense-in-depth list.

**Why it matters:** The error message led ~30 minutes of debugging the system tmpdir before realising bun calls its own cache directory "tempdir." Documented here so the next sandbox author doesn't repeat the search.

## Finding 10 — Interactive TUI runtimes need `file-ioctl` on `/dev` for raw-mode setup

**Symptom:** `Error: setRawMode failed with errno: 1` when an interactive TUI tries to put stdin in raw mode under the sandbox. Stack trace points at `node:tty.setRawMode` → `setupInput` → `CliRenderer` constructor.

**Diagnosis:** `setRawMode` calls TIOCSETA ioctl on the tty file descriptor. Sandbox-exec gates ioctl operations under the `file-ioctl` op (separate from `file-read*` and `file-write*`). Without an explicit allow, the ioctl fails with EPERM and the TUI bootstrap throws.

**Fix:** Allow file-ioctl on `/dev` (which contains all device files including ttys, but no secrets):

```scheme
(allow file-ioctl
  (subpath "/dev"))
```

**Why it matters:** Universal requirement for any interactive TUI runtime — OpenTUI, blessed, ink, prompts, clack, etc. All of them call setRawMode at startup. The error message names `setRawMode` but says nothing about ioctl, so without knowing the sandbox primitives the diagnosis isn't obvious.

## Finding 11 — Config-discovery libraries walk parent dirs and throw fatal EPERM on stat

**Symptom:** `Error: EPERM: operation not permitted, stat '/Users/em/src'` thrown from inside `browserslist`'s `eachParent` → `findConfigFile`. Triggered transitively by `@opentui/solid` → `babel-preset-solid` → `@babel/core.transform` → `getTargets` → browserslist.

**Diagnosis:** Many JS ecosystem libraries walk parent directories looking for config files (`.browserslistrc`, `tsconfig.json`, `package.json` workspace roots). Each parent gets `statSync` called on it. Under a narrow-allow profile, ancestors of the workspace + harness roots aren't explicitly granted — `statSync` fails with EPERM, and unlike many other lib-level errors this one is *thrown unhandled* by browserslist, crashing the process.

`BROWSERSLIST=defaults` env var was tried first as a "skip the file scan" knob. Doesn't fully short-circuit — browserslist still calls `getStat` from its main entry path even with the query supplied.

**Fix:** Compute ancestor literals of `workspaceRoot` and `harnessRoot` at profile-render time, allow `file-read-metadata` (stat-only, *not* directory listing or content reads) on each:

```ts
function ancestorLiterals(p: string): readonly string[] {
  const out: string[] = [];
  let current = resolve(p);
  while (true) {
    const parent = dirname(current);
    if (parent === current) break;
    out.push(parent);
    current = parent;
  }
  return out;
}
```

Roughly 5–8 literal allows per run. Sensitive denies still apply because `file-read*` matches `file-read-metadata` and last-match-wins.

`BROWSERSLIST=defaults` and `BROWSERSLIST_DISABLE_CACHE=1` are still injected via `buildReexecEnv` for belt-and-braces — they reduce the surface even when not strictly necessary.

**Why it matters:** This pattern — "throw unhandled on parent stat EPERM" — appears in many ecosystem libraries (npm, lerna, eslint config discovery, prettier config discovery, etc.). Allowing `file-read-metadata` on ancestor literals is the generic fix; without it, every parent-walking lib in the agent's dep tree is a potential EPERM bomb.

## Finding 12 — Most v1 sandbox friction is TUI dependency tree, not agent code

**Symptom (cumulative):** Across Phase 5 + Phase 5b debugging, the fatal sandbox issues we hit were, in order:

1. Terminal corruption from TUI mounted before reexec.
2. Bun's `~/.bun/install/cache` writes denied (loaded as part of TUI startup).
3. browserslist parent-walk EPERM (transitively required by `@opentui/solid` → Babel).
4. `setRawMode` ioctl denied (TUI initialising stdin).

Plus stderr noise: bun's own `package.json` upward scan, xcode-select probe (likely from OpenTUI's transitive deps).

**Diagnosis:** Every fatal denial originated in the TUI's dependency tree (`@opentui/solid`, Solid runtime, Babel, browserslist). The actual agent surface (Read, Write, Glob, skill loading, the runtime's tool dispatcher, model HTTP egress) hit zero sandbox issues — those operate exactly as the profile intends.

**Fix (immediate):** Patches landed for each denial individually, documented above.

**Fix (architectural):** This is decisive empirical evidence for the B-worker promotion in [ADR-001](./decisions/sandboxing.md#adr-001--sandbox-boundary-b-process-self-reexec). Under B-worker, the TUI lives in the unsandboxed host; the sandboxed worker contains only the engine + runtimes + agent tools. None of the four fatal frictions above could occur because none of the TUI's dependency tree would be in the sandbox in the first place. The promotion-trigger list in ADR-001 already includes "TUI / sandbox lifecycle coupling" as the first trigger; this finding is the receipt.

**Why it matters:** When (not if) a contributor refactors the TUI or adds a new UI dependency, the cycle of "discover new sandbox denial, add allow rule, repeat" will resume. B-process is a working v1 with a meaningful security boundary — but the maintenance shape is "every TUI dep is a potential profile-widening event." B-worker structurally caps that maintenance burden.

## Finding 13 — Kernel-level `log show` predicate is the diagnostic source of truth

**Symptom:** Iterating on the profile for several hours, our default debugging predicate `subsystem == "com.apple.sandbox.reporting"` consistently returned **zero entries** on macOS 26 even when sandbox-exec was actively denying operations and processes were dying with EPERM. We were flying blind.

**Diagnosis:** macOS sandbox denials are emitted by the kernel (`processID == 0`), and the relevant signal is on `senderImagePath CONTAINS '/Sandbox'`, not the userspace reporting subsystem. The reporting-subsystem predicate may have worked on older macOS versions; it's silent on 26.

**Fix:** Use this predicate when debugging:

```sh
/usr/bin/log show --last 10s --style compact --info --debug \
  --predicate '(processID == 0) AND (senderImagePath CONTAINS "/Sandbox")'
```

Output looks like:

```
kernel: (Sandbox) Sandbox: bun(77903) deny(1) file-read-data /Users/em/package.json
kernel: (Sandbox) Sandbox: bun(77903) deny(1) file-read-data /Users/em/Library/Caches/bun/@t@/bcaaf78b786428a7.pile
```

Each line tells you: the *process* (bun pid 77903), the *operation* (`file-read-data`), and the *exact path*. With this, profile iteration is mechanical — you see what's denied, you decide whether to allow or accept the noise. Without it, you're guessing.

**Why it matters:** This single technique would have saved hours of guessing-and-checking. The predicate from n8henrie's gist was right; our default attempt was wrong. Phase 8a (profile-learner spike) should hard-code this predicate. Phase 9 (audit + minimization) is structured around it.

## Finding 14 — Bun's transpiler cache needs *read* allow, not just *write*

**Symptom:** Even after allowing writes to `~/Library/Caches`, kernel log showed `deny(1) file-read-data /Users/em/Library/Caches/bun/@t@/bcaaf78b786428a7.pile` repeatedly. Non-fatal (bun handled internally), but kernel-log spam.

**Diagnosis:** Bun's transpiler maintains a `~/Library/Caches/bun/@t@/*.pile` cache. The pattern is read-after-write: bun computes the cache key, looks up the existing entry (read), and either uses it or transpiles + writes it. Allowing write-only meant bun couldn't reuse cached transcodes — it just kept silently re-transpiling, polluting the kernel log each time.

**Fix:** Add `~/Library/Caches` to `DEV_TOOLING_READ_SUBPATHS` alongside the existing write allow.

**Why it matters:** Generalizable lesson — every cache directory needs *both* read and write to function correctly, even though "write-only" feels logically minimal. Apply this to any new dev-tooling cache added to the profile.

## Finding 15 — Parent-walking libs probe specific config filenames; stat-allow alone isn't enough

**Symptom:** After upgrading ancestor literals to `file-read*` (covering both stat and readdir), bun *still* failed with `error: Cannot read file "/Users/em/": EPERM`. Misleading error message — the actual denial was on `/Users/em/package.json`.

**Diagnosis:** Bun's parent-walker doesn't just stat ancestors and readdir them. It then `open(2)`s specific filenames at each ancestor — `package.json`, `bun.lock`, `bun.lockb`, `tsconfig.json` — to detect workspace roots. Stat succeeds via the directory allow; the file open fails because we don't allow read on files *within* the ancestor directories (literal allows on dirs don't extend to children). Bun's error formatting then surfaces the parent dir path with a trailing slash, hiding which file was actually denied.

**Fix:** Add explicit literal allows for each probed filename at each ancestor:

```scheme
(allow file-read*
  (literal "/Users/em/package.json")
  (literal "/Users/em/bun.lock")
  (literal "/Users/em/bun.lockb")
  (literal "/Users/em/tsconfig.json")
  (literal "/Users/em/src/package.json")
  (literal "/Users/em/src/bun.lock")
  ;; … etc per ancestor
)
```

Implemented as `ancestorProbedFileLiterals(p)` in `profile.ts` — emits 4 filenames × N ancestors.

**Why it matters:** Without this, the misleading error message ("Cannot read file '/Users/em/'") leads debugging in the wrong direction (you investigate the directory, not the file). With Finding 13's kernel predicate, the actual file is visible immediately.

## Finding 16 — `sandbox-exec` literal matching is byte-exact; trailing-slash variants need explicit listing

**Symptom:** `(literal "/Users/em")` in the profile didn't match an open-call on `/Users/em/` (with trailing slash).

**Diagnosis:** sandbox-exec's `(literal "X")` matches the path *exactly as a string*. Trailing slash matters. Some libraries (Bun's parent-walker among them) call `open()` on directory paths in their trailing-slash form, especially when concatenating directory + filename and one of them has a slash boundary. The kernel sees a different string from what the literal rule specifies.

**Fix:** Emit each ancestor literal twice — once without trailing slash and once with:

```scheme
(literal "/Users/em")
(literal "/Users/em/")
```

Implemented in `ancestorLiterals(p)` — interleaves the two forms per ancestor.

**Why it matters:** Generalizable lesson. Subpath rules (`(subpath "X")`) handle both forms automatically (they're path-prefix-based). Literal rules don't. Any literal rule on a path that callers might pass with trailing slash needs both variants.

## Implications for the documented design

- **ADR-014 needs an addendum.** The decision still stands (narrow-allow with system baseline), but the original justification ("we don't `(import "system.sb")` because it's unreliable") was wrong. The corrected position: `(import "system.sb")` is the canonical macOS baseline and we use it. Update should note Findings 1, 2, 3, 4, 5 explicitly so the ADR captures actual deployment knowledge.
- **The auditability budget (ADR-001 addendum) still holds.** Profile is ~120 lines including comments — well within the ≤400 budget.
- **Phase 6 probe categories should expand.** Add probes for the gotchas we discovered: `bun -e` (verifies JIT works), native module load (verifies `file-map-executable`), tmpdir write (verifies symlink canonicalization).

## Quick reference — what to copy into a new sandbox profile

If you ever need to spin up a different macOS sandbox profile from scratch (a separate tool, a different runtime), the minimum viable shape is:

```scheme
(version 1)
(deny default)
(import "system.sb")
(allow mach-bootstrap)
(allow syscall*)
(allow mach-lookup)
(allow sysctl-read)
(allow iokit-open)
(allow ipc-posix-shm)
(allow ipc-posix-sem)
(allow process-fork)
(allow process-exec)
(allow signal (target self))
(allow dynamic-code-generation)
(allow process-info-codesignature)
(allow process-info-pidinfo)
;; Then add file-read* + file-map-executable on whatever paths the
;; tools you intend to run actually need. Remember to realpath() the
;; paths so /var/folders → /private/var/folders.
```

That's the skeleton. Tools that JIT need it; tools that load native modules need `file-map-executable`; everyone needs `file-write*` somewhere for state. Past that, the profile is what it is.
