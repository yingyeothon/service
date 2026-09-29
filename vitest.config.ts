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
        // Aggregated per glob. `perFile: true` inside this object is NOT read
        // by vitest 3 (only a top-level `thresholds.perFile` is), so the bar
        // has always been the package aggregate; hoisting it (2026-09-29,
        // `todo/53`) exposed five files below 80 % (`redis/aclAdmin`,
        // `redis/memoryAclAdmin`, `core/docKey`, `core/channel`, `ws/poster`)
        // — a backlog item, not a test-only dedup's. Hoist it once those are
        // covered.
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
