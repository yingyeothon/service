import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "console-db", include: ["test/**/*.test.ts"] },
});
