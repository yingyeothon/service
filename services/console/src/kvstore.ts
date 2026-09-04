import { AppError, nowSec, ulid, type Clock, type Logger } from "@yyt/core";
import {
  KV_COLLECTION_SORT_KEYS,
  KV_COLLECTIONS_PER_PROJECT,
  KV_LIST_LIMIT_MAX,
  KV_MAX_ENTRIES_DEFAULT,
  KV_MAX_ENTRIES_PER_OWNER_DEFAULT,
  KV_SCOPES,
  KV_SHARED_OWNER,
  KV_TTL_MAX_SECONDS,
  KV_TTL_MIN_SECONDS,
  MAX_KV_VALUE_BYTES,
  checkKvCaps,
  checkKvKey,
  checkKvOwnerId,
  checkKvScopes,
  ensureKvRoom,
  kvValueBytes,
  type KvCollectionListRow,
  type KvCollectionRow,
  type KvEntryRow,
  type KvStoreDb,
} from "@yyt/console-db";
import { defineRoute, json, type AnyRoute, type RouteContext } from "@yyt/http";
import { z } from "zod";
import { ORDERS, listParams, searchQuery } from "./list-query.js";
import type { ConsoleIdentity } from "./identity.js";
import type { CrumbResolver, ResourceHistory } from "./resources.js";
import { resourceName } from "./team.js";
import type { ResourceAccess, TeamAccessHelpers } from "./team-access.js";

/*
 * The console half of the key-value store (`docs/decisions.md` *Key-value
 * store (`kv`)*): a collection is a project resource beside channels, apps,
 * bundles and sites, and this is the surface the SPA and `yyt kv` use.
 *
 * Every storage rule -- caps, key grammar, the compare-and-set, the cursor
 * codec -- lives in `@yyt/console-db`, shared with the state stack's `/kv/*`
 * routes so both writers answer alike. What is decided here is what only the
 * console can decide: that authorization is team membership rather than a
 * collection's scopes (a `team` scope means "console and CLI only", not "the
 * console is limited"), and that an encrypted collection is **read-only** to
 * this process, because the key that would open it lives in the state stack
 * and deliberately never reaches here.
 */

/** Rows one drain statement takes; the same bound the sweep uses. */
export const KV_DRAIN_BATCH = 1_000;
/** Drain statements one request may spend before it hands over to the sweep. */
export const KV_DRAIN_MAX_BATCHES = 10;

/** A 409 that names *why*, for the cases with a fix. */
const reasonConflict = (message: string, reason: string): AppError =>
  new AppError("conflict", message, { details: { reason } });

/**
 * The console holds no DEK and never will (`docs/decisions.md` #8), so it can
 * neither write a value into an encrypted collection nor read one back. Keys,
 * owners, sizes, times and deletion stay available.
 */
const encryptedReadOnly = (): AppError =>
  reasonConflict(
    "this collection is encrypted; its values can only be read and written through the KV API",
    "encrypted",
  );

const description = z.string().max(2000);
const scope = z.enum(KV_SCOPES);
/** Ranged by `checkKvCaps` against the hard caps; this only keeps zod honest. */
const cap = z.number().int();

export const kvCreateBody = z
  .object({
    name: resourceName,
    description: description.optional(),
    readScope: scope,
    writeScope: scope,
    encrypted: z.boolean().optional(),
    maxEntries: cap.optional(),
    maxEntriesPerOwner: cap.optional(),
  })
  .strict();

const KV_EDITABLE = new Set([
  "name",
  "description",
  "maxEntries",
  "maxEntriesPerOwner",
]);
const KV_IMMUTABLE = new Set(["readScope", "writeScope", "encrypted"]);

/**
 * The editable half of a collection. The three immutable fields are named
 * rather than merely rejected: "unrecognized key" would read as a typo, and
 * the answer a caller needs is that the shape is fixed and the way to change
 * it is to delete and recreate (`docs/decisions.md` #3).
 */
