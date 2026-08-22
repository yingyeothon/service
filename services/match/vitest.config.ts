import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "service-match", include: ["test/**/*.test.ts"] },
});
