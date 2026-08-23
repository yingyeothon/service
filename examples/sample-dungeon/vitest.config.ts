import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "sample-dungeon", include: ["test/**/*.test.ts"] },
});
