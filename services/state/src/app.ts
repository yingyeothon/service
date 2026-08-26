import {
  AppError,
  nowSec,
  nullLogger,
  systemClock,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  checkDocBody,
  MAX_DOC_BODY_BYTES,
  type StateDb,
  type StateDocRow,
} from "@yyt/console-db";
import {
  createHttpHandler,
  defineRoute,
  json,
  type AnyRoute,
  type HttpEvent,
  type HttpResult,
  type Identity,
  type RouteContext,
} from "@yyt/http";
import type { Caller, ChannelStore } from "./channels.js";

/**
 * How many owners may hold a document in one channel. A hackathon channel with
 * more than this has either been handed to the world or is being filled by a
 * loop, and both want the same answer.
 */
export const MAX_DOCS_PER_CHANNEL = 10_000;

/**
 * An `ownerId` is either a player — the 32 lowercase hex of `deriveUserId`,
 * which is exactly what a token's `sub` holds — or a non-user owner written
 * `{kind}:{id}` for things a game keeps per party or per guild. A player id
 * can never contain `:`, so the two spaces cannot collide and a server cannot
 * write a party document onto a player's row by accident.
 */
const OWNER_ID = /^(?:[0-9a-f]{32}|[a-z]{1,8}:[A-Za-z0-9_-]{1,48})$/;

/**
 * A coarse outer guard so an absurd body is dropped before it is parsed. The
 * limit that matters is {@link MAX_DOC_BODY_BYTES} on the document itself,
 * checked after — it names the *document*, which is the number the caller can
 * act on, and it is measured on the bytes as sent, because those are the bytes
 * that get stored.
 */
const MAX_REQUEST_BYTES = MAX_DOC_BODY_BYTES * 2;

export interface StateAppOptions {
  state: StateDb;
  channels: ChannelStore;
  clock?: Clock;
  logger?: Logger;
  extraRoutes?: AnyRoute[];
}

/** `"3"`, `W/"3"` and a bare `3` all mean version 3. */
export function parseIfMatch(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^(?:W\/)?(?:"(\d{1,15})"|(\d{1,15}))$/.exec(raw.trim());
  if (!m) return undefined;
  return Number(m[1] ?? m[2]);
}

const etag = (version: number) => `"${version}"`;

/** The request body as sent, decoded but not re-encoded. */
function rawBody(event: HttpEvent): string {
  const b = event.body ?? "";
  return event.isBase64Encoded ? Buffer.from(b, "base64").toString("utf8") : b;
}

/** Every document response is uncacheable: it is per-player state behind a bearer token. */
const DOC_HEADERS = { "cache-control": "no-store" };

function docResult(row: StateDocRow): HttpResult {
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      etag: etag(row.version),
      ...DOC_HEADERS,
    },
    // The stored text verbatim: the platform never parses a document, and
    // re-encoding one would be interpreting it.
    body: row.body,
  };
}

/**
 * 409 carries the version that is actually stored, so a caller can re-read,
 * merge and retry without a second round trip to find out what it lost to.
 */
function conflictResult(current: StateDocRow | undefined): HttpResult {
  return json(
    {
      error: {
        code: "conflict",
        message: "version mismatch",
        details:
          current === undefined
            ? { current: null }
            : { current: current.version },
      },
    },
    {
      status: 409,
      headers: {
        ...DOC_HEADERS,
        ...(current ? { etag: etag(current.version) } : {}),
      },
    },
  );
}

