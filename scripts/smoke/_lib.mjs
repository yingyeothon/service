// Shared plumbing for the smoke scripts (`_team.mjs` holds the team seating).
// Every helper takes the values a script used to hard-code — base URL, write
// slot, timeouts, summary strings — so migrating a script changes nothing it
// prints or sends. The library prints only what a caller passes to `check`;
// callers keep tokens, cookies and presigned URLs out of those arguments.
import http from "node:http";
import https from "node:https";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `check(label, ok, extra)` prints one `ok  `/`FAIL` line and counts failures;
 * `finish(okText, failText)` prints the script's own summary and exits 0/1.
 */
export function createChecker() {
  let failed = 0;
  return {
    check: (label, ok, extra = "") => {
      console.log(`${ok ? "ok  " : "FAIL"} ${label} ${extra}`);
      if (!ok) failed++;
    },
    failed: () => failed,
    finish: (okText, failText) => {
      console.log(failed === 0 ? okText : failText(failed));
      process.exit(failed === 0 ? 0 : 1);
    },
  };
}

/**
 * Prints the crash and a summary line before exiting: on Node >= 22 a rejected
 * top-level `await` is an `uncaughtException`, so both hooks are needed.
 */
export function exitOnCrash(summary = "\n1 FAILED (crashed)") {
  const crashed = (e) => {
    console.error(e);
    console.log(summary);
    process.exit(1);
  };
  process.on("uncaughtException", crashed);
  process.on("unhandledRejection", crashed);
}

/**
 * JSON fetch: `call(url, {method, headers, body})` → `{status, body, text,
 * headers, etag, cache}`. `url` may be a path under `base` or absolute.
 * `writeSlotMs` sleeps before every non-GET (the per-member recorded-write
 * slot); `timeoutMs` aborts a hung request; `redirect` is fetch's option.
 * Absolute URLs are sent as given: never pass a session cookie with a host
 * other than the console (a CDN or bucket URL from a response body).
 */
