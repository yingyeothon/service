import { createJsonLogger, requireEnv } from "@yyt/core";
import { createRedisKv, redisOptionsFromEnv, type Kv } from "@yyt/redis";
import { createAlarmNotify } from "./alarm-notify.js";
import { runCdnGuardWatch } from "./cdn-guard.js";
import {
  runGatewayProbe,
  runTracerProbe,
  type GatewayProbeMemory,
} from "./gateway-probe.js";

/*
 * The scheduled gateway probe's own entry, so its bundle carries the probe,
 * the CDN guard watchdog and Redis — not the console API, Prisma and every
 * AWS client `handler.ts` pulls in (that bundle's init needed ~240 MB and
 * timed out at 128 MB on 2026-10-27).
 */

const logger = createJsonLogger(console);
let probeKv: Kv | undefined;
const probeMemory: GatewayProbeMemory = { announcedWithoutState: false };
const tracerMemory: GatewayProbeMemory = { announcedWithoutState: false };

/**
 * EventBridge every 5 minutes (prod only by schedule; the function exists on
 * every stage so `aws lambda invoke` can run it by hand on dev). Its own Redis
 * connection and no MariaDB. Never throws — it has no Errors alarm
 * (`rules/serverless-aws.md`).
 */
export const gatewayProbe = async (): Promise<void> => {
  const stage = requireEnv(process.env, "STAGE");
  const notify = createAlarmNotify(process.env.ALARM_TOPIC_ARN ?? "");
  try {
    probeKv ??= createRedisKv(redisOptionsFromEnv());
  } catch (e) {
    logger.error("probe: no Redis client", {
      stage,
      message: e instanceof Error ? e.message : String(e),
    });
  }
  const kv = probeKv;
  const run = async (
    label: string,
    probe: () => Promise<Record<string, unknown>>,
  ): Promise<void> => {
    try {
      logger.info(`${label} probe`, { stage, ...(await probe()) });
    } catch (e) {
      logger.error(`${label} probe crashed`, {
        stage,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };
  if (kv)
    // Side by side, not in turn: each can take a 5 s fetch plus a Redis
    // timeout, and the 20 s function timeout must still leave the watchdog.
    // The stage's tracer rides the same schedule and alarm topic (no alarm
    // of its own, docs/tracer.md *Operations*); skipped while `tracer-url`
    // is unset.
    await Promise.all([
      run("gateway", async () => ({
        ...(await runGatewayProbe({
          wsUrl: process.env.GATEWAY_WS_URL ?? "",
          kv,
          memory: probeMemory,
          logger,
          notify,
        })),
      })),
      run("tracer", async () => ({
        ...(await runTracerProbe({
          tracerUrl: process.env.TRACER_URL ?? "",
          kv,
          memory: tracerMemory,
          logger,
          notify,
        })),
      })),
    ]);
  // The CDN guard's watchdog rides this 5-minute schedule (no alarm slot of
  // its own): a stopped guard is announced within about 20 minutes.
  if (probeKv) {
    const watch = await runCdnGuardWatch({
      stage,
      kv: probeKv,
      notify,
      logger,
    });
    logger.info("cdn guard watch", { stage, status: watch });
  } else logger.error("cdn guard watch: skipped, no Redis client", { stage });
};
