import { AppError } from "@yyt/core";
import {
  cmpBin,
  cmpCi,
  cmpNum,
  dir,
  enumRank,
  escapeLike,
  likeContains,
  matchesQ,
  normalizeQ,
  nullable,
  padSpace,
  sortRows,
  type Comparator,
  type ListQuery,
  type SortOrder,
} from "./list.js";
import {
  isConflict,
  nul,
  num,
  run,
  translatePrismaError,
  type PrismaClient,
} from "./prisma.js";
import { Prisma } from "./generated/prisma/client.js";

/*
 * The `kv` storage shape (migration `m0014_kvstore`, docs/decisions.md
 * *Key-value store (`kv`)*): per-project collections of JSON values addressed
 * by key. Two writers share this repository -- the console API and the state
 * stack's `/kv/*` routes -- so every cap, every grammar rule and the
 * compare-and-set itself live here rather than in one route, and the contract
 * test pins both implementations to the same answers.
 *
 * `KvStoreDb`/`kvstore` rather than `KvDb`/`kv`: `Kv`/`kv` already name the
 * Redis client in console (`handler.ts`, `write-slot.ts`).
 */

export const KV_SCOPES = ["team", "project", "user"] as const;
export type KvScope = (typeof KV_SCOPES)[number];

export const KV_COLLECTION_SORT_KEYS = [
  "name",
  "readScope",
  "writeScope",
  "entries",
  "createdBy",
  "updatedAt",
] as const;
export type KvCollectionSortKey = (typeof KV_COLLECTION_SORT_KEYS)[number];

/** Collections one project may hold; counted on create only. */
export const KV_COLLECTIONS_PER_PROJECT = 20;
/**
 * Largest value a single entry may carry, in bytes **as sent** -- the doc
 * store's byte-exact rule (`MAX_DOC_BODY_BYTES`). The column is `MEDIUMTEXT`,
 * so the limit is a product one: one player must not fill a shared collection.
 */
export const MAX_KV_VALUE_BYTES = 16 * 1024;
/**
 * Largest text the `v` column may hold. An encrypted collection stores
 * `enc1.{iv}.{ct}.{tag}` base64url, which inflates the plaintext by about a
 * third, so bounding the stored text by {@link MAX_KV_VALUE_BYTES} would cut
 * the real value cap to roughly 12 KiB for exactly the collections whose
 * owners cannot see why.
 */
export const MAX_KV_STORED_BYTES = 32 * 1024;
export const KV_MAX_ENTRIES_DEFAULT = 10_000;
export const KV_MAX_ENTRIES_HARD = 100_000;
export const KV_MAX_ENTRIES_PER_OWNER_DEFAULT = 100;
export const KV_MAX_ENTRIES_PER_OWNER_HARD = 1_000;
export const KV_LIST_LIMIT_DEFAULT = 50;
export const KV_LIST_LIMIT_MAX = 100;
export const KV_TTL_MIN_SECONDS = 1;
/** 366 days: a leap year, so "a year" is always expressible. */
export const KV_TTL_MAX_SECONDS = 366 * 24 * 60 * 60;
/**
 * Keys are identifiers, not data: they stay plaintext even in an encrypted
 * collection and appear in console tables. No `/` (it would read as a path
 * segment) and no `@` (an address is data about a person).
 */
export const KV_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** `owner_id` of every entry outside a user namespace. */
export const KV_SHARED_OWNER = "";
/** Collection id shape; also the name a soft-delete parks the row on. */
export const KV_COLLECTION_ID_RE = /^kv_[0-9a-z]{26}$/;
/**
 * Ceiling on any one batched delete. Measured on an idle MariaDB with 16 KiB
 * values: 1,000 rows take ~0.13 s and 10,000 take ~1.3 s -- and the statement
 * holds row locks on every one of them for that long, against a 5 s
 * `max_statement_time` on a shared host. The sweep's batch is 1,000; this is
 * the bound past which a caller is refused outright.
 */
export const KV_DELETE_BATCH_MAX = 2_000;

