import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "sqlite-s3", include: ["test/**/*.test.ts"] },
});
