import { nullLogger, type Logger } from "@yyt/core";
import { z } from "zod";
import { parseTracerUrl } from "./tracer-url.js";

/*
 * Console → tracer: per-resource daily usage (docs/tracer.md *Limits and
 * raise requests*). The other direction of `/tr/*`, with the same
 * `tracer-token`. tracer serves it from todo/85 P5; until then — and whenever
 * tracer is unreachable — every read is `null`, which the limits view shows as
 * "unknown", never as 0.
 *
 *   GET {tracerUrl}/tr/usage?ids=<id,id,…>&days=<1..7>
 *   GET {tracerUrl}/tr/usage?quotaDay=<YYYY-MM-DD>   (resources with quota drops that day)
 *   → {"usage": {"trc_…": [{"day":"YYYY-MM-DD","bytes":n,"quotaAttachment":n,"quotaRefused":n}, …]}}
 *
 * Days are UTC, newest first; a resource with nothing recorded may be absent.
 */

/** Ids one usage call may name. */
export const TRACER_USAGE_MAX_IDS = 100;
export const TRACER_USAGE_MAX_DAYS = 7;
const TIMEOUT_MS = 2_000;
/** A larger answer is not one tracer would send: refused unread. */
const MAX_BODY_BYTES = 512 * 1024;

const dayRow = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  bytes: z.number().int().nonnegative(),
  quotaAttachment: z.number().int().nonnegative(),
  quotaRefused: z.number().int().nonnegative(),
});
export type TracerUsageDay = z.infer<typeof dayRow>;
const usageBody = z.object({
  usage: z
    .record(z.string().regex(/^trc_[0-9a-z]{26}$/), z.array(dayRow).max(31))
    .refine((u) => Object.keys(u).length <= TRACER_USAGE_MAX_IDS),
});
export type TracerUsage = Record<string, TracerUsageDay[]>;

export interface TracerUsageClient {
  /** The last `days` UTC days of each id; `null` when tracer cannot say. */
  usage(ids: readonly string[], days: number): Promise<TracerUsage | null>;
  /** Resources that dropped data for quota on `day`; `null` when unknown. */
  quotaHits(day: string): Promise<TracerUsage | null>;
}

/** A client that knows nothing: tracer not configured on this stage. */
export const noTracerUsage: TracerUsageClient = {
  usage: () => Promise.resolve(null),
  quotaHits: () => Promise.resolve(null),
};

export function createTracerUsageClient({
  tracerUrl,
  token,
  fetch: fetchFn = fetch,
  timeoutMs = TIMEOUT_MS,
  logger = nullLogger,
}: {
  tracerUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  logger?: Logger;
}): TracerUsageClient {
  let base: URL | undefined;
  try {
    base = parseTracerUrl(tracerUrl);
  } catch {
    // `createTracerRoutes` already logs the bad value.
  }
  if (!base || token === "") return noTracerUsage;
  const origin = base.origin;

  const get = async (query: URLSearchParams): Promise<TracerUsage | null> => {
    try {
      const r = await fetchFn(`${origin}/tr/usage?${query.toString()}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "error",
      });
      if (!r.ok) {
        logger.warn("tracer usage read failed", { status: r.status });
        return null;
      }
      const declared = Number(r.headers.get("content-length") ?? "0");
      const text = declared > MAX_BODY_BYTES ? "" : await r.text();
      if (text === "" || text.length > MAX_BODY_BYTES) {
        logger.warn("tracer usage read failed", { reason: "size" });
        return null;
      }
      const parsed = usageBody.safeParse(JSON.parse(text));
      if (!parsed.success) {
        logger.warn("tracer usage read failed", { reason: "shape" });
        return null;
      }
      return parsed.data.usage;
    } catch (e) {
      // Never the token: only the error's name.
      logger.warn("tracer usage read failed", {
        reason: e instanceof Error ? e.name : "unknown",
      });
      return null;
    }
  };

  return {
    usage: async (ids, days) => {
      const uniq = [...new Set(ids)];
      const d = Math.min(Math.max(1, Math.floor(days)), TRACER_USAGE_MAX_DAYS);
      const out: TracerUsage = {};
      // Batched, so an admin page of 200 requests is not half "nothing
      // recorded"; one failed batch makes the whole answer unknown.
      for (let i = 0; i < uniq.length; i += TRACER_USAGE_MAX_IDS) {
        const batch = uniq.slice(i, i + TRACER_USAGE_MAX_IDS);
        const got = await get(
          new URLSearchParams({ ids: batch.join(","), days: String(d) }),
        );
        if (!got) return null;
        for (const id of batch) if (got[id]) out[id] = got[id];
      }
      return out;
    },
    quotaHits: (day) => get(new URLSearchParams({ quotaDay: day })),
  };
}
