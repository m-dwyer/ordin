import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    environment: "node",
    globals: false,
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