export interface KvCollectionRow {
  id: string;
  teamId: string;
  projectId: string;
  name: string;
  description: string | null;
  readScope: KvScope;
  writeScope: KvScope;
  encrypted: boolean;
  maxEntries: number;
  maxEntriesPerOwner: number;
  /** Creator, kept for display; authorization is team membership. */
  ownerId: string | null;
  /** Set once the delete claim is taken; the rows drain afterwards. */
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * A collection without its `description`: that column is `MEDIUMTEXT` and a
 * list must not read one per row (`rules/data.md`), so the projection leaves
 * it out and the type says so.
 */
export type KvCollectionMeta = Omit<KvCollectionRow, "description">;

/** A collection in a list, with the derived entry count. */
export type KvCollectionListRow = KvCollectionMeta & { entries: number };

export interface KvCollectionInput {
  id: string;
  teamId: string;
  projectId: string;
  name: string;
  description: string | null;
  readScope: KvScope;
  writeScope: KvScope;
  encrypted: boolean;
  maxEntries: number;
  maxEntriesPerOwner: number;
  ownerId: string | null;
  at: number;
}

/**
 * What an edit may touch. `readScope`, `writeScope` and `encrypted` are absent
 * on purpose: they are immutable after creation (the state stack writes while
 * console edits, and a shape change mid-flight would mix plaintext with
 * ciphertext, or shared rows with owner rows, in one table).
 */
export interface KvCollectionPatch {
  name?: string;
  description?: string | null;
  maxEntries?: number;
  maxEntriesPerOwner?: number;
}

export interface KvCollectionFilter extends ListQuery<KvCollectionSortKey> {
  projectId?: string;
  teamIds?: string[];
  /** Required: the derived `entries` count hides expired rows. */
  now: number;
}

/** An entry without its value -- all console may see of an encrypted collection. */
export interface KvEntryMeta {
  collectionId: string;
  ownerId: string;
  key: string;
  /** Plaintext byte length, so an encrypted collection still reports real sizes. */
  bytes: number;
  /** Monotonic per key; an expiry never resets it. */
  version: number;
  expiresAt: number | null;
  /** The auth channel whose credential wrote the row; null for console writes. */
  channelId: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * An entry read. `value` is present only when the read asked for it
 * (`withValue`), because a list, or a meta read of an encrypted collection,
 * must not pull `MEDIUMTEXT` it will discard.
 */
export interface KvEntryRow extends KvEntryMeta {
  value?: string;
}

export interface KvEntryQuery {
  collectionId: string;
  /** One owner's namespace; omitted lists every owner in key order. */
  ownerId?: string;
  prefix?: string;
  cursor?: string;
  limit?: number;
  /** Expired rows are invisible to every read. */
  now: number;
  withValue?: boolean;
  order?: SortOrder;
}

export interface KvEntryPage {
  rows: KvEntryRow[];
  nextCursor?: string;
}

export interface KvEntryPut {
  collectionId: string;
  ownerId: string;
  key: string;
  /** Stored verbatim: JSON text as sent, or `enc1.` ciphertext. */
  value: string;
  /** Plaintext bytes; the caller measures before encrypting. */
  bytes: number;
  /** `"keep"` leaves an existing expiry alone; `null` clears it. */
  expiresAt: number | null | "keep";
  channelId: string | null;
  /**
   * `"absent"` is create-only (`If-None-Match: *`), a number is `If-Match`, and
   * omitting it is an unconditional write -- which is still a bounded
   * compare-and-set inside, so the version handed back is always `read + 1`.
   */
  ifVersion?: number | "absent";
  at: number;
}

export type KvPutResult =
  /**
   * The version **this** write produced -- never a re-read of the row, for the
   * reason `state.ts` spells out: a re-read is a concurrent writer's answer.
   * `created` is what tells 201 from 204; a write over an expired row is a
   * create, because the entry was absent to every reader.
   */
  | { ok: true; version: number; created: boolean }
  /** Precondition failed; `current` is the live row, absent when there is none. */
  | { ok: false; current: KvEntryMeta | undefined };

export type KvDeleteResult = "deleted" | "missing" | "conflict";

export interface KvKeyRow {
  collectionId: string;
  dekWrapped: string;
  createdAt: number;
}

/** Byte length, not code units: the cap is about storage and values are text. */
export const kvValueBytes = (value: string): number =>
  Buffer.byteLength(value, "utf8");

/**
 * What a writer stores. The product cap is on the value **as the caller sent
 * it** (`bytes`), which is the plaintext even when the stored text is
 * ciphertext; the stored text gets its own, looser bound so the column stays
 * sane. Both writers inherit this by going through the repository.
 */
export function checkKvEntrySize(value: string, bytes: number): void {
  if (!Number.isInteger(bytes) || bytes < 0)
    throw new AppError("bad_request", "invalid byte count");
  if (bytes > MAX_KV_VALUE_BYTES)
    throw new AppError("payload_too_large", "value too large");
  if (kvValueBytes(value) > MAX_KV_STORED_BYTES)
    throw new AppError("payload_too_large", "stored value too large");
}

/**
 * The `owner_id` column is `VARCHAR(64)` and the shared namespace is `""`. The
 * grammar of a real owner id belongs to the routes that mint it; what the
 * repository owes both implementations is that a value too long for the column
 * is a `bad_request` here rather than a driver error on one side and a happy
 * insert into a fake map on the other.
 */
export function checkKvOwner(ownerId: string): void {
  if (ownerId.length > 64 || ownerId.includes(CURSOR_SEP))
    throw new AppError("bad_request", "invalid owner");
}

/** Throws `bad_request` unless `key` matches {@link KV_KEY_RE}. */
export function checkKvKey(key: string): void {
  if (!KV_KEY_RE.test(key)) throw new AppError("bad_request", "invalid key");
}

/**
 * How `utf8mb4_unicode_ci` sees a name: case-folded, accent-folded and PAD
 * SPACE. The id-shape check below has to compare the way the unique index
 * does, or `KV_01H…` and `kv_01h…` are one name to MariaDB and two to us.
 */
const foldName = (name: string): string =>
  name.trimEnd().normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * The collection name. Refused here rather than only at the route because
 * `softDeleteCollection` parks the freed row on its own id: a name the unique
 * index would call equal to some collection's id can block that collection's
 * delete for good.
 */
export function checkKvName(name: string): void {
  if (name.length === 0 || name.length > 255)
    throw new AppError("bad_request", "invalid name");
  if (KV_COLLECTION_ID_RE.test(foldName(name)))
    throw new AppError(
      "bad_request",
      "name must not look like a collection id",
    );
}

/** Both caps, ranged; shared by create and edit so an edit cannot widen past the hard cap. */
export function checkKvCaps(
  maxEntries: number,
  maxEntriesPerOwner: number,
): void {
  const ranged = (v: number, hard: number) =>
    Number.isInteger(v) && v >= 1 && v <= hard;
  if (!ranged(maxEntries, KV_MAX_ENTRIES_HARD))
    throw new AppError(
      "bad_request",
      `maxEntries must be 1..${KV_MAX_ENTRIES_HARD}`,
    );
  if (!ranged(maxEntriesPerOwner, KV_MAX_ENTRIES_PER_OWNER_HARD))
    throw new AppError(
      "bad_request",
      `maxEntriesPerOwner must be 1..${KV_MAX_ENTRIES_PER_OWNER_HARD}`,
    );
}

/**
 * The two combinations that leave nobody able to use the collection.
 * `readScope: user` without `writeScope: user` names an owner namespace that
 * does not exist; `encrypted` with a `team` scope means either nobody can read
 * a value or nobody can write one, since console never holds the key.
 */
export function checkKvScopes(
  readScope: KvScope,
  writeScope: KvScope,
  encrypted: boolean,
): void {
  if (readScope === "user" && writeScope !== "user")
    throw new AppError(
      "bad_request",
      "readScope user requires writeScope user",
    );
  if (encrypted && (readScope === "team" || writeScope === "team"))
    throw new AppError(
      "bad_request",
      "an encrypted collection cannot have a team scope",
    );
}

/** NUL separates the payload; neither an owner id nor a key may contain it. */
const CURSOR_SEP = "\u0000";

/**
 * Keyset cursor over `(owner_id, k)`. Not the `at:id` codec `team.ts` uses: a
 * key may contain `:`, so the delimiter has to be one the grammar forbids.
 */
export function encodeKvCursor(row: { ownerId: string; key: string }): string {
  return Buffer.from(`${row.ownerId}${CURSOR_SEP}${row.key}`, "utf8").toString(
    "base64url",
  );
}

export function decodeKvCursor(
  cursor: string,
): { ownerId: string; key: string } | undefined {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  const i = text.indexOf(CURSOR_SEP);
  if (i < 0) return undefined;
  const ownerId = text.slice(0, i);
  const key = text.slice(i + 1);
  // Both halves have to be values the table could hold: an owner longer than
  // the column, or a key outside the grammar, is a forged cursor.
  if (ownerId.length > 64 || !KV_KEY_RE.test(key)) return undefined;
  return { ownerId, key };
}

/**
 * How many rows a page reads; shared so both implementations bound alike.
 * `NaN` has to be named: a route doing `Number(qs.limit)` on `?limit=abc`
 * otherwise reaches `take: NaN`, which Prisma rejects as a validation error
 * and `translatePrismaError` turns into a 503 for a client typo.
 */
export const kvPageLimit = (limit: number | undefined): number => {
  const n = Math.trunc(Number(limit ?? KV_LIST_LIMIT_DEFAULT));
  if (!Number.isFinite(n)) return KV_LIST_LIMIT_DEFAULT;
  return Math.min(KV_LIST_LIMIT_MAX, Math.max(1, n));
};

function checkKvVersion(v: number): void {
  if (!Number.isInteger(v) || v < 1)
    throw new AppError("bad_request", "invalid version");
}

/**
 * A batch bound is interpolated into SQL as a literal (MariaDB takes no
 * placeholder in `LIMIT`), so it is validated as a small positive integer
 * first and never comes from a request body.
 */
function checkBatchLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > KV_DELETE_BATCH_MAX)
    throw new AppError("bad_request", "invalid batch limit");
  return limit;
}

