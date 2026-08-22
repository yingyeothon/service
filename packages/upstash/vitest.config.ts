import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "upstash", include: ["test/**/*.test.ts"] },
});