export const kvPatchBody = z
  .object({
    name: resourceName.optional(),
    description: description.nullable().optional(),
    maxEntries: cap.optional(),
    maxEntriesPerOwner: cap.optional(),
  })
  .catchall(z.unknown())
  .superRefine((body, ctx) => {
    for (const key of Object.keys(body)) {
      if (KV_EDITABLE.has(key)) continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: KV_IMMUTABLE.has(key)
          ? `${key} cannot be changed after creation; delete the collection and create it again`
          : "unrecognized key",
      });
    }
  });

export const kvEntryBody = z
  .object({
    /** Required in a user namespace, refused in a shared one. */
    owner: z.string().max(64).optional(),
    /** JSON text, stored byte for byte as sent (`docs/decisions.md` #5). */
    valueText: z.string(),
    /** Seconds; `0` clears the expiry, omitted keeps whatever the row has. */
    ttl: z.number().int().optional(),
    /** `If-Match` by another name: the version the caller believes is stored. */
    ifVersion: z.number().int().min(1).optional(),
  })
  .strict();

const collectionsQuery = searchQuery(KV_COLLECTION_SORT_KEYS).passthrough();
const entriesQuery = z
  .object({
    prefix: z.string().max(128).optional(),
    owner: z.string().max(64).optional(),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(KV_LIST_LIMIT_MAX).optional(),
    order: z.enum(ORDERS).optional(),
  })
  .passthrough();
const ownerQuery = z
  .object({ owner: z.string().max(64).optional() })
  .passthrough();

export interface KvStoreRoutesOptions {
  kvstore: KvStoreDb;
  access: Pick<
    TeamAccessHelpers,
    "projectAccess" | "projectResource" | "memberTeamIds"
  >;
  crumbs: CrumbResolver;
  history: ResourceHistory;
  /**
   * The state stack's base URL, e.g. `https://doc-dev.yyt.life`; empty on a
   * stage without one. The collection page renders it, and creating an
   * encrypted collection is refused while it is empty: the DEK is minted by
   * the state stack, so nothing could ever write a value.
   */
  docUrl: string;
  clock: Clock;
  logger: Logger;
  /** The per-member slot every recorded write takes. */
  writeSlot: (id: ConsoleIdentity) => Promise<void>;
  audit: (
    actorId: string | null,
    action: string,
    target: string | null,
    detail?: unknown,
  ) => Promise<void>;
}

