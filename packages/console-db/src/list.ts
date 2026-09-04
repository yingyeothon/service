import { AppError } from "@yyt/core";

/*
 * Server-side ordering and free-text search for the console lists
 * (docs/decisions.md *List sort and filter*). A repository applies these in
 * SQL where the column exists and in code after the fetch where the value is
 * derived; the memory fake mirrors MySQL with the comparators below.
 *
 * The comparators are the fake's model of MariaDB, not MariaDB: `cmpCi` is an
 * ICU collation, MariaDB's `utf8mb4_unicode_ci` is UCA 4.0.0, and they can
 * disagree on punctuation and expansions. Contract fixtures therefore use
 * ASCII letters and digits with distinct case and rely on the id tiebreak —
 * do not "fix" a fake with `localeCompare` when a contract diverges; find the
 * fixture that is outside the model.
 */

export type SortOrder = "asc" | "desc";

export interface ListOrder<K extends string> {
  sort?: K;
  order?: SortOrder;
}

export interface ListQuery<K extends string> extends ListOrder<K> {
  /** Raw text; `normalizeQ` trims and bounds it. */
  q?: string;
}

export const Q_MAX = 100;

/**
 * Shared by repository and fake so both refuse the same input: trimmed, an
 * empty string means "no filter", longer than `Q_MAX` is a bad request.
 */
export function normalizeQ(q: string | undefined): string | undefined {
  if (q === undefined) return undefined;
  const t = q.trim();
  if (t === "") return undefined;
  if (t.length > Q_MAX)
    throw new AppError("bad_request", `q is longer than ${Q_MAX} characters`);
  return t;
}

/**
 * Prisma's `contains` reaches MySQL as a bare `LIKE '%…%'` with no `ESCAPE`
 * clause (rules/data.md), so the three characters that are live inside a
 * pattern are escaped with MySQL's default `\`.
 */
export const escapeLike = (s: string): string =>
  s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Spread into a Prisma string filter: `{ name: likeContains(q) }`. */
export const likeContains = (q: string): { contains: string } => ({
  contains: escapeLike(q),
});

/**
 * The fake's `col LIKE '%q%'` on a `_ci` column; `q` is the raw text. Case is
 * folded like the collation; accents are not (`café` matches `cafe` in
 * MySQL, not here) — the same ASCII-fixture rule as the comparators.
 */
export const matchesQ = (v: string | null | undefined, q: string): boolean =>
  v !== null && v !== undefined && v.toLowerCase().includes(q.toLowerCase());

const collator = new Intl.Collator("en", { sensitivity: "base" });

/** PAD SPACE ignores trailing U+0020 only — not tabs or newlines. */
export const padSpace = (s: string) => s.replace(/ +$/, "");

/**
 * `utf8mb4_unicode_ci`: case- and accent-insensitive, PAD SPACE. A MEDIUMTEXT
 * column sorts on its first `max_sort_length` bytes (1 KB) in MySQL; the
 * fake compares the whole value, so fixtures keep long texts distinct early.
 */
export const cmpCi = (a: string, b: string): number =>
  collator.compare(padSpace(a), padSpace(b));

/** `utf8mb4_bin`: code points, PAD SPACE. */
export const cmpBin = (a: string, b: string): number => {
  const x = padSpace(a);
  const y = padSpace(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

export const cmpNum = (a: number, b: number): number => a - b;

/** MySQL orders `NULL` before every value. */
export const nullable =
  <T>(cmp: (a: T, b: T) => number) =>
  (a: T | null | undefined, b: T | null | undefined): number =>
    a === null || a === undefined
      ? b === null || b === undefined
        ? 0
        : -1
      : b === null || b === undefined
        ? 1
        : cmp(a, b);

/** MySQL `ENUM`: the declaration order, never the string. */
export const enumRank =
  <T extends string>(values: readonly T[]) =>
  (a: T, b: T): number =>
    values.indexOf(a) - values.indexOf(b);

export type Comparator<T> = (a: T, b: T) => number;

/**
 * Orders `rows` by `keys[sort]` in `order`, breaking ties on `tie` in the same
 * direction (what `orderBy: [{ col: o }, { id: o }]` does); without `sort` the
 * list keeps `fallback`, its historical default order.
 */
export function sortRows<T, K extends string>(
  rows: readonly T[],
  keys: Partial<Record<K, Comparator<T>>>,
  o: ListOrder<K>,
  tie: Comparator<T>,
  fallback: Comparator<T>,
): T[] {
  const key = o.sort === undefined ? undefined : keys[o.sort];
  if (key === undefined) return [...rows].sort(fallback);
  const sign = o.order === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => sign * (key(a, b) || tie(a, b)));
}

/** Prisma's `orderBy` direction for a list order. */
export const dir = (o: ListOrder<string>): SortOrder => o.order ?? "asc";

/*
 * Catalog apps and asset bundles share one shape — `name`, a nullable
 * `description`, a nullable owner (`members` relation) and `updated_at` — so
 * their sort keys, `orderBy` and fake comparators are defined once.
 */
export const RESOURCE_SORT_KEYS = [
  "name",
  "description",
  "createdBy",
  "updatedAt",
] as const;
export type ResourceSortKey = (typeof RESOURCE_SORT_KEYS)[number];

export function resourceOrderBy(o: ListOrder<ResourceSortKey>) {
  const d = dir(o);
  switch (o.sort) {
    case "name":
      return [{ name: d }, { id: d }];
    case "description":
      return [{ description: d }, { id: d }];
    case "createdBy":
      return [{ members: { github_login: d } }, { id: d }];
    case "updatedAt":
      return [{ updated_at: d }, { id: d }];
    default:
      return [{ name: "asc" as const }, { id: "asc" as const }];
  }
}

export interface ResourceLike {
  id: string;
  name: string;
  description: string | null;
  ownerId: string | null;
  updatedAt: number;
}

/** The fake's comparators for `RESOURCE_SORT_KEYS`; a missing owner is a NULL login. */
export function resourceKeys<T extends ResourceLike>(
  loginOf: (id: string) => string,
): Record<ResourceSortKey, Comparator<T>> {
  return {
    name: (a, b) => cmpCi(a.name, b.name),
    description: (a, b) => nullable(cmpCi)(a.description, b.description),
    createdBy: (a, b) =>
      nullable(cmpCi)(
        a.ownerId === null ? null : loginOf(a.ownerId),
        b.ownerId === null ? null : loginOf(b.ownerId),
      ),
    updatedAt: (a, b) => cmpNum(a.updatedAt, b.updatedAt),
  };
}
