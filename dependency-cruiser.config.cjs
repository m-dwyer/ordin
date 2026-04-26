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
      name: "domain-cannot-depend-on-orchestrator",
      severity: "error",
      comment:
        "Domain is pure TypeScript and must not know about the orchestrator.",
      from: { path: "^src/domain" },
      to: { path: "^src/(orchestrator|runtime|cli|infrastructure)/" },
    },
    {
      name: "domain-cannot-depend-on-runtimes",
      severity: "error",
      comment:
        "Domain must not import from runtimes; runtimes adapt to domain, not the reverse.",
      from: { path: "^src/domain" },
      to: { path: "^src/runtimes" },
    },
    {
      name: "runtimes-cannot-depend-on-orchestrator",
      severity: "error",
      comment:
        "Runtimes implement AgentRuntime and must not reach into orchestrator or CLI.",
      from: { path: "^src/runtimes" },
      to: { path: "^src/(orchestrator|runtime|cli)/" },
    },
    {
      name: "infrastructure-cannot-depend-on-application-layers",
      severity: "error",
      comment:
        "Infrastructure adapts disk/YAML/frontmatter into domain objects; it must not depend on orchestrator, runtimes, gates, clients, or the harness runtime.",
      from: { path: "^src/infrastructure" },
      to: { path: "^src/(orchestrator|runtime|runtimes|gates|cli)/" },
    },
    {
      name: "runtimes-cannot-depend-on-gates",
      severity: "error",
      comment: "Gate logic belongs to the orchestrator, not to runtimes.",
      from: { path: "^src/runtimes" },
      to: { path: "^src/gates" },
    },
    {
      name: "gates-cannot-depend-on-orchestrator",
      severity: "error",
      from: { path: "^src/gates" },
      to: { path: "^src/(orchestrator|runtime|cli)/" },
    },
    {
      name: "cli-cannot-reach-past-harness-runtime",
      severity: "error",
      comment:
        "Client interfaces (CLI) only use HarnessRuntime. Never reach into domain/runtimes/orchestrator/infrastructure directly. Exception: src/cli/gate-prompters/ assembles CLI-specific gate resolvers and legitimately imports Gate/HumanGate/AutoGate + the Phase type.",
      from: {
        path: "^src/cli",
        pathNot: "^src/cli/gate-prompters/",
      },
      to: { path: "^src/(domain|runtimes|orchestrator|gates|infrastructure)/" },
    },
    {
      name: "gate-prompters-scoped-to-gate-assembly",
      severity: "error",
      comment:
        "Gate-prompter adapters may import the gate layer and Phase type (to implement Phase['gate'] switch), but nothing else outside src/gates and src/domain/workflow.",
      from: { path: "^src/cli/gate-prompters/" },
      to: { path: "^src/(runtime|runtimes|orchestrator)/" },
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