export interface KvStoreDb {
  insertCollection(input: KvCollectionInput): Promise<void>;
  /** Soft-deleted rows come back too; callers decide what `deletedAt` means to them. */
  findCollection(id: string): Promise<KvCollectionRow | undefined>;
  /** Case-insensitively, like the `(team_id, name)` unique index. */
  findCollectionByName(
    teamId: string,
    name: string,
  ): Promise<KvCollectionRow | undefined>;
  /** Live collections only, with the derived entry count. */
  listCollections(filter: KvCollectionFilter): Promise<KvCollectionListRow[]>;
  updateCollection(
    id: string,
    patch: KvCollectionPatch,
    at: number,
  ): Promise<boolean>;
  /** Takes the delete claim and frees the name in one statement. */
  softDeleteCollection(id: string, at: number): Promise<boolean>;
  /** The sweep's queue: rows whose claim is taken, oldest first. */
  listDeletedCollections(limit: number): Promise<KvCollectionMeta[]>;
  /**
   * Drops a soft-deleted row, but only once its entries are gone: the child
   * foreign key cascades, and a cascade over a collection at its cap does not
   * fit MariaDB's 5 s statement limit. `false` therefore means "still
   * draining" as well as "not there", and the sweep simply comes back.
   */
  deleteCollectionRow(id: string): Promise<boolean>;
  countCollections(projectId: string): Promise<number>;
  /** Live rows only -- an expired entry does not count against a cap. */
  countEntries(
    collectionId: string,
    opts: { now: number; ownerId?: string },
  ): Promise<number>;
  listEntries(q: KvEntryQuery): Promise<KvEntryPage>;
  findEntry(
    collectionId: string,
    ownerId: string,
    key: string,
    opts: { now: number; withValue?: boolean },
  ): Promise<KvEntryRow | undefined>;
  putEntry(input: KvEntryPut): Promise<KvPutResult>;
  deleteEntry(
    collectionId: string,
    ownerId: string,
    key: string,
    opts: { now: number; ifVersion?: number },
  ): Promise<KvDeleteResult>;
  /** Drain step of a collection delete; returns how many rows went. */
  deleteEntriesBatch(collectionId: string, limit: number): Promise<number>;
  /** One owner's namespace, in bounded batches for the same reason. */
  deleteOwnerEntries(
    collectionId: string,
    ownerId: string,
    limit: number,
  ): Promise<number>;
  /** Expiry reclamation, always scoped to one collection (`rules/data.md`). */
  deleteExpiredEntries(
    collectionId: string,
    now: number,
    limit: number,
  ): Promise<number>;
  /**
   * Entries a player wrote through one auth channel, for the channel's hard
   * delete. Shared-namespace rows survive: a userId means nothing outside the
   * channel that derived it, but a team's announcement does.
   */
  deleteChannelEntries(channelId: string, limit: number): Promise<number>;
  /** State stack only; console holds no KEK and never calls these two. */
  findKey(collectionId: string): Promise<KvKeyRow | undefined>;
  insertKey(
    collectionId: string,
    dekWrapped: string,
    at: number,
  ): Promise<"inserted" | "exists">;
}

type CollectionModel = {
  id: string;
  team_id: string;
  project_id: string;
  name: string;
  description: string | null;
  read_scope: KvScope;
  write_scope: KvScope;
  encrypted: boolean;
  max_entries: number;
  max_entries_per_owner: number;
  owner_id: string | null;
  deleted_at: bigint | number | null;
  created_at: bigint | number;
  updated_at: bigint | number;
};

type EntryModel = {
  collection_id: string;
  owner_id: string;
  k: string;
  v?: string;
  bytes: number;
  version: bigint | number;
  channel_id: string | null;
  expires_at: bigint | number | null;
  created_at: bigint | number;
  updated_at: bigint | number;
};

/** Every column but `description`, which no list projection reads. */
const COLLECTION_META_SELECT = {
  id: true,
  team_id: true,
  project_id: true,
  name: true,
  read_scope: true,
  write_scope: true,
  encrypted: true,
  max_entries: true,
  max_entries_per_owner: true,
  owner_id: true,
  deleted_at: true,
  created_at: true,
  updated_at: true,
} as const;

const toCollectionMeta = (
  r: Omit<CollectionModel, "description">,
): KvCollectionMeta => ({
  id: r.id,
  teamId: r.team_id,
  projectId: r.project_id,
  name: r.name,
  readScope: r.read_scope,
  writeScope: r.write_scope,
  encrypted: r.encrypted,
  maxEntries: r.max_entries,
  maxEntriesPerOwner: r.max_entries_per_owner,
  ownerId: r.owner_id,
  deletedAt: nul(r.deleted_at),
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
});

