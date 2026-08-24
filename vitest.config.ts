import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "services/*", "apps/*"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "services/*/src/**"],
      exclude: ["packages/*/src/generated/**"],
      thresholds: {
        // Aggregated per glob; `perFile` makes every source file meet the bar
        // so one package cannot hide behind the monorepo aggregate.
        "packages/*/src/**": {
          perFile: true,
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 70,
        },
      },
    },
  },
});