export function createKvStoreRoutes({
  kvstore,
  access,
  crumbs,
  history,
  docUrl,
  clock,
  logger,
  writeSlot,
  audit,
}: KvStoreRoutesOptions): AnyRoute[] {
  const { projectAccess, projectResource } = access;
  const now = () => nowSec(clock);
  const doc = docUrl.replace(/\/+$/, "");

  async function collectionWith(
    ctx: RouteContext,
    write: boolean,
  ): Promise<ResourceAccess<"kv">> {
    return projectResource(
      ctx,
      { kind: "kv", id: ctx.params.id ?? "" },
      write ? { secret: true } : {},
    );
  }

  /** `writeScope: user` is what puts every entry in an owner namespace. */
  const isUserNamespace = (col: KvCollectionRow): boolean =>
    col.writeScope === "user";

  /**
   * The owner slot a request addresses. Both spellings exist, so using the
   * wrong one is a 400 that names the right one rather than an empty listing.
   *
   * `me` is refused rather than taken literally: it is the KV API's word for
   * "the caller's own namespace", the console has no such caller, and an entry
   * parked under the literal owner `me` would be one no player could ever
   * reach through the API that owns the namespace.
   */
  function ownerOf(col: KvCollectionRow, raw: string | undefined): string {
    if (!isUserNamespace(col)) {
      refuseOwner(col, raw);
      return KV_SHARED_OWNER;
    }
    if (raw === undefined || raw === "")
      throw new AppError(
        "bad_request",
        "this collection keeps one namespace per owner; name the owner",
      );
    if (raw === "me")
      throw new AppError(
        "bad_request",
        "'me' is the KV API's alias for a player's own namespace; the console must name the owner",
      );
    // The grammar the KV API enforces, not merely what the column can hold:
    // a row under an owner the API would refuse is one no player and no server
    // key could ever read, write or delete, and it holds a `maxEntries` slot
    // for ever. The `me` refusal above is the same rule, spelled for the one
    // value that is a word rather than a shape.
    return checkKvOwnerId(raw);
  }

  /**
   * A shared collection has exactly one owner slot, so naming one is a
   * mistake with a fix rather than a filter to drop: a list silently ignoring
   * `?owner=` would answer every row and look like the filter had matched.
   */
  function refuseOwner(col: KvCollectionRow, raw: string | undefined): void {
    if (!isUserNamespace(col) && raw !== undefined)
      throw new AppError(
        "bad_request",
        "this collection has one shared namespace; drop the owner",
      );
  }

  /** `ttl` in seconds: absent keeps the row's expiry, `0` clears it. */
  function expiryOf(ttl: number | undefined): number | null | "keep" {
    if (ttl === undefined) return "keep";
    if (ttl === 0) return null;
    if (ttl < KV_TTL_MIN_SECONDS || ttl > KV_TTL_MAX_SECONDS)
      throw new AppError(
        "bad_request",
        `ttl must be 0 (clear) or ${KV_TTL_MIN_SECONDS}..${KV_TTL_MAX_SECONDS} seconds`,
      );
    return now() + ttl;
  }

  /**
   * Where a client of this collection sends its own reads and writes. Rendered
   * in the console and copied into a game, so the paths are computed here
   * rather than typed twice (the doc-key block's discipline).
   */
  const apiBlock = (col: KvCollectionRow) => ({
    configured: doc !== "",
    baseUrl: doc,
    metaPath: `/kv/${col.id}`,
    entriesPath: `/kv/${col.id}/entries`,
    ...(isUserNamespace(col)
      ? { ownerPath: `/kv/${col.id}/u/{ownerId}/entries` }
      : {}),
  });

  async function collectionViews<
    T extends KvCollectionListRow | KvCollectionRow,
  >(rows: T[]) {
    const crumb = await crumbs(rows);
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      readScope: c.readScope,
      writeScope: c.writeScope,
      encrypted: c.encrypted,
      maxEntries: c.maxEntries,
      maxEntriesPerOwner: c.maxEntriesPerOwner,
      ...("entries" in c ? { entries: c.entries } : {}),
      ...("description" in c ? { description: c.description } : {}),
      ...crumb(c),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  }

  /**
   * Whether a read may carry values at all.
   *
   * Two ways it may not, and they meet in the same shape — keys, owners,
   * sizes and times, no `valueText`. An encrypted collection is one
   * (`docs/decisions.md` #8: the DEK is the state stack's). The other is a
   * platform admin with **no seat in the team**: the override exists so an
   * admin can see that a resource exists and delete a team, and
   * `team-access.ts` states it never reaches a secret — a collection's values
   * are the team's own payload, the counterpart of the `secret_json` no
   * channel view has ever rendered. A seated admin is judged by the seat, like
   * everywhere else.
   */
  const mayReadValues = (col: KvCollectionRow, a: ResourceAccess<"kv">) =>
    !col.encrypted && a.standing !== "admin";

  /**
   * One entry as the console sees it. `valueText` is the stored text verbatim
   * — never re-encoded, because `JSON.stringify(JSON.parse(x))` is lossy and a
   * collection carries a game's own schema.
   */
  const entryView = (
    col: KvCollectionRow,
    row: KvEntryRow,
    withValue: boolean,
  ) => ({
    ...(isUserNamespace(col) ? { owner: row.ownerId } : {}),
    key: row.key,
    version: row.version,
    bytes: row.bytes,
    expiresAt: row.expiresAt,
    channelId: row.channelId,
    updatedAt: row.updatedAt,
    ...(withValue && row.value !== undefined ? { valueText: row.value } : {}),
  });

  const kvHistory = (
    col: KvCollectionRow,
    actorId: string,
    action: "resource.create" | "resource.delete",
  ) =>
    history(
      col.teamId,
      actorId,
      action,
      col.id,
      { resource: { kind: "kv", id: col.id, name: col.name } },
      now(),
    );

  /**
   * The audit line of an entry write. The collection and the owner, never the
   * key and never the value (`docs/decisions.md` #5): a key is plaintext even
   * in an encrypted collection, and the audit log has no expiry.
   */
  const entryAudit = (
    id: ConsoleIdentity,
    action: string,
    col: KvCollectionRow,
    owner: string,
  ) =>
    audit(id.subject, action, col.id, {
      collectionId: col.id,
      ...(owner === KV_SHARED_OWNER ? {} : { owner }),
    });

  async function requireFreeName(
    teamId: string,
    name: string,
    exceptId?: string,
  ): Promise<void> {
    const hit = await kvstore.findCollectionByName(teamId, name);
    if (hit && hit.id !== exceptId)
      throw new AppError(
        "conflict",
        `a kv collection named "${name}" already exists in this team`,
      );
  }

  const noStore = (statusCode: number, body: unknown) =>
    json(body, { status: statusCode, noStore: true });

  /**
   * One page of entries. Values come along for a plaintext collection — the
   * table shows them — and never for an encrypted one, where the column holds
   * an envelope only the state stack can open.
   */
  async function listing(
    a: ResourceAccess<"kv">,
    query: z.infer<typeof entriesQuery>,
  ) {
    const col = a.row;
    const withValue = mayReadValues(col, a);
    refuseOwner(col, query.owner);
    const owner = isUserNamespace(col) ? query.owner : undefined;
    // An absent (or empty) `owner` on a user namespace lists every owner's
    // entries, which is what the collection page's table shows.
    if (owner !== undefined && owner !== "") checkKvOwnerId(owner);
    const page = await kvstore.listEntries({
      collectionId: col.id,
      // A shared namespace has exactly one owner slot, and fixing it turns a
      // prefix filter into a range scan on the primary key.
      ...(isUserNamespace(col)
        ? owner === undefined || owner === ""
          ? {}
          : { ownerId: owner }
        : { ownerId: KV_SHARED_OWNER }),
      ...(query.prefix === undefined ? {} : { prefix: query.prefix }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.order === undefined ? {} : { order: query.order }),
      now: now(),
      withValue,
    });
    return {
      entries: page.rows.map((r) => entryView(col, r, withValue)),
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
  }

  return [
    defineRoute({
      method: "GET",
      path: "/projects/{prj}/kv",
      auth: true,
      query: collectionsQuery,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!);
        return {
          collections: await collectionViews(
            await kvstore.listCollections({
              ...listParams(ctx.query),
              projectId: a.project.id,
              now: now(),
            }),
          ),
        };
      },
    }),
    defineRoute({
      method: "POST",
      path: "/projects/{prj}/kv",
      auth: true,
      body: kvCreateBody,
      handler: async (ctx) => {
        const a = await projectAccess(ctx, ctx.params.prj!, { secret: true });
        await writeSlot(a.id);
        const encrypted = ctx.body.encrypted ?? false;
        checkKvScopes(ctx.body.readScope, ctx.body.writeScope, encrypted);
        const maxEntries = ctx.body.maxEntries ?? KV_MAX_ENTRIES_DEFAULT;
        const maxEntriesPerOwner =
          ctx.body.maxEntriesPerOwner ?? KV_MAX_ENTRIES_PER_OWNER_DEFAULT;
        checkKvCaps(maxEntries, maxEntriesPerOwner);
        // The DEK is minted by the state stack on the collection's first
        // write. Without one, an encrypted collection could never hold a
        // value — the same 503 the doc key answers on such a stage.
        if (encrypted && doc === "")
          throw new AppError(
            "unavailable",
            "document storage is not configured; an encrypted collection needs the state stack",
            { details: { reason: "state_not_configured" } },
          );
        if (
          (await kvstore.countCollections(a.project.id)) >=
          KV_COLLECTIONS_PER_PROJECT
        )
          throw new AppError(
            "conflict",
            `at most ${KV_COLLECTIONS_PER_PROJECT} kv collections per project`,
          );
        await requireFreeName(a.team.id, ctx.body.name);
        const at = now();
        // Time-ordered, lower case: `KV_COLLECTION_ID_RE` is what the KV API
        // checks before it touches the database, and the value AAD binds the
        // id byte for byte.
        const id = `kv_${ulid(at * 1000).toLowerCase()}`;
        await kvstore.insertCollection({
          id,
          teamId: a.team.id,
          projectId: a.project.id,
          name: ctx.body.name,
          description: ctx.body.description ?? null,
          readScope: ctx.body.readScope,
          writeScope: ctx.body.writeScope,
          encrypted,
          maxEntries,
          maxEntriesPerOwner,
          ownerId: a.id.subject,
          at,
        });
        const row = await kvstore.findCollection(id);
        if (!row) throw new AppError("unavailable", "collection vanished");
        await audit(a.id.subject, "kv.create", id, {
          name: ctx.body.name,
          projectId: a.project.id,
          readScope: row.readScope,
          writeScope: row.writeScope,
          encrypted: row.encrypted,
        });
        await kvHistory(row, a.id.subject, "resource.create");
        return noStore(201, {
          ...(await collectionViews([row]))[0]!,
          api: apiBlock(row),
        });
      },
    }),
    {
      method: "GET",
      path: "/kv/{id}",
      auth: true,
      handler: async (ctx) => {
        const a = await collectionWith(ctx, false);
        // The shape and the count, never the rows. Inlining the first page
        // here would make `entries` a number on the list route and an array on
        // this one — one field name, two types, read by the SPA and the CLI
        // (found by review, 2026-09-04) — and the collection page asks
        // `/kv/{id}/entries` for its table anyway, because that is where the
        // prefix, the owner filter and the cursor live.
        return noStore(200, {
          ...(await collectionViews([a.row]))[0]!,
          entries: await kvstore.countEntries(a.row.id, { now: now() }),
          api: apiBlock(a.row),
        });
      },
    },
    defineRoute({
      method: "PATCH",
      path: "/kv/{id}",
      auth: true,
      body: kvPatchBody,
      handler: async (ctx) => {
        const { id, row, team: o } = await collectionWith(ctx, true);
        await writeSlot(id);
        const patch: {
          name?: string;
          description?: string | null;
          maxEntries?: number;
          maxEntriesPerOwner?: number;
        } = {};
        if (ctx.body.name !== undefined && ctx.body.name !== row.name) {
          await requireFreeName(o.id, ctx.body.name, row.id);
          patch.name = ctx.body.name;
        }
        if (ctx.body.description !== undefined)
          patch.description = ctx.body.description;
        if (ctx.body.maxEntries !== undefined)
          patch.maxEntries = ctx.body.maxEntries;
        if (ctx.body.maxEntriesPerOwner !== undefined)
          patch.maxEntriesPerOwner = ctx.body.maxEntriesPerOwner;
        // Both caps are ranged together, so lowering one cannot smuggle the
        // other past its hard cap on the way through.
        checkKvCaps(
          patch.maxEntries ?? row.maxEntries,
          patch.maxEntriesPerOwner ?? row.maxEntriesPerOwner,
        );
        if (!(await kvstore.updateCollection(row.id, patch, now())))
          throw new AppError("not_found", "collection not found");
        await audit(id.subject, "kv.update", row.id, {
          fields: Object.keys(patch),
        });
        const after = await kvstore.findCollection(row.id);
        if (!after) throw new AppError("not_found", "collection not found");
        return {
          ...(await collectionViews([after]))[0]!,
          api: apiBlock(after),
        };
      },
    }),
    {
      method: "DELETE",
      path: "/kv/{id}",
      auth: true,
      handler: async (ctx) => {
        const { id, row } = await collectionWith(ctx, true);
        await writeSlot(id);
        // Soft-delete first: it frees the name in the same statement, so a
        // recreate under the old name works while the rows are still draining.
        if (!(await kvstore.softDeleteCollection(row.id, now())))
          throw new AppError("not_found", "collection not found");
        await audit(id.subject, "kv.delete", row.id, { name: row.name });
        await kvHistory(row, id.subject, "resource.delete");
        // A cascading DELETE of a collection at its cap does not fit MariaDB's
        // 5 s statement limit, so the rows go in bounded batches: this many
        // inline, and whatever is left to the daily sweep, which walks the
        // soft-deleted queue.
        let drained = 0;
        for (let i = 0; i < KV_DRAIN_MAX_BATCHES; i++) {
          const gone = await kvstore.deleteEntriesBatch(row.id, KV_DRAIN_BATCH);
          drained += gone;
          if (gone < KV_DRAIN_BATCH) break;
        }
        const purged = await kvstore.deleteCollectionRow(row.id);
        if (!purged)
          logger.info("kv collection still draining", {
            collectionId: row.id,
            drained,
          });
        return undefined;
      },
    },
    defineRoute({
      method: "GET",
      path: "/kv/{id}/entries",
      auth: true,
      query: entriesQuery,
      handler: async (ctx) => {
        const a = await collectionWith(ctx, false);
        return noStore(200, await listing(a, ctx.query));
      },
    }),
    defineRoute({
      method: "GET",
      path: "/kv/{id}/entries/{key}",
      auth: true,
      query: ownerQuery,
      handler: async (ctx) => {
        const a = await collectionWith(ctx, false);
        const owner = ownerOf(a.row, ctx.query.owner);
        const key = ctx.params.key ?? "";
        checkKvKey(key);
        const withValue = mayReadValues(a.row, a);
        const entry = await kvstore.findEntry(a.row.id, owner, key, {
          now: now(),
          withValue,
        });
        if (!entry) throw new AppError("not_found", "entry not found");
        return noStore(200, entryView(a.row, entry, withValue));
      },
    }),
    defineRoute({
      method: "PUT",
      path: "/kv/{id}/entries/{key}",
      auth: true,
      body: kvEntryBody,
      handler: async (ctx) => {
        const { id, row } = await collectionWith(ctx, true);
        await writeSlot(id);
        if (row.encrypted) throw encryptedReadOnly();
        const owner = ownerOf(row, ctx.body.owner);
        const key = ctx.params.key ?? "";
        checkKvKey(key);
        const expiresAt = expiryOf(ctx.body.ttl);
        const text = ctx.body.valueText;
        // Stored verbatim, so it is parsed only to prove it is JSON: a value
        // the platform re-encoded would come back a different document.
        try {
          JSON.parse(text);
        } catch {
          throw new AppError("bad_request", "valueText must be JSON");
        }
        const bytes = kvValueBytes(text);
        if (bytes > MAX_KV_VALUE_BYTES)
          throw new AppError(
            "payload_too_large",
            `value exceeds ${MAX_KV_VALUE_BYTES} bytes`,
          );
        const at = now();
        // Caps are counted on create only, so a create has to be told from an
        // update first. `ifVersion` names a version, which no absent row has.
        if (
          ctx.body.ifVersion === undefined &&
          !(await kvstore.findEntry(row.id, owner, key, { now: at }))
        )
          // No `ownerId`: `maxEntriesPerOwner` bounds a *player*, and a team
          // member writing through the console is bounded by `maxEntries`
          // alone (`docs/decisions.md` #7).
          await ensureKvRoom(kvstore, row, { now: at });
        const r = await kvstore.putEntry({
          collectionId: row.id,
          ownerId: owner,
          key,
          value: text,
          bytes,
          expiresAt,
          // No channel derived this row, and the console cannot guess which
          // one derived the `owner` a member typed — a project may hold
          // several auth channels. `docs/decisions.md` #9 grants the
          // outliving exemption to console rows in the **shared** namespace;
          // a console row in an owner namespace is a case it does not answer,
          // and it survives its channel today (owner decision 5 in
          // `todo/33-kvstore.md`, raised by the S4 security review).
          channelId: null,
          ...(ctx.body.ifVersion === undefined
            ? {}
            : { ifVersion: ctx.body.ifVersion }),
          at,
        });
        if (!r.ok)
          return json(
            {
              error: {
                code: "conflict",
                message: "version mismatch",
                details: {
                  current: r.current === undefined ? null : r.current.version,
                },
              },
            },
            { status: 409, noStore: true },
          );
        await entryAudit(id, "kv.entry.put", row, owner);
        return noStore(r.created ? 201 : 200, {
          ...(isUserNamespace(row) ? { owner } : {}),
          key,
          version: r.version,
          bytes,
          created: r.created,
        });
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/kv/{id}/entries/{key}",
      auth: true,
      query: ownerQuery,
      handler: async (ctx) => {
        const { id, row } = await collectionWith(ctx, true);
        await writeSlot(id);
        // Deliberately allowed on an encrypted collection: an owner who cannot
        // read a value must still be able to remove it (`docs/decisions.md` #8).
        const owner = ownerOf(row, ctx.query.owner);
        const key = ctx.params.key ?? "";
        checkKvKey(key);
        const r = await kvstore.deleteEntry(row.id, owner, key, { now: now() });
        if (r === "missing") throw new AppError("not_found", "entry not found");
        await entryAudit(id, "kv.entry.delete", row, owner);
        return undefined;
      },
    }),
    defineRoute({
      method: "DELETE",
      path: "/kv/{id}/entries",
      auth: true,
      query: ownerQuery,
      handler: async (ctx) => {
        const { id, row } = await collectionWith(ctx, true);
        await writeSlot(id);
        const owner = ownerOf(row, ctx.query.owner);
        let deleted = 0;
        let truncated = true;
        for (let i = 0; i < KV_DRAIN_MAX_BATCHES; i++) {
          const gone = await kvstore.deleteOwnerEntries(
            row.id,
            owner,
            KV_DRAIN_BATCH,
          );
          deleted += gone;
          if (gone < KV_DRAIN_BATCH) {
            truncated = false;
            break;
          }
        }
        await entryAudit(id, "kv.entries.clear", row, owner);
        if (truncated)
          // Said twice on purpose: `truncated` tells the caller to come back,
          // and the log line is what an operator has when it did not. Nothing
          // else finishes this — the sweep walks soft-deleted collections and
          // expired rows, and these rows are neither.
          logger.info("kv owner clear truncated", {
            collectionId: row.id,
            deleted,
          });
        return json({ deleted, truncated }, { noStore: true });
      },
    }),
  ];
}

