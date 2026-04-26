import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    globals: false,
    env: {
      // Tests construct HarnessRuntime, which boots OTel tracing if
      // LANGFUSE_* env vars are set. Without this guard, mise-sourced
      // .env.local would ship test traces to whatever Langfuse the
      // developer has configured.
      ORDIN_TRACING_DISABLED: "1",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json", "lcov"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/types.ts", "src/cli/index.ts"],
      // Thresholds intentionally omitted in Phase 1 — add once a real
      // baseline emerges from actual use, per the plan's "measure, then
      // tune" discipline.
    },
  },
});