const toCollection = (r: CollectionModel): KvCollectionRow => ({
  ...toCollectionMeta(r),
  description: r.description,
});

const toEntry = (r: EntryModel): KvEntryRow => ({
  collectionId: r.collection_id,
  ownerId: r.owner_id,
  key: r.k,
  bytes: r.bytes,
  version: num(r.version),
  channelId: r.channel_id,
  expiresAt: nul(r.expires_at),
  createdAt: num(r.created_at),
  updatedAt: num(r.updated_at),
  ...(r.v === undefined ? {} : { value: r.v }),
});

const toMeta = (r: KvEntryRow): KvEntryMeta => {
  const { value: _value, ...meta } = r;
  return meta;
};

const isLiveAt = (row: { expiresAt: number | null }, now: number): boolean =>
  row.expiresAt === null || row.expiresAt > now;

/** `q` over the two text columns the collection list shows. */
const nameOrDescription = (q: string | undefined) =>
  q
    ? { OR: [{ name: likeContains(q) }, { description: likeContains(q) }] }
    : {};

function collectionOrderBy(o: KvCollectionFilter) {
  const d = dir(o);
  switch (o.sort) {
    case "name":
      return [{ name: d }, { id: d }];
    case "readScope":
      return [{ read_scope: d }, { id: d }];
    case "writeScope":
      return [{ write_scope: d }, { id: d }];
    case "createdBy":
      return [{ members: { github_login: d } }, { id: d }];
    case "updatedAt":
      return [{ updated_at: d }, { id: d }];
    default:
      // `entries` is derived, so it is ordered after the fetch; everything
      // else falls back to the list's historical order.
      return [{ name: "asc" as const }, { id: "asc" as const }];
  }
}

const byCollectionId: Comparator<{ id: string }> = (a, b) => cmpBin(a.id, b.id);