/**
 * Best-effort purge of the entries a channel's players wrote, for a channel
 * that is going away — the twin of `deleteChannelDocs`, at the same lifecycle
 * point and for the same reason: a userId means nothing outside the auth
 * channel that derived it, so rows nobody can address are the alternative
 * (`docs/decisions.md` #9). Shared-namespace rows survive; a team's
 * announcement is not one player's.
 *
 * Bounded like every other batched delete, and it never throws: the channel
 * delete has already been decided. What this pass does not reach — a channel
 * whose players wrote more than the budget, or a database that was away — is
 * reached by the daily sweep when the row is *hard* deleted 30 days later,
 * which is the last moment its id still exists anywhere (`handler.ts` feeds
 * the sweep both `runExpire` lists for exactly that reason).
 */
export async function deleteChannelKvEntries(
  kvstore: Pick<KvStoreDb, "deleteChannelEntries">,
  channelId: string,
  logger: Logger,
): Promise<number> {
  let deleted = 0;
  try {
    for (let i = 0; i < KV_DRAIN_MAX_BATCHES; i++) {
      const gone = await kvstore.deleteChannelEntries(
        channelId,
        KV_DRAIN_BATCH,
      );
      deleted += gone;
      if (gone < KV_DRAIN_BATCH) break;
    }
  } catch (e) {
    logger.error("kv entry purge failed", {
      channelId,
      message: e instanceof Error ? e.message : String(e),
    });
  }
  return deleted;
}
