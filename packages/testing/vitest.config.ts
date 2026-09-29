import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "testing", include: ["test/**/*.test.ts"] },
});
