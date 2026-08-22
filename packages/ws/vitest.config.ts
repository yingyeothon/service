import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "ws", include: ["test/**/*.test.ts"] },
});