export function createKvStoreDb(prisma: PrismaClient): KvStoreDb {
  const findRow = async (id: string) => {
    const r = await prisma.kv_collections.findUnique({ where: { id } });
    return r ? toCollection(r) : undefined;
  };

  const entrySelect = (withValue: boolean) => ({
    collection_id: true as const,
    owner_id: true as const,
    k: true as const,
    bytes: true as const,
    version: true as const,
    channel_id: true as const,
    expires_at: true as const,
    created_at: true as const,
    updated_at: true as const,
    ...(withValue ? { v: true as const } : {}),
  });

  const liveWhere = (now: number) => ({
    OR: [{ expires_at: null }, { expires_at: { gt: now } }],
  });

  const findRawEntry = async (
    collectionId: string,
    ownerId: string,
    key: string,
  ): Promise<KvEntryRow | undefined> => {
    const r = await prisma.kv_entries.findUnique({
      where: {
        collection_id_owner_id_k: {
          collection_id: collectionId,
          owner_id: ownerId,
          k: key,
        },
      },
      select: entrySelect(false),
    });
    return r ? toEntry(r) : undefined;
  };

  /**
   * One compare-and-set attempt against the version `expected` (`"absent"`
   * meaning "no row at all"). `undefined` means the row moved underneath, which
   * only the unconditional path retries.
   */
  const attempt = async (
    i: KvEntryPut,
    expiry: number | null | "keep",
    expected: number | "absent",
    created: boolean,
  ): Promise<{ version: number; created: boolean } | undefined> => {
    if (expected === "absent") {
      try {
        await prisma.kv_entries.create({
          data: {
            collection_id: i.collectionId,
            owner_id: i.ownerId,
            k: i.key,
            v: i.value,
            bytes: i.bytes,
            version: 1,
            channel_id: i.channelId,
            expires_at: expiry === "keep" ? null : expiry,
            created_at: i.at,
            updated_at: i.at,
          },
        });
        return { version: 1, created: true };
      } catch (e) {
        if (isConflict(e)) return undefined;
        translatePrismaError(e);
      }
    }
    const r = await prisma.kv_entries.updateMany({
      where: {
        collection_id: i.collectionId,
        owner_id: i.ownerId,
        k: i.key,
        version: expected,
      },
      // The version always changes, so MariaDB's changed-row count is a
      // faithful CAS verdict even when the value is byte-identical.
      data: {
        v: i.value,
        bytes: i.bytes,
        version: expected + 1,
        channel_id: i.channelId,
        updated_at: i.at,
        ...(expiry === "keep" ? {} : { expires_at: expiry }),
      },
    });
    if (r.count === 0) return undefined;
    return { version: expected + 1, created };
  };

  const currentMeta = async (
    i: KvEntryPut,
  ): Promise<KvEntryMeta | undefined> => {
    const row = await findRawEntry(i.collectionId, i.ownerId, i.key);
    return row && isLiveAt(row, i.at) ? toMeta(row) : undefined;
  };

  return {
    insertCollection: (i) =>
      run(async () => {
        checkKvName(i.name);
        checkKvCaps(i.maxEntries, i.maxEntriesPerOwner);
        checkKvScopes(i.readScope, i.writeScope, i.encrypted);
        await prisma.kv_collections.create({
          data: {
            id: i.id,
            team_id: i.teamId,
            project_id: i.projectId,
            name: i.name,
            description: i.description,
            read_scope: i.readScope,
            write_scope: i.writeScope,
            encrypted: i.encrypted,
            max_entries: i.maxEntries,
            max_entries_per_owner: i.maxEntriesPerOwner,
            owner_id: i.ownerId,
            created_at: i.at,
            updated_at: i.at,
          },
        });
      }),

    findCollection: (id) => run(() => findRow(id)),

    findCollectionByName: (teamId, name) =>
      run(async () => {
        const r = await prisma.kv_collections.findFirst({
          where: { team_id: teamId, name },
        });
        return r ? toCollection(r) : undefined;
      }),

    listCollections: (filter) =>
      run(async () => {
        const q = normalizeQ(filter.q);
        const rows = await prisma.kv_collections.findMany({
          where: {
            deleted_at: null,
            ...(filter.projectId ? { project_id: filter.projectId } : {}),
            ...(filter.teamIds ? { team_id: { in: filter.teamIds } } : {}),
            ...nameOrDescription(q),
          },
          orderBy: collectionOrderBy(filter),
          // `description` is searched in SQL but never read back.
          select: COLLECTION_META_SELECT,
        });
        const ids = rows.map((r) => r.id);
        const counts = new Map<string, number>();
        if (ids.length > 0) {
          // One `groupBy` for the page: a range scan on the `collection_id`
          // prefix of `kv_entries_expiry`, never one count per row.
          const grouped = await prisma.kv_entries.groupBy({
            by: ["collection_id"],
            where: { collection_id: { in: ids }, ...liveWhere(filter.now) },
            _count: { _all: true },
          });
          for (const g of grouped) counts.set(g.collection_id, g._count._all);
        }
        const list = rows.map((r) => ({
          ...toCollectionMeta(r),
          entries: counts.get(r.id) ?? 0,
        }));
        // Only `entries` is derived, so only it is ordered here; the rest kept
        // the SQL order an index could serve.
        return filter.sort === "entries"
          ? sortRows(
              list,
              { entries: (a, b) => cmpNum(a.entries, b.entries) },
              filter,
              byCollectionId,
              byCollectionId,
            )
          : list;
      }),

    updateCollection: (id, patch, at) =>
      run(async () => {
        if (patch.name !== undefined) checkKvName(patch.name);
        if (
          patch.maxEntries !== undefined ||
          patch.maxEntriesPerOwner !== undefined
        ) {
          const cur = await findRow(id);
          if (!cur || cur.deletedAt !== null) return false;
          checkKvCaps(
            patch.maxEntries ?? cur.maxEntries,
            patch.maxEntriesPerOwner ?? cur.maxEntriesPerOwner,
          );
        }
        const r = await prisma.kv_collections.updateMany({
          where: { id, deleted_at: null },
          // `updated_at` always changes, so the affected count is a faithful
          // verdict even when the patch is byte-identical to what is stored.
          data: {
            updated_at: at,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.description !== undefined
              ? { description: patch.description }
              : {}),
            ...(patch.maxEntries !== undefined
              ? { max_entries: patch.maxEntries }
              : {}),
            ...(patch.maxEntriesPerOwner !== undefined
              ? { max_entries_per_owner: patch.maxEntriesPerOwner }
              : {}),
          },
        });
        return r.count > 0;
      }),

    softDeleteCollection: (id, at) =>
      run(async () => {
        const r = await prisma.kv_collections.updateMany({
          where: { id, deleted_at: null },
          // The name is freed in the same statement that takes the claim: the
          // row parks on its own id, a shape `checkKvName` forbids a name.
          data: { deleted_at: at, name: id, updated_at: at },
        });
        return r.count > 0;
      }),

    listDeletedCollections: (limit) =>
      run(async () => {
        const rows = await prisma.kv_collections.findMany({
          where: { deleted_at: { not: null } },
          orderBy: [{ deleted_at: "asc" }, { id: "asc" }],
          take: checkBatchLimit(limit),
          select: COLLECTION_META_SELECT,
        });
        // A full scan with a filesort, knowingly: the queue is bounded by the
        // 20-collections-per-project cap, and an index on `deleted_at` would
        // cost a write on every collection write for a column nothing else
        // queries.
        return rows.map(toCollectionMeta);
      }),

    deleteCollectionRow: (id) =>
      run(async () => {
        const r = await prisma.kv_collections.deleteMany({
          // The row goes only once nothing cascades with it: `kv_entries`
          // cascades, and a cascade over a collection at its cap does not fit
          // the 5 s statement limit. So the drain is a precondition, not a
          // convention the caller has to remember.
          where: { id, deleted_at: { not: null }, kv_entries: { none: {} } },
        });
        return r.count > 0;
      }),

    countCollections: (projectId) =>
      run(() =>
        prisma.kv_collections.count({
          where: { project_id: projectId, deleted_at: null },
        }),
      ),

    countEntries: (collectionId, opts) =>
      run(() =>
        prisma.kv_entries.count({
          where: {
            collection_id: collectionId,
            ...(opts.ownerId === undefined ? {} : { owner_id: opts.ownerId }),
            ...liveWhere(opts.now),
          },
        }),
      ),

    listEntries: (q) =>
      run(async () => {
        const limit = kvPageLimit(q.limit);
        const order: SortOrder = q.order ?? "asc";
        const cur = kvCursorOf(q);
        if (q.prefix !== undefined && q.prefix !== "") checkKvKey(q.prefix);
        const cmp = order === "asc" ? "gt" : "lt";
        const rows = await prisma.kv_entries.findMany({
          where: {
            collection_id: q.collectionId,
            ...(q.ownerId === undefined ? {} : { owner_id: q.ownerId }),
            AND: [
              liveWhere(q.now),
              ...(q.prefix
                ? [{ k: { startsWith: escapeLike(q.prefix) } }]
                : []),
              ...(cur
                ? [
                    {
                      OR: [
                        { owner_id: { [cmp]: cur.ownerId } },
                        { owner_id: cur.ownerId, k: { [cmp]: cur.key } },
                      ],
                    },
                  ]
                : []),
            ],
          },
          orderBy: [{ owner_id: order }, { k: order }],
          take: limit + 1,
          select: entrySelect(q.withValue === true),
        });
        const page = rows.slice(0, limit).map(toEntry);
        const last = page[page.length - 1];
        return rows.length > limit && last
          ? { rows: page, nextCursor: encodeKvCursor(last) }
          : { rows: page };
      }),

    findEntry: (collectionId, ownerId, key, opts) =>
      run(async () => {
        const r = await prisma.kv_entries.findUnique({
          where: {
            collection_id_owner_id_k: {
              collection_id: collectionId,
              owner_id: ownerId,
              k: key,
            },
          },
          select: entrySelect(opts.withValue === true),
        });
        if (!r) return undefined;
        const row = toEntry(r);
        return isLiveAt(row, opts.now) ? row : undefined;
      }),

    putEntry: async (i) => {
      checkKvKey(i.key);
      checkKvOwner(i.ownerId);
      checkKvEntrySize(i.value, i.bytes);
      if (typeof i.ifVersion === "number") checkKvVersion(i.ifVersion);
      // Three rounds, then the caller is owed whatever is really stored. Each
      // round re-reads: a sweep may drop the expired row between the read and
      // the update, which turns the next attempt from an update into a create.
      for (let round = 0; round < 3; round++) {
        const cur = await run(() =>
          findRawEntry(i.collectionId, i.ownerId, i.key),
        );
        const live = cur !== undefined && isLiveAt(cur, i.at);
        if (i.ifVersion === "absent") {
          if (live) return { ok: false, current: toMeta(cur) };
        } else if (typeof i.ifVersion === "number") {
          if (!live || cur.version !== i.ifVersion)
            return { ok: false, current: live ? toMeta(cur) : undefined };
        }
        // An expired row keeps its version: a reset would let a stale
        // `If-Match` land on the reborn key. Its *expiry* is another matter --
        // it is in the past, there is nothing to keep, and inheriting it would
        // answer 201 for an entry the next read cannot see.
        const expiry = i.expiresAt === "keep" && !live ? null : i.expiresAt;
        const expected = cur === undefined ? ("absent" as const) : cur.version;
        const done = await run(() => attempt(i, expiry, expected, !live));
        if (done) return { ok: true, ...done };
        // Only `If-Match` names a version, so only `If-Match` has lost
        // outright. "There is nothing here" is a condition worth re-reading:
        // the row that beat us may itself have been swept away.
        if (typeof i.ifVersion === "number")
          return { ok: false, current: await run(() => currentMeta(i)) };
      }
      return { ok: false, current: await run(() => currentMeta(i)) };
    },

    deleteEntry: (collectionId, ownerId, key, opts) =>
      run(async () => {
        if (opts.ifVersion !== undefined) checkKvVersion(opts.ifVersion);
        const cur = await findRawEntry(collectionId, ownerId, key);
        // An expired row is absent to every reader, so it is absent here too;
        // the sweep, not a caller's delete, is what reclaims it.
        if (!cur || !isLiveAt(cur, opts.now)) return "missing";
        if (opts.ifVersion !== undefined && cur.version !== opts.ifVersion)
          return "conflict";
        const r = await prisma.kv_entries.deleteMany({
          where: {
            collection_id: collectionId,
            owner_id: ownerId,
            k: key,
            ...(opts.ifVersion === undefined
              ? {}
              : { version: opts.ifVersion }),
          },
        });
        if (r.count > 0) return "deleted";
        // Nothing went: a concurrent writer moved the version, or removed it.
        return (await findRawEntry(collectionId, ownerId, key))
          ? "conflict"
          : "missing";
      }),

    /*
     * The four batched deletes below need `LIMIT`, which `deleteMany` cannot
     * express, so they are this package's only `$executeRaw`. Tagged template
     * only -- never `$executeRawUnsafe`, never string concatenation
     * (`rules/data.md`) -- and the bound goes in through `Prisma.raw` after
     * `checkBatchLimit`, because MariaDB takes no placeholder in `LIMIT`.
     */
    deleteEntriesBatch: (collectionId, limit) =>
      run(async () => {
        const n = Prisma.raw(String(checkBatchLimit(limit)));
        return prisma.$executeRaw`DELETE FROM \`kv_entries\` WHERE \`collection_id\` = ${collectionId} LIMIT ${n}`;
      }),

    deleteOwnerEntries: (collectionId, ownerId, limit) =>
      run(async () => {
        const n = Prisma.raw(String(checkBatchLimit(limit)));
        return prisma.$executeRaw`DELETE FROM \`kv_entries\` WHERE \`collection_id\` = ${collectionId} AND \`owner_id\` = ${ownerId} LIMIT ${n}`;
      }),

    deleteExpiredEntries: (collectionId, now, limit) =>
      run(async () => {
        const n = Prisma.raw(String(checkBatchLimit(limit)));
        return prisma.$executeRaw`DELETE FROM \`kv_entries\` WHERE \`collection_id\` = ${collectionId} AND \`expires_at\` IS NOT NULL AND \`expires_at\` <= ${now} LIMIT ${n}`;
      }),

    deleteChannelEntries: (channelId, limit) =>
      run(async () => {
        const n = Prisma.raw(String(checkBatchLimit(limit)));
        return prisma.$executeRaw`DELETE FROM \`kv_entries\` WHERE \`channel_id\` = ${channelId} AND \`owner_id\` <> ${KV_SHARED_OWNER} LIMIT ${n}`;
      }),

    findKey: (collectionId) =>
      run(async () => {
        const r = await prisma.kv_keys.findUnique({
          where: { collection_id: collectionId },
        });
        return r
          ? {
              collectionId: r.collection_id,
              dekWrapped: r.dek_wrapped,
              createdAt: num(r.created_at),
            }
          : undefined;
      }),

    insertKey: async (collectionId, dekWrapped, at) => {
      try {
        await prisma.kv_keys.create({
          data: {
            collection_id: collectionId,
            dek_wrapped: dekWrapped,
            created_at: at,
          },
        });
        return "inserted";
      } catch (e) {
        // Two cold starts can mint a DEK for one collection at once; the loser
        // re-reads the winner's key rather than encrypting with its own.
        if (isConflict(e)) return "exists";
        translatePrismaError(e);
      }
    },
  };
}

