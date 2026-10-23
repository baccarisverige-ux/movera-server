import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["test/support/globalSetup.ts"],
    // Database tests take row locks and wait on each other on purpose; give them room on a slow CI runner.
    testTimeout: 20_000,
  },
});