export function jsonClient({
  base = "",
  writeSlotMs = 0,
  timeoutMs,
  redirect,
} = {}) {
  return async (url, { method = "GET", headers = {}, body } = {}) => {
    if (writeSlotMs > 0 && method !== "GET") await sleep(writeSlotMs);
    const res = await fetch(url.startsWith("http") ? url : `${base}${url}`, {
      method,
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      ...(redirect ? { redirect } : {}),
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON (204s, HTML) */
    }
    return {
      status: res.status,
      body: json,
      text,
      headers: res.headers,
      etag: res.headers.get("etag"),
      cache: res.headers.get("cache-control"),
    };
  };
}

/**
 * Console `POST /debug/login` for a synthetic member (negative `githubId`,
 * unique per script — the hook upserts by it). Returns the cookie plus what
 * the callers need to seat and demote the member later.
 */
export function debugLogin(call, base, debugKey, check) {
  return async (login, role, githubId) => {
    const r = await call(`${base}/debug/login`, {
      method: "POST",
      headers: { "x-debug-key": debugKey },
      body: { login, githubId, role },
    });
    check(`debug login ${login}/${role}`, r.status === 200, String(r.status));
    return { cookie: r.body?.cookie, id: r.body?.memberId, login, githubId };
  };
}

/** The headers a cookie session needs: the cookie and the CSRF `origin`. */
export const asUser = (base) => (u) => ({ cookie: u.cookie, origin: base });

/**
 * The one-admin variant the socket smokes use: log in, return the headers
 * for the console. `check` label is `console debug login`.
 */
export async function consoleLogin(call, consoleBase, debugKey, who, check) {
  const r = await call(`${consoleBase}/debug/login`, {
    method: "POST",
    headers: { "x-debug-key": debugKey },
    body: who,
  });
  check("console debug login", r.status === 200);
  return { cookie: r.body?.cookie, origin: consoleBase };
}

/** Auth `POST /debug/token` → `(userId) => jwt` for one channel. */
export const mintToken =
  (call, authBase, debugKey, channelId) => async (userId) =>
    (
      await call(`${authBase}/debug/token`, {
        method: "POST",
        headers: { "x-debug-key": debugKey },
        body: { channelId, userId },
      })
    ).body?.jwt;

/**
 * A queueing WebSocket client over Node's global `WebSocket` with the bearer
 * subprotocol. Every timeout is a per-script default; `handshakeMs` (when set)
 * rejects a connect that never opens.
 */
export function wsConnector({
  nextMs = 15000,
  untilMs = nextMs,
  closeMs = nextMs,
  handshakeMs,
} = {}) {
  return (url, token) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url, ["bearer", token]);
      const messages = [];
      const waiters = [];
      let closed = false;
      let closeCode = null;
      const handshake = handshakeMs
        ? setTimeout(() => {
            ws.close();
            reject(new Error("ws handshake timeout"));
          }, handshakeMs)
        : null;
      ws.addEventListener("open", () => {
        if (handshake) clearTimeout(handshake);
        resolve(client);
      });
      ws.addEventListener("error", () => {
        if (handshake) clearTimeout(handshake);
        reject(new Error("ws error"));
      });
      ws.addEventListener("message", (e) => {
        const m = JSON.parse(e.data);
        if (waiters.length > 0) waiters.splice(0).forEach((w) => w(m));
        else messages.push(m);
      });
      ws.addEventListener("close", (e) => {
        closed = true;
        closeCode = e.code;
        waiters.splice(0).forEach((w) => w(null));
      });
      const client = {
        ws,
        messages,
        isClosed: () => closed,
        code: () => closeCode,
        send: (m) => ws.send(JSON.stringify(m)),
        close: () => ws.close(),
        /** Next frame, or `null` on close/timeout. */
        next: (ms = nextMs) =>
          new Promise((r) => {
            if (messages.length > 0) return r(messages.shift());
            if (closed) return r(null);
            const t = setTimeout(() => r(null), ms);
            waiters.push((m) => {
              clearTimeout(t);
              r(m);
            });
          }),
        /** First frame whose `type` is `match` (or that satisfies it), discarding others. */
        until: async (match, ms = untilMs) => {
          const pred =
            typeof match === "function" ? match : (m) => m.type === match;
          const end = Date.now() + ms;
          for (;;) {
            const m = await client.next(Math.max(1, end - Date.now()));
            if (m === null || pred(m)) return m;
          }
        },
        /** `true` once closed within `ms`. */
        waitClose: (ms = closeMs) =>
          new Promise((r) => {
            if (closed) return r(true);
            const t = setTimeout(() => r(false), ms);
            ws.addEventListener("close", () => {
              clearTimeout(t);
              r(true);
            });
          }),
        /** The close code once closed within `ms`, else `null`. */
        waitCloseCode: (ms = closeMs) =>
          new Promise((r) => {
            if (closeCode !== null) return r(closeCode);
            const t = setTimeout(() => r(null), ms);
            ws.addEventListener("close", (e) => {
              clearTimeout(t);
              r(e.code);
            });
          }),
      };
    });
}

/** `true` when the handshake is refused (the connect rejects). */
export const wsRejected = (connect) => async (url, token) => {
  try {
    const c = await connect(url, token);
    c.close();
    return false;
  } catch {
    return true;
  }
};

/**
 * The HTTP status a WebSocket upgrade is answered with. fetch (undici)
 * forbids the `connection`/`upgrade` headers, so the handshake is sent by
 * hand. `0` on a socket error or, with `timeoutMs`, on a stalled request.
 */
export const refusedUpgrade = (url, protocols, { timeoutMs } = {}) =>
  new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === "wss:" ? https : http;
    const req = mod.request(
      {
        host: u.hostname,
        port: u.port || (u.protocol === "wss:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "AAAAAAAAAAAAAAAAAAAAAA==",
          ...(protocols
            ? { "sec-websocket-protocol": protocols.join(", ") }
            : {}),
        },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(0));
    if (timeoutMs)
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        resolve(0);
      });
    req.end();
  });
