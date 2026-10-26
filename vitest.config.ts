import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["test/support/globalSetup.ts"],
    // Database tests take row locks and wait on each other on purpose; give them room on a slow CI runner.
    testTimeout: 20_000,
    // afterAll teardown (app.close + dropping the per-file database) can exceed the 10 s default under load.
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
      reportOnFailure: true,
      // Floors for the critical areas (docs/audit/phase-2.md). Raise when coverage rises; never lower.
      // Measured 2026-10-26 with vitest 5.0.5 / @vitest/coverage-v8 5.0.5, rounded down to a whole percent.
      thresholds: {
        "src/rules/**": { lines: 97, statements: 95, branches: 92, functions: 100 },
        "src/trips/**": { lines: 98, statements: 94, branches: 78, functions: 96 },
        "src/dispatch/**": { lines: 95, statements: 90, branches: 76, functions: 96 },
        "src/auth/**": { lines: 95, statements: 92, branches: 80, functions: 98 },
      },
    },
  },
});
