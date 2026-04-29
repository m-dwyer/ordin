/**
 * Sandbox interface — confines the agent process tree to a kernel-
 * enforced profile of filesystem (and, later, network) rules. Engine-
 * agnostic by design: any future engine inherits sandboxing without
 * re-implementation.
 *
 * v1 ships `PassthroughSandbox` (no-op default) and `SeatbeltSandbox`
 * (macOS, `sandbox-exec`). Linux (`bwrap`), Docker, and a separate
 * sandboxed-worker variant live behind this same interface.
 *
 * See docs/decisions/sandboxing.md (ADR-001) for the boundary choice.
 */
export interface Sandbox {
  readonly name: string;

  /**
   * If the current process needs to be sandboxed but isn't yet, re-exec
   * under the sandbox (B-process pattern). Otherwise no-op.
   *
   * When re-exec actually happens, the call does not return — the
   * current process is replaced. Callers should treat a resolved
   * Promise as "you may proceed; you're either passthrough or already
   * inside the sandbox."
   */
  enterIfNeeded(params: SandboxParams): Promise<void>;

  /**
   * Diagnostic — is this sandbox usable on the current host?
   * `ordin doctor` surfaces the result.
   */
  readiness(): Promise<SandboxReadiness>;
}

export interface SandboxParams {
  /** Workspace root the agent may read and write. */
  readonly workspaceRoot: string;
  /** Run store dir (default `~/.ordin/runs`) — writable for transcripts and metadata. */
  readonly runStoreDir: string;
  /**
   * Harness content root — where workflows, agents, skills, and (in
   * dev mode) source live. Read-only inside the sandbox; the agent
   * cannot modify ordin's own content.
   *
   * In dev mode this is the harness repo. In distributed mode this
   * becomes a fixed user-data dir like `~/.ordin/` (workflows/agents/
   * skills installed there by `ordin init`). A future v2+ change may
   * widen this to `harnessRoots: readonly string[]` for multi-source
   * setups (bundled defaults + user overrides + project-local).
   */
  readonly harnessRoot: string;
  /** Per-process temp dir; defaults to `os.tmpdir()` when unset. */
  readonly tempDir?: string;
}

export interface SandboxReadiness {
  readonly ok: boolean;
  readonly reasons: readonly string[];
}
