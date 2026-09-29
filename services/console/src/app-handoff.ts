import {
  AppError,
  randomHex,
  sha256Hex,
  type Clock,
  type Logger,
} from "@yyt/core";
import type { ConsoleDb } from "@yyt/console-db";
import { defineRoute, json, redirect, type AnyRoute } from "@yyt/http";
import type { Kv } from "@yyt/redis";
import { z } from "zod";
import { requireTokenRoom, type TokenMinter } from "./api-token.js";
import { requireRole, type ConsoleIdentity } from "./identity.js";

/**
 * Web → app sign-in handoff (`docs/decisions.md` _Console app_, todo/49).
 *
 * The SPA's "Open app" button asks for a code, then navigates to a Chrome
 * `intent://` URL that carries it into the 잉여톤 app, which exchanges it for
 * a `yyt_` token. The code is an authorization code, not the secret: 128
 * bits random, `HANDOFF_TTL_SEC` long, consumed on first use, keyed in Redis
 * by digest, and never logged. Whatever a browser or logcat retains of the
 * intent URL is therefore worthless after one exchange or two minutes.
 */
export const HANDOFF_TTL_SEC = 120;
export const HANDOFF_CODE = /^hoff_[0-9a-f]{32}$/;
/** The Android package the SPA's intent URL pins and `assetlinks.json` names. */
export const ANDROID_PACKAGE = "life.yyt.console";
const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

const exchangeBody = z
  .object({ code: z.string().regex(HANDOFF_CODE) })
  .strict();

const gone = () =>
  new AppError(
    "gone",
    "handoff code expired or already used; open the app again",
  );

/** `app handoff 2026-09-29 12:34` — the same shape the App login QR uses. */
export function handoffTokenName(clock: Clock): string {
  return `app handoff ${new Date(clock.now()).toISOString().slice(0, 16).replace("T", " ")}`;
}

/**
 * The Digital Asset Links statement Android reads to verify the app's
 * `https://console…/app-open` intent filter. Fingerprints are the release
 * signing certificate's SHA-256 (`AA:BB:…`), configured per stage.
 */
export function assetLinks(fingerprints: readonly string[]): unknown[] {
  return [
    {
      relation: ["delegate_permission/common.handle_all_urls"],
      target: {
        namespace: "android_app",
        package_name: ANDROID_PACKAGE,
        sha256_cert_fingerprints: [...fingerprints],
      },
    },
  ];
}

export function createAppHandoffRoutes({
  kv,
  db,
  clock,
  writeSlot,
  mint,
  logger,
  webUrl,
  androidCertFingerprints = [],
}: {
  kv: Kv;
  db: Pick<ConsoleDb, "findMember" | "listApiTokens">;
  clock: Clock;
  writeSlot: (id: ConsoleIdentity) => Promise<void>;
  mint: TokenMinter;
  logger: Logger;
  /** SPA base (`…/ui`), where a browser that loads the https form is sent. */
  webUrl: string;
  androidCertFingerprints?: readonly string[];
}): AnyRoute[] {
  const key = (code: string) => `handoff:${sha256Hex(code)}`;
  // `keytool -list -v` form: 32 colon-separated bytes. A pasted value in any
  // other shape (no colons, a `SHA256:` prefix) would make Android's
  // verifier fail silently, so it is dropped with a log line instead.
  const fingerprints = androidCertFingerprints
    .map((f) => f.trim().toUpperCase())
    .filter((f) => {
      if (f === "") return false;
      if (FINGERPRINT.test(f)) return true;
      logger.warn("android cert fingerprint ignored: not AA:BB:… form", {
        length: f.length,
      });
      return false;
    });
  return [
    {
      method: "POST",
      path: "/auth/app-handoff",
      auth: true,
      handler: async (ctx) => {
        // Parity with `POST /tokens`: `pending` may start, and the exchange
        // refuses before minting, so the button on a pending Home is hidden
        // by the SPA rather than by this route.
        const id = requireRole(ctx, "pending");
        // The browser's session is what is handed over; a `yyt_` bearer
        // minting a second token under another id is a laundering path the
        // route has no reason to offer (`POST /tokens` is the bearer's way).
        if (id.kind !== "session")
          throw new AppError(
            "forbidden",
            "open the app from the console web session",
          );
        // Refused here so the browser learns of a full token list before
        // the app is even launched (and before the slot is spent); the
        // exchange checks again.
        await requireTokenRoom(db, id.subject);
        await writeSlot(id);
        const code = `hoff_${randomHex(16)}`;
        await kv.set(key(code), JSON.stringify({ memberId: id.subject }), {
          nx: true,
          ex: HANDOFF_TTL_SEC,
        });
        return json(
          { code, expiresInSec: HANDOFF_TTL_SEC },
          { status: 201, noStore: true },
        );
      },
    },
    defineRoute({
      method: "POST",
      path: "/auth/app-handoff/exchange",
      body: exchangeBody,
      handler: async (ctx) => {
        const k = key(ctx.body.code);
        const raw = await kv.get(k);
        // get + del with the removed count: two racing exchanges both read,
        // one delete returns 1, the other 0 (`consumeState`'s shape).
        const removed = raw === null ? 0 : await kv.del(k);
        if (raw === null || removed === 0) throw gone();
        const { memberId } = JSON.parse(raw) as { memberId: string };
        // Re-read the member: role and login are whatever they are now, and
        // a member removed since the click reads as an unknown code.
        const m = await db.findMember(memberId);
        if (!m) throw gone();
        // The app refuses a pending profile after `/me` anyway; refusing here
        // keeps a pending member's taps from piling up orphan token rows.
        if (m.role === "pending")
          throw new AppError("forbidden", "membership is pending approval");
        const t = await mint({
          memberId,
          name: handoffTokenName(clock),
          via: "handoff",
        });
        logger.info("app handoff", { memberId, tokenId: t.id });
        return json(
          {
            token: t.token,
            tokenId: t.id,
            name: t.name,
            member: { id: m.id, login: m.githubLogin, role: m.role },
          },
          { status: 201, noStore: true },
        );
      },
    }),
    {
      // The https form of the intent target. Only a browser without the app
      // (or a link pasted elsewhere) ever loads it; the code in its query is
      // not read here and the request log keeps the path pattern only.
      method: "GET",
      path: "/app-open",
      handler: async () =>
        redirect(`${webUrl.replace(/\/+$/, "")}/installer?app=missing`),
    },
    {
      method: "GET",
      path: "/.well-known/assetlinks.json",
      handler: async () => {
        if (fingerprints.length === 0)
          throw new AppError(
            "not_found",
            "no android app fingerprint configured",
          );
        return {
          statusCode: 200,
          headers: {
            "content-type": "application/json",
            "cache-control": "public, max-age=3600",
          },
          body: JSON.stringify(assetLinks(fingerprints)),
        };
      },
    },
  ];
}
