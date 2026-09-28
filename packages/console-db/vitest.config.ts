import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "console-db",
    include: ["test/**/*.test.ts"],
    // The container contracts make real MariaDB round trips; under CI's
    // coverage run a few of them passed 5 s and kept `node` red for days.
    testTimeout: 20_000,
  },
});
