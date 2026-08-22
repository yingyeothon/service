import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "http", include: ["test/**/*.test.ts"] },
});
