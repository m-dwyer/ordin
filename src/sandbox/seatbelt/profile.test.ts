import { describe, expect, it } from "vitest";
import { type ProfileParams, ProfileParamsSchema, renderProfile } from "./profile";

const FIXED_PARAMS: ProfileParams = {
  workspaceRoot: "/Users/test/work/myproj",
  runStoreDir: "/Users/test/.ordin/runs",
  harnessRoot: "/Users/test/src/harness",
  tempDir: "/var/folders/xx/T/run-abc",
  homeDir: "/Users/test",
};

describe("renderProfile — structure", () => {
  it("starts with (version 1) and (deny default)", () => {
    const out = renderProfile(FIXED_PARAMS);
    expect(out.startsWith("(version 1)\n(deny default)")).toBe(true);
  });

  it("is deterministic — same params produce identical output", () => {
    expect(renderProfile(FIXED_PARAMS)).toBe(renderProfile({ ...FIXED_PARAMS }));
  });

  it("escapes embedded quotes and backslashes in paths", () => {
    const out = renderProfile({
      ...FIXED_PARAMS,
      workspaceRoot: '/tmp/weird"path\\with-special',
    });
    expect(out).toContain('(subpath "/tmp/weird\\"path\\\\with-special")');
  });
});

describe("renderProfile — allows what's necessary", () => {
  const out = renderProfile(FIXED_PARAMS);

  it("allows the workspace as a writable subpath", () => {
    expect(out).toContain('(subpath "/Users/test/work/myproj")');
    // Workspace must appear in BOTH a read-allow and a write-allow group.
    const writeBlock = out.split("(allow file-write*")[1] ?? "";
    expect(writeBlock).toContain('(subpath "/Users/test/work/myproj")');
  });

  it("allows the run store and temp dir for read+write", () => {
    const writeBlock = out.split("(allow file-write*")[1] ?? "";
    expect(writeBlock).toContain('(subpath "/Users/test/.ordin/runs")');
    expect(writeBlock).toContain('(subpath "/var/folders/xx/T/run-abc")');
  });

  it("allows ~/.claude for read (Claude Max-plan auth)", () => {
    expect(out).toContain('(allow file-read*\n  (subpath "/Users/test/.claude"))');
  });

  it("allows the harness content root for read but NOT for write", () => {
    expect(out).toContain('(subpath "/Users/test/src/harness")');
    const writeBlock = out.split("(allow file-write*")[1] ?? "";
    expect(writeBlock).not.toContain('(subpath "/Users/test/src/harness")');
  });

  it("allows writes to dev-tooling cache dirs (bun, npm, cache, cargo registry, pnpm-store, Library/Caches)", () => {
    const writeBlock = out.split("(allow file-write*")[1] ?? "";
    const expected = [
      "/Users/test/.bun",
      "/Users/test/.npm",
      "/Users/test/.cache",
      "/Users/test/.cargo/registry",
      "/Users/test/.pnpm-store",
      "/Users/test/Library/Caches",
    ];
    for (const path of expected) {
      expect(writeBlock).toContain(`(subpath "${path}")`);
    }
  });

  it("does NOT allow writes to ~/.cargo/credentials (only registry cache)", () => {
    const writeBlock = out.split("(allow file-write*")[1] ?? "";
    expect(writeBlock).not.toContain('(subpath "/Users/test/.cargo/credentials")');
  });

  it("allows the documented dev-tooling roots", () => {
    const expected = [
      "/Users/test/.local",
      "/Users/test/.bun",
      "/Users/test/.cargo",
      "/Users/test/.rustup",
      "/Users/test/.asdf",
      "/Users/test/.nvm",
      "/Users/test/.npm",
      "/Users/test/.pnpm-store",
    ];
    for (const path of expected) {
      expect(out).toContain(`(subpath "${path}")`);
    }
  });

  it("imports the macOS system baseline (system.sb) for dyld + frameworks + mach services", () => {
    expect(out).toContain('(import "system.sb")');
  });

  it("allows the additional system roots beyond what system.sb covers", () => {
    const expected = ["/usr", "/bin", "/sbin", "/private/etc", "/Library", "/Applications", "/opt"];
    for (const path of expected) {
      expect(out).toContain(`(subpath "${path}")`);
    }
  });

  it("allows JIT / dynamic code generation (required by Bun, V8, JVMs)", () => {
    expect(out).toContain("(allow dynamic-code-generation)");
  });

  it("allows file-ioctl on /dev (TUI tty raw-mode setup needs TIOCSETA)", () => {
    expect(out).toContain('(allow file-ioctl\n  (subpath "/dev"))');
  });

  it("allows file-read* on ancestor dirs of workspace + harness roots (parent-walking config-discovery libs)", () => {
    // The ancestor block follows the workspace+run-store+temp file-read
    // group; capture the slice between that section's allow and the
    // file-write* block.
    const ancestorBlock =
      out.split('(subpath "/private/tmp"))')[1]?.split("(allow file-write*")[0] ?? "";
    // Ancestors of /Users/test/work/myproj (workspace)
    expect(ancestorBlock).toContain('(literal "/Users/test/work")');
    // Ancestors of /Users/test/src/harness (harnessRoot)
    expect(ancestorBlock).toContain('(literal "/Users/test/src")');
    // Common ancestors
    expect(ancestorBlock).toContain('(literal "/Users/test")');
    expect(ancestorBlock).toContain('(literal "/Users")');
    expect(ancestorBlock).toContain('(literal "/")');
  });

  it("allows stdio device writes as literals (not /dev as a subpath)", () => {
    const writeBlock = out.split("(allow file-write*")[1]?.split("(deny file-read*")[0] ?? "";
    expect(writeBlock).toContain('(literal "/dev/null")');
    expect(writeBlock).toContain('(literal "/dev/stdout")');
    expect(writeBlock).toContain('(literal "/dev/stderr")');
    // The write-allow block must NOT broadly write to /dev — only the
    // narrow stdio literals above. (file-ioctl on /dev is separate
    // and tested elsewhere.)
    expect(writeBlock).not.toContain('(subpath "/dev")');
  });
});