/** Decodes and validates a page cursor; shared so both implementations refuse alike. */
function kvCursorOf(
  q: KvEntryQuery,
): { ownerId: string; key: string } | undefined {
  if (q.cursor === undefined) return undefined;
  const cur = decodeKvCursor(q.cursor);
  if (cur === undefined) throw new AppError("bad_request", "invalid cursor");
  // A cursor carries an owner, so pasting one owner's cursor onto another
  // owner's path would page through rows the path says are out of scope.
  if (q.ownerId !== undefined && cur.ownerId !== q.ownerId)
    throw new AppError("bad_request", "cursor is for another owner");
  return cur;
}

/** The fake's comparators for {@link KV_COLLECTION_SORT_KEYS}. */
function collectionKeys(
  loginOf: (id: string) => string,
): Record<KvCollectionSortKey, Comparator<KvCollectionListRow>> {
  const scope = enumRank(KV_SCOPES);
  return {
    name: (a, b) => cmpCi(a.name, b.name),
    readScope: (a, b) => scope(a.readScope, b.readScope),
    writeScope: (a, b) => scope(a.writeScope, b.writeScope),
    entries: (a, b) => cmpNum(a.entries, b.entries),
    createdBy: (a, b) =>
      nullable(cmpCi)(
        a.ownerId === null ? null : loginOf(a.ownerId),
        b.ownerId === null ? null : loginOf(b.ownerId),
      ),
    updatedAt: (a, b) => cmpNum(a.updatedAt, b.updatedAt),
  };
}

