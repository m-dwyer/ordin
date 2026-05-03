/**
 * Sandbox interface — confines the agent process tree to a kernel-
 * enforced profile of filesystem (and, later, network) rules. Engine-
 * agnostic by design: any future engine inherits sandboxing without
 * re-implementation.
 *
 * Ships `PassthroughSandbox` (no-op default) and `SrtSandbox`
 * (`@anthropic-ai/sandbox-runtime` — Seatbelt on macOS, bwrap+seccomp
 * on Linux, plus deny-by-default network egress through localhost
 * proxies). A separate sandboxed-worker variant lives behind this
 * same interface.
 *
 * See docs/decisions/sandboxing.md (ADR-001) for the boundary choice.
 */
export interface Sandbox {
  readonly name: string;

  /**
   * Bring the sandbox up: validate readiness, start the broker (if any),
   * initialise srt or equivalent and wait for the network stack. Resolves
   * once the parent can call `spawnWorker`. Idempotent on repeated calls.
   *
   * Under L2 the parent stays as the parent — `enterIfNeeded` no longer
   * reexecs. Per-phase isolation comes from `spawnWorker` instead.
   */
  enterIfNeeded(params: SandboxParams): Promise<void>;

  /**
   * Spawn one sandboxed worker that the parent supervises. Each call
   * produces a fresh process with the impl-specific isolation applied
   * (passthrough = direct `Bun.spawn`; srt = wrapped via
   * `manager.wrapWithSandbox`). The handle exposes the eventual exit
   * code and a `kill` for abort propagation.
   */
  spawnWorker(plan: WorkerPlan): WorkerHandle;

  /**
   * Tear down the sandbox: stop the broker, release srt resources.
   * Called by the harness once the run is finished.
   */
  shutdown(): Promise<void>;

  /**
   * Diagnostic — is this sandbox usable on the current host?
   * `ordin doctor` surfaces the result.
   */
  readiness(): Promise<SandboxReadiness>;
}

/** Plan a worker execution. Pure data — no live handles. */
export interface WorkerPlan {
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface WorkerHandle {
  /** Resolves with the child's exit code (or 128+signal on signalled exit). */
  readonly exit: Promise<number>;
  /** Optional abort — best-effort delivery of `signal` to the worker. */
  kill(signal?: NodeJS.Signals): void;
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