export function createStateApp({
  state,
  channels,
  clock = systemClock,
  logger = nullLogger,
  extraRoutes = [],
}: StateAppOptions): (event: HttpEvent) => Promise<HttpResult> {
  /** The resolved caller; `auth: true` has already refused a request without one. */
  function caller(ctx: Pick<RouteContext, "requireIdentity">): Caller {
    const id = ctx.requireIdentity();
    return {
      channelId: id.subject,
      kind: id.kind as Caller["kind"],
      ownerId: typeof id.ownerId === "string" ? id.ownerId : undefined,
    };
  }

  function ownerParam(ctx: Pick<RouteContext, "params">): string {
    const owner = ctx.params.ownerId ?? "";
    if (!OWNER_ID.test(owner))
      throw new AppError("bad_request", "invalid ownerId");
    return owner;
  }

  /** Writes are the server's alone; a player's token is never a writer. */
  function requireServer(c: Caller): void {
    if (c.kind !== "server")
      throw new AppError("forbidden", "a channel apiKey is required to write");
  }

  function requireIfMatch(ctx: Pick<RouteContext, "headers">): number {
    const raw = ctx.headers["if-match"];
    if (raw === undefined)
      // 428, not 400: the request is well-formed and the fix is a header, which
      // is exactly what "Precondition Required" says. There is no unconditional
      // write here — that is the failure this shape exists to prevent.
      throw new AppError("bad_request", "If-Match is required", {
        status: 428,
      });
    const version = parseIfMatch(raw);
    if (version === undefined)
      throw new AppError(
        "bad_request",
        raw.trim() === "*"
          ? "If-Match: * is not accepted; send the version you read"
          : "If-Match must be a version",
      );
    return version;
  }

  const routes: AnyRoute[] = [
    defineRoute({
      method: "GET",
      path: "/s/{ownerId}",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        const owner = ownerParam(ctx);
        // A player reads its own row and nothing else. 403 rather than 404 on
        // purpose: the caller is authenticated and the rule is worth stating,
        // and it reveals nothing — they already know their own id.
        if (c.kind === "owner" && c.ownerId !== owner)
          throw new AppError("forbidden", "not your document");
        const row = await state.findDoc(c.channelId, owner);
        if (!row) throw new AppError("not_found", "document not found");
        return docResult(row);
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/s/{ownerId}",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        requireServer(c);
        const owner = ownerParam(ctx);
        const ifVersion = requireIfMatch(ctx);
        if (ctx.body === undefined)
          throw new AppError("bad_request", "a JSON document body is required");
        // The bytes as sent. `ctx.body` proves the request is JSON and nothing
        // more: re-encoding it would be *interpreting* the document, and
        // `JSON.stringify(JSON.parse(x))` is lossy — an integer past 2^53
        // (a snowflake id, a microsecond timestamp) comes back a different
        // number, duplicate keys collapse and integer-like keys reorder. The
        // platform promises to carry a game's schema opaquely, so it stores
        // exactly what it was given.
        const body = rawBody(ctx.event);
        checkDocBody(body);
        if (ifVersion === 0) {
          // Counted only on create; an update cannot grow the channel. The race
          // between count and insert can overshoot by the number of concurrent
          // creates, which is the right trade for not taking a lock on the hot
          // path of a shared 60-connection database.
          const docs = await state.countDocs(c.channelId);
          // At the cap, tell the two 409s apart before answering: an owner who
          // already *has* a document is looking at a version conflict, and
          // "this channel is full" would send them to the wrong fix. The extra
          // read only ever happens at the cap.
          if (docs >= MAX_DOCS_PER_CHANNEL) {
            const existing = await state.findDoc(c.channelId, owner);
            if (existing) return conflictResult(existing);
            throw new AppError(
              "conflict",
              `channel already holds ${MAX_DOCS_PER_CHANNEL} documents`,
            );
          }
        }
        const r = await state.putDoc({
          channelId: c.channelId,
          ownerId: owner,
          body,
          ifVersion,
          at: nowSec(clock),
        });
        if (!r.ok) return conflictResult(r.current);
        return {
          // 201 when the row is new, 204 when it moved: the body is what the
          // caller just sent, so echoing it back would only cost bandwidth.
          statusCode: ifVersion === 0 ? 201 : 204,
          headers: { etag: etag(r.version), ...DOC_HEADERS },
          body: "",
        };
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/s/{ownerId}",
      auth: true,
      handler: async (ctx) => {
        const c = caller(ctx);
        requireServer(c);
        const owner = ownerParam(ctx);
        const raw = ctx.headers["if-match"];
        // Optional here, unlike `PUT`: a delete does not merge with a
        // concurrent write, it ends the row, and an operator clearing a
        // corrupted document has no version worth quoting.
        const ifVersion = raw === undefined ? undefined : requireIfMatch(ctx);
        const r = await state.deleteDoc(c.channelId, owner, ifVersion);
        if (r === "missing")
          throw new AppError("not_found", "document not found");
        if (r === "conflict")
          return conflictResult(await state.findDoc(c.channelId, owner));
        return { statusCode: 204, headers: DOC_HEADERS, body: "" };
      },
    }),
  ];

  return createHttpHandler({
    routes: [...routes, ...extraRoutes],
    maxBodyBytes: MAX_REQUEST_BYTES,
    // A game client is a browser on the participant's own origin, so there is
    // no list of origins to allow — and none is needed: the credential is an
    // explicit `Authorization` header, never an ambient cookie, so `*` grants
    // nothing a caller could not already do with `curl`. `if-match` has to be
    // allowed or no browser can write, and **`etag` has to be exposed** or no
    // browser can read the version it is then required to send back.
    cors: {
      origins: ["*"],
      headers: ["content-type", "authorization", "if-match"],
      exposeHeaders: ["etag"],
    },
    identity: async ({ bearer }): Promise<Identity | undefined> => {
      if (!bearer) return undefined;
      const c = await channels.resolve(bearer);
      if (!c) return undefined;
      // The channel is the tenant and it lives only in the bearer — never in
      // the path — so without this line "team X cannot save" is unanswerable
      // from the logs. The owner is deliberately not logged: it is per-player.
      logger.debug("caller", { channelId: c.channelId, kind: c.kind });
      // `subject` is the channel, not the person: every route is scoped by it,
      // and a player's identity is the separate `ownerId` below.
      return { kind: c.kind, subject: c.channelId, ownerId: c.ownerId };
    },
    logger,
  });
}