export interface MemoryKvStoreDeps {
  /** Mirrors the `teams` foreign key. */
  teamExists?: (id: string) => boolean;
  /** Mirrors the `projects` foreign key. */
  projectExists?: (id: string) => boolean;
  /** Mirrors the nullable `members` foreign key. */
  memberExists?: (id: string) => boolean;
  /** A member's GitHub login, for the `createdBy` sort (the table joins it). */
  loginOf?: (id: string) => string;
}

/**
 * In-memory `KvStoreDb` for tests: same contract as the Prisma repository, no
 * SQL. The collations are mirrored deliberately -- `name` is
 * `utf8mb4_unicode_ci` while `owner_id` and `k` are `utf8mb4_bin` -- or the
 * fake would pass tests the real indexes fail.
 */
export function createMemoryKvStoreDb(
  deps: MemoryKvStoreDeps = {},
): KvStoreDb & {
  collections: Map<string, KvCollectionRow>;
  entries: Map<string, KvEntryRow & { value: string }>;
  keys: Map<string, KvKeyRow>;
} {
  const collections = new Map<string, KvCollectionRow>();
  const entries = new Map<string, KvEntryRow & { value: string }>();
  const keys = new Map<string, KvKeyRow>();
  const teamExists = deps.teamExists ?? (() => true);
  const projectExists = deps.projectExists ?? (() => true);
  const memberExists = deps.memberExists ?? (() => true);
  const loginOf = deps.loginOf ?? ((id: string) => `login-${id}`);

  const fk = () => new AppError("unavailable", "database error");
  const conflict = () => new AppError("conflict", "duplicate key");
  // PAD SPACE on both sides -- `padSpace`, not `trimEnd`: the collation
  // ignores trailing U+0020 only, so two owner ids differing by a trailing
  // newline are two rows in MariaDB and would be one in a `trimEnd` map.
  // Only the `_ci` columns fold case.
  const ci = (s: string) => padSpace(s).toLowerCase();
  const bin = (s: string) => padSpace(s);
  const mapKey = (collectionId: string, ownerId: string, key: string) =>
    `${ci(collectionId)} ${bin(ownerId)} ${bin(key)}`;
  const nameTaken = (teamId: string, name: string, exceptId?: string) =>
    [...collections.values()].some(
      (c) =>
        c.teamId === teamId && ci(c.name) === ci(name) && c.id !== exceptId,
    );
  const entriesOf = (collectionId: string) =>
    [...entries.values()].filter(
      (e) => ci(e.collectionId) === ci(collectionId),
    );
  const view = (e: KvEntryRow, withValue: boolean): KvEntryRow =>
    withValue ? { ...e } : toMeta(e);
  const drop = (e: KvEntryRow) =>
    entries.delete(mapKey(e.collectionId, e.ownerId, e.key));

  return {
    collections,
    entries,
    keys,

    insertCollection: async (i) => {
      checkKvName(i.name);
      checkKvCaps(i.maxEntries, i.maxEntriesPerOwner);
      checkKvScopes(i.readScope, i.writeScope, i.encrypted);
      if (!teamExists(i.teamId) || !projectExists(i.projectId)) throw fk();
      if (i.ownerId !== null && !memberExists(i.ownerId)) throw fk();
      if (collections.has(i.id) || nameTaken(i.teamId, i.name))
        throw conflict();
      collections.set(i.id, {
        id: i.id,
        teamId: i.teamId,
        projectId: i.projectId,
        name: i.name,
        description: i.description,
        readScope: i.readScope,
        writeScope: i.writeScope,
        encrypted: i.encrypted,
        maxEntries: i.maxEntries,
        maxEntriesPerOwner: i.maxEntriesPerOwner,
        ownerId: i.ownerId,
        deletedAt: null,
        createdAt: i.at,
        updatedAt: i.at,
      });
    },

    findCollection: async (id) => {
      const c = collections.get(id);
      return c && { ...c };
    },

    findCollectionByName: async (teamId, name) => {
      const c = [...collections.values()].find(
        (x) => x.teamId === teamId && ci(x.name) === ci(name),
      );
      return c && { ...c };
    },

    listCollections: async (filter) => {
      const q = normalizeQ(filter.q);
      const list = [...collections.values()]
        .filter(
          (c) =>
            c.deletedAt === null &&
            (filter.projectId === undefined ||
              c.projectId === filter.projectId) &&
            (filter.teamIds === undefined ||
              filter.teamIds.includes(c.teamId)) &&
            (q === undefined ||
              matchesQ(c.name, q) ||
              matchesQ(c.description, q)),
        )
        .map(({ description: _description, ...meta }) => ({
          ...meta,
          entries: entriesOf(meta.id).filter((e) => isLiveAt(e, filter.now))
            .length,
        }));
      return sortRows(
        list,
        collectionKeys(loginOf),
        filter,
        byCollectionId,
        (a, b) => cmpCi(a.name, b.name) || byCollectionId(a, b),
      );
    },

    updateCollection: async (id, patch, at) => {
      if (patch.name !== undefined) checkKvName(patch.name);
      const c = collections.get(id);
      if (!c || c.deletedAt !== null) return false;
      // Only when the patch carries a cap, like the repository: a stored value
      // outside today's hard range must not make a rename fail.
      if (
        patch.maxEntries !== undefined ||
        patch.maxEntriesPerOwner !== undefined
      )
        checkKvCaps(
          patch.maxEntries ?? c.maxEntries,
          patch.maxEntriesPerOwner ?? c.maxEntriesPerOwner,
        );
      if (patch.name !== undefined && nameTaken(c.teamId, patch.name, id))
        throw conflict();
      collections.set(id, {
        ...c,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description }
          : {}),
        ...(patch.maxEntries !== undefined
          ? { maxEntries: patch.maxEntries }
          : {}),
        ...(patch.maxEntriesPerOwner !== undefined
          ? { maxEntriesPerOwner: patch.maxEntriesPerOwner }
          : {}),
        updatedAt: at,
      });
      return true;
    },

    softDeleteCollection: async (id, at) => {
      const c = collections.get(id);
      if (!c || c.deletedAt !== null) return false;
      collections.set(id, { ...c, deletedAt: at, name: id, updatedAt: at });
      return true;
    },

    listDeletedCollections: async (limit) => {
      const n = checkBatchLimit(limit);
      return [...collections.values()]
        .filter((c) => c.deletedAt !== null)
        .sort(
          (a, b) =>
            cmpNum(a.deletedAt ?? 0, b.deletedAt ?? 0) || byCollectionId(a, b),
        )
        .slice(0, n)
        .map(({ description: _description, ...meta }) => meta);
    },

    deleteCollectionRow: async (id) => {
      const c = collections.get(id);
      if (!c || c.deletedAt === null) return false;
      if (entriesOf(id).length > 0) return false;
      collections.delete(id);
      // FK cascade.
      keys.delete(id);
      return true;
    },

    countCollections: async (projectId) =>
      [...collections.values()].filter(
        (c) => c.projectId === projectId && c.deletedAt === null,
      ).length,

    countEntries: async (collectionId, opts) =>
      entriesOf(collectionId).filter(
        (e) =>
          isLiveAt(e, opts.now) &&
          (opts.ownerId === undefined || bin(e.ownerId) === bin(opts.ownerId)),
      ).length,

    listEntries: async (q) => {
      const limit = kvPageLimit(q.limit);
      const order: SortOrder = q.order ?? "asc";
      const cur = kvCursorOf(q);
      if (q.prefix !== undefined && q.prefix !== "") checkKvKey(q.prefix);
      const sign = order === "asc" ? 1 : -1;
      const past = (e: KvEntryRow) =>
        cur === undefined ||
        sign * (cmpBin(e.ownerId, cur.ownerId) || cmpBin(e.key, cur.key)) > 0;
      const all = entriesOf(q.collectionId)
        .filter(
          (e) =>
            isLiveAt(e, q.now) &&
            (q.ownerId === undefined || bin(e.ownerId) === bin(q.ownerId)) &&
            (!q.prefix || e.key.startsWith(q.prefix)) &&
            past(e),
        )
        .sort(
          (a, b) =>
            sign * (cmpBin(a.ownerId, b.ownerId) || cmpBin(a.key, b.key)),
        );
      const page = all
        .slice(0, limit)
        .map((e) => view(e, q.withValue === true));
      const last = page[page.length - 1];
      return all.length > limit && last
        ? { rows: page, nextCursor: encodeKvCursor(last) }
        : { rows: page };
    },

    findEntry: async (collectionId, ownerId, key, opts) => {
      const e = entries.get(mapKey(collectionId, ownerId, key));
      if (!e || !isLiveAt(e, opts.now)) return undefined;
      return view(e, opts.withValue === true);
    },

    putEntry: async (i) => {
      checkKvKey(i.key);
      checkKvOwner(i.ownerId);
      checkKvEntrySize(i.value, i.bytes);
      if (typeof i.ifVersion === "number") checkKvVersion(i.ifVersion);
      if (!collections.has(i.collectionId)) throw fk();
      const k = mapKey(i.collectionId, i.ownerId, i.key);
      const cur = entries.get(k);
      const live = cur !== undefined && isLiveAt(cur, i.at);
      if (i.ifVersion === "absent") {
        if (live) return { ok: false, current: toMeta(cur) };
      } else if (typeof i.ifVersion === "number") {
        if (!live || cur.version !== i.ifVersion)
          return { ok: false, current: live ? toMeta(cur) : undefined };
      }
      const version = cur === undefined ? 1 : cur.version + 1;
      entries.set(k, {
        collectionId: i.collectionId,
        ownerId: i.ownerId,
        key: i.key,
        value: i.value,
        bytes: i.bytes,
        version,
        channelId: i.channelId,
        // Only a live row has an expiry worth keeping (see the Prisma twin).
        expiresAt:
          i.expiresAt === "keep"
            ? live
              ? (cur?.expiresAt ?? null)
              : null
            : i.expiresAt,
        createdAt: cur?.createdAt ?? i.at,
        updatedAt: i.at,
      });
      return { ok: true, version, created: !live };
    },

    deleteEntry: async (collectionId, ownerId, key, opts) => {
      if (opts.ifVersion !== undefined) checkKvVersion(opts.ifVersion);
      const k = mapKey(collectionId, ownerId, key);
      const cur = entries.get(k);
      if (!cur || !isLiveAt(cur, opts.now)) return "missing";
      if (opts.ifVersion !== undefined && cur.version !== opts.ifVersion)
        return "conflict";
      entries.delete(k);
      return "deleted";
    },

    deleteEntriesBatch: async (collectionId, limit) => {
      const n = checkBatchLimit(limit);
      let gone = 0;
      for (const e of entriesOf(collectionId)) {
        if (gone >= n) break;
        drop(e);
        gone++;
      }
      return gone;
    },

    deleteOwnerEntries: async (collectionId, ownerId, limit) => {
      const n = checkBatchLimit(limit);
      let gone = 0;
      for (const e of entriesOf(collectionId)) {
        if (gone >= n) break;
        if (bin(e.ownerId) !== bin(ownerId)) continue;
        drop(e);
        gone++;
      }
      return gone;
    },

    deleteExpiredEntries: async (collectionId, now, limit) => {
      const n = checkBatchLimit(limit);
      let gone = 0;
      for (const e of entriesOf(collectionId)) {
        if (gone >= n) break;
        if (e.expiresAt === null || e.expiresAt > now) continue;
        drop(e);
        gone++;
      }
      return gone;
    },

    deleteChannelEntries: async (channelId, limit) => {
      const n = checkBatchLimit(limit);
      let gone = 0;
      for (const e of [...entries.values()]) {
        if (gone >= n) break;
        if (e.channelId !== channelId || e.ownerId === KV_SHARED_OWNER)
          continue;
        drop(e);
        gone++;
      }
      return gone;
    },

    findKey: async (collectionId) => {
      const k = keys.get(collectionId);
      return k && { ...k };
    },

    insertKey: async (collectionId, dekWrapped, at) => {
      if (!collections.has(collectionId)) throw fk();
      if (keys.has(collectionId)) return "exists";
      keys.set(collectionId, { collectionId, dekWrapped, createdAt: at });
      return "inserted";
    },
  };
}
