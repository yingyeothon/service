import {
  AppError,
  nowSec,
  nullLogger,
  systemClock,
  type Clock,
  type Logger,
} from "@yyt/core";
import {
  KV_COLLECTION_ID_RE,
  KV_SHARED_OWNER,
  KV_TTL_MAX_SECONDS,
  KV_TTL_MIN_SECONDS,
  MAX_KV_VALUE_BYTES,
  checkKvKey,
  kvValueBytes,
  type KvCollectionRow,
  type KvEntryMeta,
  type KvEntryRow,
  type KvScope,
  type KvStoreDb,
} from "@yyt/console-db";
import {
  defineRoute,
  json,
  type AnyRoute,
  type HttpResult,
  type RouteContext,
} from "@yyt/http";
import { callerFromIdentity, type Caller } from "./channels.js";
import { NO_STORE, checkOwnerId, etag, parseIfMatch, rawBody } from "./http.js";
import {
  KvCryptoError,
  isKvCiphertext,
  type KvCrypto,
} from "./kvstore-crypto.js";

/**
 * The KV API (`docs/decisions.md` *Key-value store (`kv`)*): per-project
 * collections of JSON values addressed by key, served beside the doc routes
 * because both resolve the same two credentials and the MariaDB connection
 * budget has no room for a sixth stack.
 *
 * Everything about *storage* -- caps, grammar, the compare-and-set, the cursor
 * codec -- lives in `@yyt/console-db`'s `kvstore.ts`, shared with the console
 * API so both writers answer alike. What lives here is what only an API can
 * decide: which principal may touch which namespace, what a conditional header
 * means, and where the plaintext of an encrypted collection is allowed to
 * exist (this process, never the console's).
 */

/** The stage has no usable `KV_KEK`; every kv route says so rather than half-working. */
export const KV_NOT_CONFIGURED = "kv_encryption_not_configured";
/** A stored value did not open: wrong envelope for the flag, or a failed tag. */
export const KV_VALUE_UNREADABLE = "kv_value_unreadable";
/** The caller used the shared path on a user namespace, or the other way round. */
export const KV_WRONG_NAMESPACE = "wrong_namespace";

/**
 * Expired rows purged in one inline pass when a create meets a cap. It is the
 * same budget the console sweep uses; a create is refused right after either
 * way, so this is reclamation at the one moment the collection is known to be
 * under pressure, not part of the verdict.
 */
export const KV_CAP_PURGE_BATCH = 1_000;

export interface KvStoreRoutesOptions {
  kvstore: KvStoreDb;
  /**
   * The stage crypto, or `undefined` when `KV_KEK` is missing or malformed.
   * `handler.ts` builds it inside a `try/catch` on purpose: a deployment fault
   * in the KEK must cost the kv routes a 503 and leave `/s/*` alone.
   */
  crypto?: KvCrypto;
  clock?: Clock;
  logger?: Logger;
}

/** Which entries a request addresses: one owner's slot, or every owner's. */
type Target = { owner: string } | "all";

/**
 * The scope matrix of `docs/decisions.md` #3, in one place for both the read
 * and the write side. `team` means console and CLI only, so the API always
 * refuses it; `project` means any credential of the collection's project;
 * `user` means the server key on anyone's behalf, and a player on its own.
 */
function allows(scope: KvScope, c: Caller, target: Target): boolean {
  if (scope === "team") return false;
  if (scope === "project") return true;
  if (c.kind === "server") return true;
  return target !== "all" && target.owner === c.ownerId;
}

const collectionGone = (): AppError =>
  // 404, not 403: a collection of another project must be indistinguishable
  // from one that does not exist, or an id becomes an oracle for what a
  // neighbouring team stores.
  new AppError("not_found", "collection not found");

const wrongNamespace = (hint: string): AppError =>
  new AppError("bad_request", hint, {
    details: { reason: KV_WRONG_NAMESPACE },
  });

/** 409 for a lost compare-and-set. Carries the live version and nothing else. */
/**
 * 409 for a lost compare-and-set. Carries the live version and nothing else --
 * and not even that to a caller that may not read the collection, which is the
 * same rule that puts a 403 on a conditional write (`docs/decisions.md` #4).
 */