describe("renderProfile — denies what shouldn't be reachable", () => {
  const out = renderProfile(FIXED_PARAMS);

  it("denies every documented credential dir as defense-in-depth", () => {
    const expected = [
      "/Users/test/.ssh",
      "/Users/test/.aws",
      "/Users/test/.gnupg",
      "/Users/test/.docker",
      "/Users/test/.config/gh",
      "/Users/test/.config/op",
      "/Users/test/.config/1Password",
    ];
    for (const path of expected) {
      expect(out).toContain(`(subpath "${path}")`);
    }
  });

  it("denies single-file credential leak paths", () => {
    expect(out).toContain('(literal "/Users/test/.netrc")');
    expect(out).toContain('(literal "/Users/test/.git-credentials")');
    expect(out).toContain('(literal "/Users/test/.npmrc")');
    expect(out).toContain('(literal "/Users/test/.pypirc")');
  });

  it("does NOT include ~/.claude in writable paths", () => {
    const writeBlock = out.split("(allow file-write*")[1] ?? "";
    expect(writeBlock).not.toContain('(subpath "/Users/test/.claude")');
  });

  it("does NOT broadly allow ~/Documents, ~/Desktop, ~/Downloads, iCloud, Mail, Messages", () => {
    // Narrow-allow means none of these paths appear in the profile at
    // all — they're denied by default. Any future widening would have
    // to add an explicit allow that this assertion would catch.
    const sensitive = [
      "/Users/test/Documents",
      "/Users/test/Desktop",
      "/Users/test/Downloads",
      "/Users/test/Movies",
      "/Users/test/Pictures",
      "/Users/test/Library/Mail",
      "/Users/test/Library/Messages",
      "/Users/test/Library/Mobile Documents",
      "/Users/test/Library/Application Support/Slack",
      "/Users/test/Library/Application Support/discord",
      "/Users/test/Library/Application Support/Signal",
    ];
    for (const path of sensitive) {
      expect(out).not.toContain(`"${path}"`);
    }
  });

  it("does NOT broadly allow ~/Library/Application Support (covers app data)", () => {
    // The pnpm allow is /Users/test/Library/pnpm specifically, NOT a
    // subpath of Application Support. Verify we haven't slipped.
    const allowBlock = out.split("(deny file-read*")[0] ?? "";
    expect(allowBlock).not.toContain('(subpath "/Users/test/Library/Application Support")');
  });
});

describe("ProfileParamsSchema", () => {
  it("rejects empty workspaceRoot", () => {
    expect(() => ProfileParamsSchema.parse({ ...FIXED_PARAMS, workspaceRoot: "" })).toThrow();
  });

  it("rejects missing fields", () => {
    expect(() =>
      ProfileParamsSchema.parse({
        workspaceRoot: "/x",
        runStoreDir: "/y",
        tempDir: "/z",
      }),
    ).toThrow();
  });

  it("rejects empty harnessRoot", () => {
    expect(() => ProfileParamsSchema.parse({ ...FIXED_PARAMS, harnessRoot: "" })).toThrow();
  });
});
