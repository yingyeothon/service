import { nullLogger, type Logger } from "@yyt/core";
import { hmacSign, SIGNATURE_HEADER } from "@yyt/jwt";

export interface CallbackBody {
  matchId: string;
  channelId: string;
  members: Array<{ userId: string }>;
  partial: boolean;
}

export type DispatchOutcome =
  { ok: true; result: unknown } | { ok: false; reason: string };

export interface Dispatcher {
  /** `POST callbackUrl` with `X-Yyt-Signature`; one retry on network error / 5xx. */
  dispatch(input: {
    callbackUrl: string;
    apiKey: string;
    body: CallbackBody;
  }): Promise<DispatchOutcome>;
}

export interface DispatcherOptions {
  fetch?: typeof fetch;
  /** Per attempt. Default 5000ms (two attempts fit in the worker's timeout). */
  timeoutMs?: number;
  /** Max response bytes accepted as `result`. Default 8KB (fits the 16KB message cap with the envelope). */
  maxResultBytes?: number;
  logger?: Logger;
}

const RETRIES = 1;

/** Reads at most `cap` bytes; `undefined` when the body is larger (the rest is discarded). */
async function readCapped(
  res: Response,
  cap: number,
): Promise<string | undefined> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > cap) {
    await res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createDispatcher({
  fetch: doFetch = fetch,
  timeoutMs = 5000,
  maxResultBytes = 8 * 1024,
  logger = nullLogger,
}: DispatcherOptions = {}): Dispatcher {
  async function attempt(
    callbackUrl: string,
    apiKey: string,
    text: string,
  ): Promise<DispatchOutcome & { retry?: boolean }> {
    let res: Response;
    try {
      res = await doFetch(callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: hmacSign(text, apiKey),
        },
        body: text,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      logger.warn("callback request failed", {
        message: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, reason: "callback", retry: true };
    }
    if (res.status < 200 || res.status >= 300) {
      logger.warn("callback non-2xx", { status: res.status });
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, reason: "callback", retry: res.status >= 500 };
    }
    const body = await readCapped(res, maxResultBytes);
    if (body === undefined) {
      logger.warn("callback result too large", { cap: maxResultBytes });
      return { ok: false, reason: "callback" };
    }
    if (body.trim() === "") return { ok: true, result: null };
    try {
      return { ok: true, result: JSON.parse(body) as unknown };
    } catch {
      logger.warn("callback result is not JSON");
      return { ok: false, reason: "callback" };
    }
  }

  return {
    dispatch: async ({ callbackUrl, apiKey, body }) => {
      let url: URL;
      try {
        url = new URL(callbackUrl);
      } catch {
        return { ok: false, reason: "callback" };
      }
      if (url.protocol !== "https:" && url.protocol !== "http:")
        return { ok: false, reason: "callback" };
      const text = JSON.stringify(body);
      let last: DispatchOutcome = { ok: false, reason: "callback" };
      for (let i = 0; i <= RETRIES; i++) {
        const { retry, ...r } = await attempt(callbackUrl, apiKey, text);
        if (r.ok || !retry) return r;
        last = r;
      }
      return last;
    },
  };
}
