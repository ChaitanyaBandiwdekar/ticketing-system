import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // One Postgres for the whole run (embedded locally, TEST_DATABASE_URL in CI / remote).
    globalSetup: ["test/setup/global-setup.ts"],
    // Concurrency tests open real pools; keep files sequential so they don't fight over connections.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