function conflictResult(
  current: KvEntryMeta | undefined,
  mayRead: boolean,
): HttpResult {
  return json(
    {
      error: {
        code: "conflict",
        message: "version mismatch",
        // Never the value, and never the row's other fields.
        ...(mayRead
          ? {
              details: {
                current: current === undefined ? null : current.version,
              },
            }
          : {}),
      },
    },
    {
      status: 409,
      headers: {
        ...NO_STORE,
        ...(mayRead && current ? { etag: etag(current.version) } : {}),
      },
    },
  );
}

/** A 409 that names *why* the write was refused, for the cases with a fix. */
const reasonConflict = (message: string, reason: string): AppError =>
  new AppError("conflict", message, { details: { reason } });

/**
 * A stored counter, or the 409 that says it is not one.
 *
 * The parse is guarded rather than trusted: both writers happen to store only
 * text they parsed first, but nothing in the repository enforces that
 * (`checkKvEntrySize` measures bytes), and an unguarded `JSON.parse` here would
 * answer 500 *and* put the stored value -- decrypted, on an encrypted
 * collection -- into the unhandled-error log with its stack.
 */
function safeInteger(text: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed))
    throw reasonConflict(
      "the stored value is not a safe integer",
      "not_a_number",
    );
  return parsed;
}

