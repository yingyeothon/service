import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*",
      "services/*",
      "apps/*",
      // Repository-wide invariants (serverless.yml shapes) live in `test/`.
      { test: { name: "repo", include: ["test/**/*.test.ts"] } },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "services/*/src/**"],
      exclude: ["packages/*/src/generated/**"],
      thresholds: {
        // Per file, not per package: vitest 3 reads `perFile` only here at the
        // top level; inside a glob object it is ignored (`rules/testing.md`).
        perFile: true,
        "packages/*/src/**": {
          lines: 80,
          functions: 80,
          statements: 80,
          branches: 70,
        },
      },
    },
  },
});
