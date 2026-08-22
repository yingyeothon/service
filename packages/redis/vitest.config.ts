import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "redis", include: ["test/**/*.test.ts"] },
});