export function createKvStoreRoutes({
  kvstore,
  crypto,
  clock = systemClock,
  logger = nullLogger,
}: KvStoreRoutesOptions): AnyRoute[] {
  /**
   * Refuses every kv route while the stage has no KEK, including the routes of
   * plaintext collections: a stack that cannot open half its data is
   * misconfigured, and a store that quietly serves the other half hides it
   * until someone reaches an encrypted collection.
   */
  function requireCrypto(): KvCrypto {
    if (!crypto)
      throw new AppError("unavailable", "kv storage is not configured", {
        details: { reason: KV_NOT_CONFIGURED },
      });
    return crypto;
  }

  /**
   * One 503 for every way a stored value can refuse to open, and one log line
   * carrying what tells them apart. The reason never reaches the response: a
   * caller must not learn from it whether a key is wrong or a row was tampered
   * with, and `kekId` is what says "this stage has the wrong KEK" (every
   * collection at once) rather than "this row is corrupt".
   */
  function unreadable(
    collectionId: string,
    cause: KvCryptoError | string,
  ): AppError {
    const e = cause instanceof KvCryptoError ? cause : undefined;
    logger.error("kv decrypt failed", {
      collectionId,
      kekId: crypto?.kekId,
      reason: e?.reason ?? "envelope",
      message: e?.message ?? cause,
    });
    return new AppError("unavailable", "value cannot be read", {
      details: { reason: KV_VALUE_UNREADABLE },
    });
  }

  const now = (): number => nowSec(clock);

  const query = (
    ctx: Pick<RouteContext, "query">,
  ): Record<string, string | undefined> =>
    (ctx.query ?? {}) as Record<string, string | undefined>;

  /**
   * Resolves `{col}` to a live collection of the caller's project.
   *
   * The shape check comes first and without a `SELECT`: `kv_collections.id` is
   * `utf8mb4_ci`, so MariaDB would match `KV_01H…` against a row written
   * `kv_01h…` while the value AAD binds the id byte for byte -- every value of
   * a collection reached through the wrong spelling would then be a 503 that
   * looks like corruption.
   */
  async function collectionOf(
    ctx: Pick<RouteContext, "params">,
    c: Caller,
  ): Promise<KvCollectionRow> {
    const id = ctx.params.col ?? "";
    // One 404 for four different faults, so an id is never an oracle -- and
    // one log line that says which, because the collection id is charset-bound
    // by the line above and the alternative is opening the database to tell a
    // client typo from the legacy `project_id IS NULL` channel.
    const gone = (reason: string): AppError => {
      logger.debug("kv collection unavailable", {
        collectionId: reason === "shape" ? undefined : id,
        reason,
      });
      return collectionGone();
    };
    if (!KV_COLLECTION_ID_RE.test(id)) throw gone("shape");
    const row = await kvstore.findCollection(id);
    if (!row) throw gone("missing");
    if (row.deletedAt !== null) throw gone("deleted");
    // A `null` project (a channel from before projects existed) can never
    // equal a collection's NOT NULL one, so such a credential simply has no
    // kv access.
    if (row.projectId !== c.projectId) throw gone("project");
    return row;
  }

  /** `writeScope: user` is what puts every entry in an owner namespace. */
  const isUserNamespace = (col: KvCollectionRow): boolean =>
    col.writeScope === "user";

  /**
   * The refusal is logged with the scope that produced it: the request line
   * records the route pattern and the channel, which cannot say whether the
   * caller lacked the write right or only the read right a conditional header
   * demands, and those have different fixes.
   */
  function refuse(
    col: KvCollectionRow,
    need: "read" | "write",
    scope: KvScope,
  ): AppError {
    logger.debug("kv refused", { collectionId: col.id, need, scope });
    return new AppError("forbidden", `not allowed to ${need} this collection`);
  }

  function requireRead(col: KvCollectionRow, c: Caller, target: Target): void {
    if (!allows(col.readScope, c, target))
      throw refuse(col, "read", col.readScope);
  }

  function requireWrite(col: KvCollectionRow, c: Caller, target: Target): void {
    if (!allows(col.writeScope, c, target))
      throw refuse(col, "write", col.writeScope);
  }

  /**
   * The owner slot a request addresses. `scoped` is the `/u/{ownerId}` twin;
   * the plain path is the shared namespace. Using the wrong one is a 400 with
   * the path that would have worked, because both spellings exist and a 404
   * would send the caller looking for a missing collection.
   *
   * The grammar runs here rather than only in the repository: `matchPath`
   * percent-decodes, so `%00` arrives as a real NUL, and an owner or key is
   * part of a value's associated data.
   */
  function ownerOf(
    col: KvCollectionRow,
    c: Caller,
    ctx: Pick<RouteContext, "params">,
    scoped: boolean,
  ): string {
    if (!scoped) {
      if (isUserNamespace(col))
        throw wrongNamespace(
          "this collection keeps one namespace per owner; use /kv/{col}/u/{ownerId}/entries",
        );
      return KV_SHARED_OWNER;
    }
    if (!isUserNamespace(col))
      throw wrongNamespace(
        "this collection has one shared namespace; use /kv/{col}/entries",
      );
    const raw = ctx.params.ownerId ?? "";
    if (raw === "me") {
      // A server key holds no owner of its own, and silently writing to some
      // default slot is the kind of guess that fills a collection with rows
      // nobody meant.
      if (c.kind !== "owner" || c.ownerId === undefined)
        throw new AppError(
          "bad_request",
          "'me' names the owner of a player token; a server key must name the owner",
        );
      return checkOwnerId(c.ownerId);
    }
    return checkOwnerId(raw);
  }

  function keyOf(ctx: Pick<RouteContext, "params">): string {
    const key = ctx.params.key ?? "";
    checkKvKey(key);
    return key;
  }

  /**
   * `?ttl=` in seconds: absent keeps whatever the row has (and means "no
   * expiry" on a create), `0` clears it, anything else is relative to now.
   */
  function ttlOf(ctx: Pick<RouteContext, "query">): number | null | "keep" {
    const raw = query(ctx).ttl;
    if (raw === undefined || raw === "") return "keep";
    const n = Number(raw);
    if (
      !Number.isInteger(n) ||
      n < 0 ||
      (n !== 0 && n < KV_TTL_MIN_SECONDS) ||
      n > KV_TTL_MAX_SECONDS
    )
      throw new AppError(
        "bad_request",
        `ttl must be 0 (clear) or ${KV_TTL_MIN_SECONDS}..${KV_TTL_MAX_SECONDS} seconds`,
      );
    return n === 0 ? null : now() + n;
  }

  /** `x-kv-expires-at` is the absolute second, so a client needs no clock skew guess. */
  const expiryHeader = (expiresAt: number | null): Record<string, string> =>
    expiresAt === null ? {} : { "x-kv-expires-at": String(expiresAt) };

  /**
   * The DEK of an encrypted collection, read per request.
   *
   * Not cached: a DEK is a secret, and `rules/data.md` forbids this stack from
   * holding one between requests for the same reason it forbids caching an
   * auth channel row. The cost is one indexed `SELECT` on the collections that
   * asked for encryption.
   */
  async function readDek(col: KvCollectionRow): Promise<Buffer> {
    const kc = requireCrypto();
    const row = await kvstore.findKey(col.id);
    // A row whose value is sealed but whose key is gone is unreadable for
    // good; saying so is the only honest answer.
    if (!row) throw unreadable(col.id, "collection has no key");
    try {
      return kc.unwrapDek(col.id, row.dekWrapped);
    } catch (e) {
      throw unreadable(
        col.id,
        e instanceof KvCryptoError ? e : "unwrap failed",
      );
    }
  }

  /** The DEK, minted on the collection's first write. Claim-first: the loser re-reads. */
  async function ensureDek(col: KvCollectionRow): Promise<Buffer> {
    const kc = requireCrypto();
    const existing = await kvstore.findKey(col.id);
    if (existing) {
      try {
        return kc.unwrapDek(col.id, existing.dekWrapped);
      } catch (e) {
        throw unreadable(
          col.id,
          e instanceof KvCryptoError ? e : "unwrap failed",
        );
      }
    }
    const { dek, wrapped } = kc.mintDek(col.id);
    const r = await kvstore.insertKey(col.id, wrapped, now());
    if (r === "inserted") return dek;
    // Another container won the race; its DEK is the collection's.
    return readDek(col);
  }

  /**
   * The plaintext of one row. A stored form that disagrees with the
   * collection's flag is never served as data: it means the flag changed
   * underneath rows that cannot follow it, and handing the ciphertext to a
   * caller as if it were their value would be the worse answer.
   */
  function plaintextOf(
    col: KvCollectionRow,
    dek: Buffer | undefined,
    row: KvEntryRow,
  ): string {
    const stored = row.value ?? "";
    if (isKvCiphertext(stored) !== col.encrypted)
      throw unreadable(col.id, "envelope disagrees with the collection flag");
    if (!col.encrypted) return stored;
    const kc = requireCrypto();
    // Only a caller that forgot to load one; `createCipheriv` would answer a
    // `TypeError` and a 500 instead of the 503 this is.
    if (dek === undefined) throw unreadable(col.id, "no key loaded");
    try {
      return kc.decryptValue(
        dek,
        { collectionId: col.id, ownerId: row.ownerId, key: row.key },
        stored,
      );
    } catch (e) {
      throw unreadable(
        col.id,
        e instanceof KvCryptoError ? e : "decrypt failed",
      );
    }
  }

  /**
   * One DEK per request, never one per statement: a collection's key cannot
   * change while a request runs, and an `incr` that retries three times over an
   * encrypted collection would otherwise read `kv_keys` six times. Still
   * nothing held *between* requests -- that is what `rules/data.md` forbids.
   */
  function dekFor(col: KvCollectionRow): {
    read(): Promise<Buffer>;
    ensure(): Promise<Buffer>;
  } {
    let pending: Promise<Buffer> | undefined;
    return {
      read: () => (pending ??= readDek(col)),
      ensure: () => (pending ??= ensureDek(col)),
    };
  }

  /** What a writer stores: the bytes as sent, or their envelope. */
  function sealValue(
    col: KvCollectionRow,
    owner: string,
    key: string,
    text: string,
    dek: Buffer | undefined,
  ): string {
    if (!col.encrypted) return text;
    const kc = requireCrypto();
    return kc.encryptValue(
      dek as Buffer,
      { collectionId: col.id, ownerId: owner, key },
      text,
    );
  }

  /**
   * Room for one more row. Counted on create only, and never inside a
   * transaction: the race can overshoot by the number of concurrent creates,
   * which is the right trade for not locking a shared 60-connection database
   * on the hot path (the doc store makes the same one).
   *
   * `maxEntriesPerOwner` bounds a *player*, so that one JWT cannot fill a
   * collection and lock its teammates out; a server key and the console are
   * bounded by `maxEntries` alone (`docs/decisions.md` #7).
   */
  async function requireRoom(
    col: KvCollectionRow,
    c: Caller,
    owner: string,
  ): Promise<void> {
    const perOwner = c.kind === "owner" && isUserNamespace(col);
    const at = now();
    const count = (includeExpired: boolean, ownerId?: string) =>
      kvstore.countEntries(col.id, { now: at, ownerId, includeExpired });

    /*
     * Counted on the rows the table actually **holds**, expired ones included.
     * The live count is what decides a refusal (`docs/decisions.md` #6: an
     * expired entry holds no slot), but it cannot be what decides that there is
     * room: `PUT …/{fresh key}?ttl=1` is invisible to it a second later, so a
     * client writing a new key each time would walk past both caps for ever
     * while `kv_entries` grew without bound on a host every stage shares.
     *
     * `stored < cap` implies `live < cap`, so the ordinary create stops here.
     * Only a collection whose stored rows have reached a cap pays for the
     * reclamation and the second, live count -- which is the moment
     * `docs/decisions.md` #6 puts the inline purge at, and the moment it now
     * actually arrives at.
     */
    let ownerRows = perOwner ? await count(true, owner) : 0;
    const overOwner = () => perOwner && ownerRows >= col.maxEntriesPerOwner;
    // Skipped when the owner is already over: the verdict is theirs either way.
    let allRows = overOwner() ? 0 : await count(true);
    if (overOwner() || allRows >= col.maxEntries) {
      await kvstore.deleteExpiredEntries(col.id, at, KV_CAP_PURGE_BATCH);
      ownerRows = perOwner ? await count(false, owner) : 0;
      allRows = overOwner() ? 0 : await count(false);
    }
    if (overOwner())
      throw reasonConflict(
        `owner already holds ${col.maxEntriesPerOwner} entries`,
        "owner_full",
      );
    if (allRows >= col.maxEntries)
      throw reasonConflict(
        `collection already holds ${col.maxEntries} entries`,
        "collection_full",
      );
  }

  /**
   * The conditional headers of a write. Either header makes the write depend
   * on what is stored, which is a read -- so a caller that may not read the
   * collection may not use them (`docs/decisions.md` #4): a write-only inbox
   * takes a plain `PUT` and nothing else.
   */
  function conditionOf(
    ctx: Pick<RouteContext, "headers">,
    col: KvCollectionRow,
    c: Caller,
    target: Target,
  ): number | "absent" | undefined {
    const ifMatch = ctx.headers["if-match"];
    const ifNone = ctx.headers["if-none-match"];
    if (ifMatch === undefined && ifNone === undefined) return undefined;
    requireRead(col, c, target);
    if (ifNone !== undefined) {
      if (ifMatch !== undefined)
        throw new AppError(
          "bad_request",
          "send If-Match or If-None-Match, not both",
        );
      if (ifNone.trim() !== "*")
        throw new AppError(
          "bad_request",
          "If-None-Match is only accepted as *",
        );
      return "absent";
    }
    const version = parseIfMatch(ifMatch);
    if (version === undefined || version < 1)
      throw new AppError(
        "bad_request",
        ifMatch?.trim() === "*"
          ? "If-Match: * is not accepted; send the version you read"
          : version === 0
            ? // The doc store spells "create" as `If-Match: 0`; here an entry
              // has no version 0 and create-only is the standard header.
              "If-Match: 0 is not a version; use If-None-Match: * to create"
            : "If-Match must be a version",
      );
    return version;
  }

  /** One entry as a list row; `owner` only where owners are a namespace. */
  function listRow(
    col: KvCollectionRow,
    dek: Buffer | undefined,
    row: KvEntryRow,
    withValue: boolean,
  ): Record<string, unknown> {
    return {
      ...(isUserNamespace(col) ? { owner: row.ownerId } : {}),
      key: row.key,
      version: row.version,
      bytes: row.bytes,
      expiresAt: row.expiresAt,
      updatedAt: row.updatedAt,
      ...(withValue ? { valueText: plaintextOf(col, dek, row) } : {}),
    };
  }

  const wantsValues = (ctx: Pick<RouteContext, "query">): boolean => {
    const raw = query(ctx).values;
    return raw === "1" || raw === "true";
  };

  function orderOf(ctx: Pick<RouteContext, "query">): "asc" | "desc" {
    const raw = query(ctx).order;
    if (raw === undefined || raw === "" || raw === "asc") return "asc";
    if (raw === "desc") return "desc";
    throw new AppError("bad_request", "order must be asc or desc");
  }

  /** The list body of both list routes; `owner` is `undefined` for every owner. */
  async function listing(
    ctx: RouteContext,
    col: KvCollectionRow,
    owner: string | undefined,
  ): Promise<HttpResult> {
    const q = query(ctx);
    const withValue = wantsValues(ctx);
    const page = await kvstore.listEntries({
      collectionId: col.id,
      ownerId: owner,
      prefix: q.prefix,
      cursor: q.cursor,
      // `?limit=abc` becomes `NaN`, which `kvPageLimit` names inside the
      // repository and turns into the default rather than a Prisma error.
      limit: q.limit === undefined ? undefined : Number(q.limit),
      now: now(),
      withValue,
      order: orderOf(ctx),
    });
    const dek =
      withValue && col.encrypted && page.rows.length > 0
        ? await dekFor(col).read()
        : undefined;
    return json(
      {
        entries: page.rows.map((r) => listRow(col, dek, r, withValue)),
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
      },
      { headers: NO_STORE },
    );
  }

  /** `GET …/entries/{key}` for both namespaces. */
  async function readEntry(
    ctx: RouteContext,
    scoped: boolean,
  ): Promise<HttpResult> {
    const c = callerFromIdentity(ctx.requireIdentity());
    requireCrypto();
    const col = await collectionOf(ctx, c);
    const owner = ownerOf(col, c, ctx, scoped);
    const key = keyOf(ctx);
    requireRead(col, c, { owner });
    const row = await kvstore.findEntry(col.id, owner, key, {
      now: now(),
      withValue: true,
    });
    if (!row) throw new AppError("not_found", "entry not found");
    const dek = col.encrypted ? await dekFor(col).read() : undefined;
    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        etag: etag(row.version),
        ...NO_STORE,
        ...expiryHeader(row.expiresAt),
      },
      // The stored text verbatim: the platform never parses a value, and
      // re-encoding one would be interpreting it.
      body: plaintextOf(col, dek, row),
    };
  }

  /** `PUT …/entries/{key}` for both namespaces. */
  async function putEntry(
    ctx: RouteContext,
    scoped: boolean,
  ): Promise<HttpResult> {
    const c = callerFromIdentity(ctx.requireIdentity());
    requireCrypto();
    const col = await collectionOf(ctx, c);
    const owner = ownerOf(col, c, ctx, scoped);
    const key = keyOf(ctx);
    const target: Target = { owner };
    requireWrite(col, c, target);
    const ifVersion = conditionOf(ctx, col, c, target);
    const expiresAt = ttlOf(ctx);
    // The bytes as sent, measured before anything else looks at the body:
    // `JSON.stringify(JSON.parse(x))` is lossy -- an integer past 2^53 comes
    // back a different number, duplicate keys collapse and integer-like keys
    // reorder -- and a collection carries a game's own schema. (The parse
    // itself already happened: `createHttpHandler` parses every body under the
    // stack-wide 128 KiB guard before a route is reached, so this cap can be
    // the first thing the *route* does and no earlier.)
    const text = rawBody(ctx.event);
    const bytes = kvValueBytes(text);
    if (bytes > MAX_KV_VALUE_BYTES)
      throw new AppError(
        "payload_too_large",
        `value exceeds ${MAX_KV_VALUE_BYTES} bytes`,
      );
    // `ctx.body` proves the request is JSON and nothing more.
    if (ctx.body === undefined)
      throw new AppError("bad_request", "a JSON value body is required");
    // Caps are counted on create only, so a create has to be told from an
    // update *first*. `If-Match` names a version, which no absent row has, so
    // it never creates; `If-None-Match: *` over an existing key creates
    // nothing either and must answer the conflict rather than the cap.
    const mayCreate =
      typeof ifVersion !== "number" &&
      !(await kvstore.findEntry(col.id, owner, key, { now: now() }));
    if (mayCreate) await requireRoom(col, c, owner);
    const value = sealValue(
      col,
      owner,
      key,
      text,
      col.encrypted ? await dekFor(col).ensure() : undefined,
    );
    const r = await kvstore.putEntry({
      collectionId: col.id,
      ownerId: owner,
      key,
      value,
      bytes,
      expiresAt,
      // Which credential wrote the row, so a channel's hard deletion can take
      // its players' entries with it.
      channelId: c.channelId,
      ifVersion,
      at: now(),
    });
    const mayRead = allows(col.readScope, c, target);
    if (!r.ok) return conflictResult(r.current, mayRead);
    return {
      // 201 when the row is new, 204 when it moved: the body is what the
      // caller just sent, so echoing it back would only cost bandwidth.
      //
      // Both of those, and the `ETag`, say something about what was stored --
      // whether the key existed and how many times it has been written -- so a
      // caller without the read right gets neither. That is the same rule that
      // puts a 403 on its conditional headers (`docs/decisions.md` #4); a
      // write-only inbox would otherwise hand out its contents' shape one
      // `PUT` at a time.
      statusCode: mayRead && r.created ? 201 : 204,
      headers: {
        ...(mayRead ? { etag: etag(r.version) } : {}),
        ...NO_STORE,
        ...(typeof expiresAt === "number" ? expiryHeader(expiresAt) : {}),
      },
      body: "",
    };
  }

  /**
   * `PATCH …/entries/{key}` with `{"incr": n}`: the one operation the platform
   * performs *on* a value, because a counter read-modify-written by two
   * clients is the failure a plain `PUT` cannot prevent. It reveals the stored
   * value, so it needs the right to read as well as the right to write.
   */
  async function patchEntry(
    ctx: RouteContext,
    scoped: boolean,
  ): Promise<HttpResult> {
    const c = callerFromIdentity(ctx.requireIdentity());
    requireCrypto();
    const col = await collectionOf(ctx, c);
    const owner = ownerOf(col, c, ctx, scoped);
    const key = keyOf(ctx);
    const target: Target = { owner };
    requireWrite(col, c, target);
    requireRead(col, c, target);
    // The version this operates on is the one it reads for itself, one round
    // at a time. Honouring a caller's `If-Match` on top of that would need a
    // second meaning for "the expected version", and silently *ignoring* it
    // would hand a client that believes it sent a conditional request an
    // unconditional one -- a lost update it could never see.
    if (
      ctx.headers["if-match"] !== undefined ||
      ctx.headers["if-none-match"] !== undefined
    )
      throw new AppError(
        "bad_request",
        "If-Match and If-None-Match do not apply to PATCH; it is already a compare-and-set",
      );
    const expiresAt = ttlOf(ctx);
    const body = ctx.body;
    const incr =
      typeof body === "object" && body !== null
        ? (body as { incr?: unknown }).incr
        : undefined;
    if (typeof incr !== "number" || !Number.isSafeInteger(incr))
      throw new AppError("bad_request", "incr must be a safe integer");
    const dek = dekFor(col);

    let current: KvEntryMeta | undefined;
    // Three rounds, then the caller is owed whatever is really stored. Each
    // round re-reads: the value it adds to is the one it just saw.
    for (let round = 0; round < 3; round++) {
      const at = now();
      const row = await kvstore.findEntry(col.id, owner, key, {
        now: at,
        withValue: true,
      });
      current = row;
      // A missing counter starts at zero: the alternative is every client
      // shipping a "create it first" round trip that races the same way.
      let base = 0;
      if (row) {
        const text = plaintextOf(
          col,
          col.encrypted ? await dek.read() : undefined,
          row,
        );
        base = safeInteger(text);
      }
      const next = base + incr;
      if (!Number.isSafeInteger(next))
        throw reasonConflict(
          "the result is outside the safe integer range",
          "overflow",
        );
      // At most once per request, however many rounds it takes.
      if (!row && round === 0) await requireRoom(col, c, owner);
      const text = JSON.stringify(next);
      const r = await kvstore.putEntry({
        collectionId: col.id,
        ownerId: owner,
        key,
        value: sealValue(
          col,
          owner,
          key,
          text,
          col.encrypted ? await dek.ensure() : undefined,
        ),
        bytes: kvValueBytes(text),
        expiresAt,
        channelId: c.channelId,
        ifVersion: row ? row.version : "absent",
        at,
      });
      if (r.ok)
        return json(
          { value: next, version: r.version },
          {
            headers: {
              etag: etag(r.version),
              ...NO_STORE,
              ...(typeof expiresAt === "number" ? expiryHeader(expiresAt) : {}),
            },
          },
        );
      current = r.current;
    }
    // The read right is a precondition of this route, so the version is
    // already the caller's to know.
    return conflictResult(current, true);
  }

  /** `DELETE …/entries/{key}` for both namespaces. */
  async function deleteEntry(
    ctx: RouteContext,
    scoped: boolean,
  ): Promise<HttpResult> {
    const c = callerFromIdentity(ctx.requireIdentity());
    requireCrypto();
    const col = await collectionOf(ctx, c);
    const owner = ownerOf(col, c, ctx, scoped);
    const key = keyOf(ctx);
    const target: Target = { owner };
    requireWrite(col, c, target);
    const ifVersion = conditionOf(ctx, col, c, target);
    if (ifVersion === "absent")
      throw new AppError(
        "bad_request",
        "If-None-Match does not apply to a delete",
      );
    const at = now();
    const r = await kvstore.deleteEntry(col.id, owner, key, {
      now: at,
      ifVersion,
    });
    const mayRead = allows(col.readScope, c, target);
    // 404 says the key was not there, which is a fact about what is stored: a
    // caller without the read right gets the idempotent 204 either way, the
    // same rule that hides the version from its `PUT`.
    if (r === "missing" && mayRead)
      throw new AppError("not_found", "entry not found");
    if (r === "conflict")
      return conflictResult(
        await kvstore.findEntry(col.id, owner, key, { now: at }),
        mayRead,
      );
    return { statusCode: 204, headers: NO_STORE, body: "" };
  }

  const entryRoutes = (scoped: boolean, path: string): AnyRoute[] => [
    defineRoute({
      method: "GET",
      path: `${path}/{key}`,
      auth: true,
      handler: (ctx) => readEntry(ctx, scoped),
    }),
    defineRoute({
      method: "PUT",
      path: `${path}/{key}`,
      auth: true,
      handler: (ctx) => putEntry(ctx, scoped),
    }),
    defineRoute({
      method: "PATCH",
      path: `${path}/{key}`,
      auth: true,
      handler: (ctx) => patchEntry(ctx, scoped),
    }),
    defineRoute({
      method: "DELETE",
      path: `${path}/{key}`,
      auth: true,
      handler: (ctx) => deleteEntry(ctx, scoped),
    }),
  ];

  return [
    defineRoute({
      method: "GET",
      path: "/kv/{col}",
      auth: true,
      handler: async (ctx) => {
        const c = callerFromIdentity(ctx.requireIdentity());
        requireCrypto();
        const col = await collectionOf(ctx, c);
        // Shape, not content: a caller of the project may always learn how a
        // collection behaves, which is what tells it whether to use the shared
        // path or the owner one before it gets a 400 for guessing.
        return json(
          {
            id: col.id,
            name: col.name,
            readScope: col.readScope,
            writeScope: col.writeScope,
            encrypted: col.encrypted,
            maxEntries: col.maxEntries,
            maxEntriesPerOwner: col.maxEntriesPerOwner,
          },
          { headers: NO_STORE },
        );
      },
    }),
    defineRoute({
      method: "GET",
      path: "/kv/{col}/entries",
      auth: true,
      handler: async (ctx) => {
        const c = callerFromIdentity(ctx.requireIdentity());
        requireCrypto();
        const col = await collectionOf(ctx, c);
        if (!isUserNamespace(col)) {
          requireRead(col, c, { owner: KV_SHARED_OWNER });
          // Fixing the owner turns the prefix filter into a range scan on the
          // primary key; leaving it open would read the whole collection to
          // find a handful of rows.
          return listing(ctx, col, KV_SHARED_OWNER);
        }
        // Every owner of a user namespace: a public profile that cannot be
        // enumerated is not public (`docs/decisions.md` #3), so this is a read
        // right like any other -- `readScope: user` still means the server key
        // alone.
        requireRead(col, c, "all");
        return listing(ctx, col, undefined);
      },
    }),
    defineRoute({
      method: "GET",
      path: "/kv/{col}/u/{ownerId}/entries",
      auth: true,
      handler: async (ctx) => {
        const c = callerFromIdentity(ctx.requireIdentity());
        requireCrypto();
        const col = await collectionOf(ctx, c);
        const owner = ownerOf(col, c, ctx, true);
        requireRead(col, c, { owner });
        return listing(ctx, col, owner);
      },
    }),
    ...entryRoutes(false, "/kv/{col}/entries"),
    ...entryRoutes(true, "/kv/{col}/u/{ownerId}/entries"),
  ];
}
