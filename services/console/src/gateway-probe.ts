import { nowSec, systemClock, type Clock, type Logger } from "@yyt/core";
import type { Kv } from "@yyt/redis";

/**
 * Liveness probe for the self-hosted realtime gateway
 * (`docs/decisions.md` *Realtime gateway* → *Monitoring*).
 *
 * The gateway is a single container outside AWS, so no Lambda alarm sees it,
 * and the CloudWatch alarm set is capped at the free tier. This runs on a
 * schedule, GETs `/livez` (never `/healthz`: that answers 503 for a moment on
 * every console redeploy while sessions keep running) and publishes to the
 * stage's SNS topic only on a **transition** — once when the gateway goes
 * down, once when it is back — with the edge recorded in Redis so a
 * multi-hour outage produces one message, not one per tick.
 *
 * Never throws: a probe that fails to probe logs and returns `error`; the
 * scheduled function has no Errors alarm of its own (the 10-alarm cap).
 */

/** Redis key (prefix applied by `Kv`): value is the unix second the outage was first seen. */
export const GATEWAY_DOWN_KEY = "gateway:probe:down";
/** Consecutive-failure counter; reset by any 200. */
export const GATEWAY_FAIL_KEY = "gateway:probe:fails";
/** The edge marker outlives any realistic outage; it is only a dedup, not the source of truth. */
const DOWN_KEY_TTL_SEC = 30 * 24 * 3600;
/** Longer than the tick interval by a margin, so a missed tick does not restart the count. */
const FAIL_KEY_TTL_SEC = 15 * 60;
/**
 * A single failed tick is not an outage: a cold 128 MB Lambda against a 5 s
 * budget, a DNS hiccup or a planned gateway restart all produce one. Two in
 * a row (≈10 min) is the accepted blind spot.
 */
export const DEFAULT_FAILURES_TO_ANNOUNCE = 2;

export type GatewayProbeStatus =
  "skipped" | "up" | "down" | "recovered" | "error";

export interface GatewayProbeResult {
  status: GatewayProbeStatus;
  /** Set on `down`/`recovered`/`error`: whether a notification was attempted. */
  notified?: boolean;
  detail?: string;
}

/**
 * Per-container memory for the one case Redis cannot dedup: the gateway and
 * Redis share a box, so a host outage takes the edge store with it. Owned by
 * the handler module so it lives as long as the container does.
 */
export interface GatewayProbeMemory {
  /** A "down, state unavailable" message has been sent by this container. */
  announcedWithoutState: boolean;
}

export interface GatewayProbeOptions {
  /** The console's `GATEWAY_WS_URL` (`wss://gw.yyt.life`); empty means no gateway on this stage. */
  wsUrl: string;
  kv: Kv;
  /** Publishes to the alarm topic; absent when the stage has none. */
  notify?: (subject: string, message: string) => Promise<void>;
  memory?: GatewayProbeMemory;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  failuresToAnnounce?: number;
  clock?: Clock;
  logger: Logger;
}

