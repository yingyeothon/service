import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "service-console", include: ["test/**/*.test.ts"] },
});
