import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "service-state", include: ["test/**/*.test.ts"] },
});