/** `wss://host[:port]` → `https://host[:port]`; anything else is refused (never probe an arbitrary URL). */
export function gatewayHttpBase(wsUrl: string): string | undefined {
  let u: URL;
  try {
    u = new URL(wsUrl);
  } catch {
    return undefined;
  }
  if (u.protocol !== "wss:" && u.protocol !== "ws:") return undefined;
  if (u.username || u.password || u.search || u.hash) return undefined;
  const scheme = u.protocol === "wss:" ? "https:" : "http:";
  return `${scheme}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

export async function runGatewayProbe({
  wsUrl,
  kv,
  notify,
  memory = { announcedWithoutState: false },
  fetchFn = fetch,
  timeoutMs = 5000,
  failuresToAnnounce = DEFAULT_FAILURES_TO_ANNOUNCE,
  clock = systemClock,
  logger,
}: GatewayProbeOptions): Promise<GatewayProbeResult> {
  const base = gatewayHttpBase(wsUrl.trim());
  if (!base) {
    // Never the value itself: the rejected shapes include embedded credentials.
    if (wsUrl)
      logger.warn("gateway probe: unusable GATEWAY_WS_URL", {
        length: wsUrl.length,
      });
    return { status: "skipped" };
  }
  const url = `${base}/livez`;
  let failure: string | undefined;
  try {
    const res = await fetchFn(url, {
      method: "GET",
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    if (res.status !== 200) failure = `HTTP ${res.status}`;
  } catch (e) {
    failure = failureName(e, timeoutMs);
  }
  const now = nowSec(clock);
  try {
    if (failure) {
      const fails = await kv.incr(GATEWAY_FAIL_KEY);
      await kv.expire(GATEWAY_FAIL_KEY, FAIL_KEY_TTL_SEC);
      const downSince = await kv.get(GATEWAY_DOWN_KEY);
      if (downSince) {
        logger.warn("gateway probe: still down", {
          url,
          failure,
          fails,
          downSince: Number(downSince),
        });
        return { status: "down", notified: false, detail: failure };
      }
      if (fails < failuresToAnnounce) {
        logger.warn("gateway probe: failed, not yet announced", {
          url,
          failure,
          fails,
        });
        return { status: "down", notified: false, detail: failure };
      }
      // `nx` so two overlapping ticks cannot both announce the same outage.
      const first = await kv.set(GATEWAY_DOWN_KEY, String(now), {
        nx: true,
        ex: DOWN_KEY_TTL_SEC,
      });
      logger.error("gateway probe: down", { url, failure, fails });
      const notified =
        first &&
        (await send(
          notify,
          `[yyt] gateway DOWN: ${base}`,
          `${url} failed ${fails} times in a row: ${failure}\nfirst announced: ${iso(now)}`,
          logger,
        ));
      return { status: "down", notified, detail: failure };
    }
    memory.announcedWithoutState = false;
    await kv.del(GATEWAY_FAIL_KEY);
    const downSince = await kv.get(GATEWAY_DOWN_KEY);
    if (!downSince) return { status: "up" };
    // The delete count is the recovery edge's NX: only the tick that removed
    // the marker announces.
    if ((await kv.del(GATEWAY_DOWN_KEY)) === 0) return { status: "up" };
    const since = Number(downSince);
    logger.warn("gateway probe: recovered", {
      url,
      downSince: since,
      outageSec: now - since,
    });
    const notified = await send(
      notify,
      `[yyt] gateway recovered: ${base}`,
      `${url} answers 200 again.\ndown since: ${iso(since)} (${Math.max(0, now - since)} s)`,
      logger,
    );
    return { status: "recovered", notified };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!failure) {
      logger.error("gateway probe: state error", { url, message });
      return { status: "error", notified: false };
    }
    // Gateway and Redis both unreachable: the box itself is the likeliest
    // cause, and nothing else in this repo would say so. Once per container
    // (`reservedConcurrency: 1` makes that about once per outage).
    logger.error("gateway probe: down, state unavailable", {
      url,
      failure,
      message,
    });
    if (memory.announcedWithoutState)
      return { status: "error", notified: false, detail: failure };
    memory.announcedWithoutState = true;
    const notified = await send(
      notify,
      `[yyt] gateway DOWN, state unavailable: ${base}`,
      `${url} failed: ${failure}\nthe console's Redis on the same host is unreachable too — check the box.\nseen: ${iso(now)}`,
      logger,
    );
    return { status: "error", notified, detail: failure };
  }
}

async function send(
  notify: GatewayProbeOptions["notify"],
  subject: string,
  message: string,
  logger: Logger,
): Promise<boolean> {
  if (!notify) {
    logger.warn("gateway probe: no alarm topic, notification dropped", {
      subject,
    });
    return false;
  }
  try {
    await notify(subject, message);
    return true;
  } catch (e) {
    logger.error("gateway probe: notify failed", {
      subject,
      message: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Error class/code only: Node's fetch failures spell out the resolved address
 * (`connect ECONNREFUSED 1.2.3.4:443`), and this string goes to logs and an
 * e-mail, neither of which should carry the host's address. The code is what
 * tells "Caddy refused" (`ECONNREFUSED`) from "DNS gone" (`ENOTFOUND`) from
 * "certificate" (`CERT_HAS_EXPIRED`); `HTTP 502` already means Caddy is up
 * and the gateway is not.
 */
function failureName(e: unknown, timeoutMs: number): string {
  if (!(e instanceof Error)) return "fetch failed";
  if (e.name === "TimeoutError") return `timeout after ${timeoutMs}ms`;
  const cause: unknown = (e as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code: unknown = (cause as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return e.name || "fetch failed";
}

function iso(sec: number): string {
  return new Date(sec * 1000).toISOString();
}
