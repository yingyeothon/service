import { existsSync } from "node:fs";
import { join } from "node:path";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRedisKv, kvContractTests, type Kv } from "../src/index.js";

/*
 * The Kv contract against a real Redis in a container, so the Lua scripts
 * (`RELEASE_SCRIPT`, `HASH_TAKE_IF_SCRIPT`) run on the server they ship to and
 * not only through the fake's matchers. Skips without Docker, like the
 * MariaDB suite (`YYT_TC=0` skips it too).
 */
function dockerAvailable(): boolean {
  if (process.env.YYT_TC === "0") return false;
  return (
    process.env.DOCKER_HOST !== undefined ||
    existsSync("/var/run/docker.sock") ||
    existsSync(join(process.env.HOME ?? "", ".docker/run/docker.sock"))
  );
}

describe.skipIf(!dockerAvailable())(
  "createRedisKv contract (container)",
  () => {
    let container: StartedTestContainer | undefined;
    let kv: (Kv & { close(): Promise<void> }) | undefined;
    beforeAll(async () => {
      container = await new GenericContainer("redis:7-alpine")
        .withExposedPorts(6379)
        .start();
      kv = createRedisKv({
        host: container.getHost(),
        port: container.getMappedPort(6379),
        username: "default",
        password: "",
        prefix: "tc:",
      });
    }, 120_000);
    afterAll(async () => {
      await kv?.close();
      await container?.stop();
    });
    kvContractTests(
      { it, expect },
      () => kv!,
      (ms) => new Promise((r) => setTimeout(r, ms)),
    );
  },
);
