import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "service-auth", include: ["test/**/*.test.ts"] },
});
