import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "jwt", include: ["test/**/*.test.ts"] },
});
