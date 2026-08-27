import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "sample-morpg", include: ["test/**/*.test.ts"] },
});
