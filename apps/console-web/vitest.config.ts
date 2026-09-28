import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    include: ["test/**/*.test.{ts,tsx}"],
    // jsdom + Mantine under CI's coverage run: a multi-step page test
    // passed 5 s there (KvCollectionPage, 2026-09-28) while taking <1 s locally.
    testTimeout: 15_000,
  },
});
