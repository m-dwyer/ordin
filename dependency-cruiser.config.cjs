/**
 * Architectural rules for the four load-bearing separations
 * (see harness-plan.md Part 2 — Architecture).
 *
 * Stage 1: rules are authored but not CI-enforced. Run locally via
 * `bun run deps:check` to catch layer violations while you work.
 */
/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "domain-is-core",
      severity: "error",
      comment:
        "Domain is the core vocabulary. It must not import other local src layers.",
      from: { path: "^src/domain" },
      to: { path: "^src/(?!domain(?:/|$))" },
    },
    {
      name: "domain-cannot-depend-on-orchestrator",
      severity: "error",
      comment:
        "Domain is pure TypeScript and must not know about the orchestrator.",
      from: { path: "^src/domain" },
      to: { path: "^src/(orchestrator|composition|cli|infrastructure)/" },
    },
    {
      name: "domain-cannot-depend-on-runtimes",
      severity: "error",
      comment:
        "Domain must not import from runtimes; runtimes adapt to domain, not the reverse.",
      from: { path: "^src/domain" },
      to: { path: "^src/worker/runtimes" },
    },
    {
      name: "infrastructure-cannot-depend-on-application-layers",
      severity: "error",
      comment:
        "Infrastructure adapts disk/YAML/frontmatter into domain objects; it must not depend on orchestrator, runtimes, gates, clients, or the harness.",
      from: { path: "^src/infrastructure" },
      to: { path: "^src/(orchestrator|composition|application|worker|gates|cli)/" },
    },
    {
      name: "application-cannot-depend-on-composition-or-cli",
      severity: "error",
      comment:
        "Application use cases depend on ports (interfaces). Concrete adapters live in composition; composition injects them. Production code never reaches the other way; co-located *.test.ts files are exempt because they wire real adapters to exercise the use cases end-to-end.",
      from: { path: "^src/application", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/(composition|cli)/" },
    },
    {
      name: "application-cannot-depend-on-infrastructure",
      severity: "error",
      comment:
        "Application orchestrates over abstractions. Infrastructure (disk loaders) is injected via composition through ports.",
      from: { path: "^src/application", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/infrastructure/" },
    },
    {
      name: "application-cannot-value-import-sandbox-or-worker",
      severity: "error",
      comment:
        "Application may reference Sandbox / worker types via type-only edges; no value imports of either layer.",
      from: { path: "^src/application", pathNot: "\\.test\\.ts$" },
      to: { path: "^src/(sandbox|worker)/", dependencyTypesNot: ["type-only"] },
    },
    {
      name: "gates-cannot-depend-on-orchestrator",
      severity: "error",
      from: { path: "^src/gates" },
      to: { path: "^src/(orchestrator|composition|cli)/" },
    },
    {
      name: "cli-cannot-reach-past-harness",
      severity: "error",
      comment:
        "Client interfaces (CLI) only use Harness. Never reach into domain/runtimes/orchestrator/infrastructure directly. Exception: src/cli/gate-prompters/ and src/cli/tui/ are CLI-side adapters that legitimately import gates/* (Gate/HumanGate/AutoGate + the Phase type) and the harness's own RunEvent/RunMeta type re-exports. Also exempt: src/cli/run-command.ts and src/cli/run-seed.ts — CLI-flag-to-StartRunInput resolvers that need domain workflow/phase types to reconstruct prior runs (--again) and to seed/capture artefact fixtures by phase id.",
      from: {
        path: "^src/cli",
        pathNot: "^src/cli/(gate-prompters|tui)/|^src/cli/run-(command|seed)\\.ts$",
      },
      to: { path: "^src/(domain|worker|orchestrator|gates|infrastructure|application)/" },
    },
    {
      name: "cli-adapters-scoped",
      severity: "error",
      comment:
        "CLI-side adapters (gate-prompters, tui) may import the gate layer + Phase type, but never the concrete runtimes or the orchestrator's internals. Event/Run types are accessed through composition/harness re-exports.",
      from: { path: "^src/cli/(gate-prompters|tui)/" },
      to: { path: "^src/(worker|orchestrator)/" },
    },
    {
      name: "sandbox-is-leaf",
      severity: "error",
      comment:
        "Sandbox is a self-contained isolation primitive. It is consumed by the harness and CLI; it must not depend on other ordin layers.",
      from: { path: "^src/sandbox" },
      to: {
        path: "^src/(domain|orchestrator|worker|gates|cli|infrastructure|composition|run-service|observability)/",
      },
    },
    {
      name: "worker-isolation",
      severity: "error",
      comment:
        "src/worker/** is the sandboxed code path. It may only value-import from src/worker/**, externals, src/broker/client/** (the BrokerClient transport contract), and the pure domain Tool Authority + Tool Policy rules it must share with Broker Dispatch. Type-only edges are allowed anywhere. Every other value-import is attack surface inside the sandbox.",
      from: {
        path: "^src/worker/",
        pathNot: "\\.test\\.ts$",
      },
      to: {
        path: "^src/",
        pathNot: [
          "^src/worker/",
          "^src/broker/client/",
          "^src/domain/tool-authority\\.ts$",
          "^src/domain/tool-policy\\.ts$",
        ],
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "no-parent-value-imports-of-worker",
      severity: "error",
      comment:
        "Parent code (anything outside src/worker/) must not value-import worker implementation modules. Two value-imports are legal: (1) src/worker/locator.ts — the argv prefix the parent uses to spawn the worker; (2) src/worker/runtimes/registry.ts — the KNOWN_RUNTIME_NAMES set the engine validates against. Both are contract surfaces, not implementation. Type-only imports of worker types (PhaseInvocationResult, AgentRuntime, etc.) are fine — erased at build.",
      from: {
        path: "^src/(?!worker/)",
        pathNot: "^src/worker/",
      },
      to: {
        path: "^src/worker/",
        pathNot: ["^src/worker/locator\\.ts$", "^src/worker/runtimes/registry\\.ts$"],
        dependencyTypesNot: ["type-only"],
      },
    },
    {
      name: "no-orphans",
      severity: "warn",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$",
          "\\.d\\.ts$",
          "(^|/)tsconfig\\.json$",
          "(^|/)package\\.json$",
        ],
      },
      to: {},
    },
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    // Follow `import type` edges so interface-only modules (e.g.
    // runtimes/types.ts, gates/types.ts) don't appear orphaned.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
    },
    includeOnly: "^src",
  },
};
