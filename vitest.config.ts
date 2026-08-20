import { defineConfig } from "vitest/config";

// The e2e and acceptance suites run whole commands and spawn real CLI child
// processes, so their wall-clock time scales with runner load rather than
// with the code under test. They assert correctness, not latency; give them
// headroom over the 5s default instead of racing a loaded CI runner.
const PROCESS_SPAWNING_SUITE_TIMEOUT_MS = 30_000;

export default defineConfig({
  test: {
    coverage: {
      exclude: [
        "src/**/*.generated.ts",
        "src/**/*.d.ts",
        "src/**/main.ts",
        "tests/helpers/**",
      ],
      include: ["src/**/*.ts"],
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      thresholds: {
        branches: 85,
        functions: 90,
        lines: 90,
        statements: 90,
      },
    },
    projects: [
      {
        extends: true,
        test: {
          include: ["tests/unit/**/*.test.ts"],
          name: "unit",
        },
      },
      {
        extends: true,
        test: {
          hookTimeout: PROCESS_SPAWNING_SUITE_TIMEOUT_MS,
          include: ["tests/e2e/**/*.test.ts"],
          name: "e2e",
          testTimeout: PROCESS_SPAWNING_SUITE_TIMEOUT_MS,
        },
      },
      {
        extends: true,
        test: {
          hookTimeout: PROCESS_SPAWNING_SUITE_TIMEOUT_MS,
          include: ["tests/acceptance/**/*.test.ts"],
          name: "acceptance",
          testTimeout: PROCESS_SPAWNING_SUITE_TIMEOUT_MS,
        },
      },
    ],
    restoreMocks: true,
  },
});
