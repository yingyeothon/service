import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "service-topic", include: ["test/**/*.test.ts"] },
});
