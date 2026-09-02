import { Q_MAX, type SortOrder } from "@yyt/console-db";
import { z } from "zod";

/*
 * The query half of docs/decisions.md *List sort and filter*: every list
 * route validates `sort` against its own key vocabulary (the response field
 * names), `order`, and — where the list offers it — `q`, then hands the
 * repository exactly that. Nothing here orders or filters rows.
 */

export const ORDERS = ["asc", "desc"] as const;

/**
 * The free-text field. Trimmed and bounded here; an empty `q` is dropped by
 * `listParams` rather than refused, so a cleared search box or a bookmarked
 * `?q=` still answers.
 */
export const q = z.string().trim().max(Q_MAX).optional();

/**
 * The base query schema of a list route; extend it with the route's other
 * fields and keep `.passthrough()` (unknown params are tolerated everywhere).
 */
export function listQuery<const K extends readonly [string, ...string[]]>(
  sortKeys: K,
) {
  return z.object({
    sort: z.enum(sortKeys).optional(),
    order: z.enum(ORDERS).optional(),
  });
}

/** `listQuery` plus `q`, for the lists that search by name or title. */
export function searchQuery<const K extends readonly [string, ...string[]]>(
  sortKeys: K,
) {
  return listQuery(sortKeys).extend({ q });
}

export interface ListParams<K extends string> {
  sort?: K;
  order?: SortOrder;
  q?: string;
}

/** `{ sort, order, q }` from a parsed query, without `undefined` keys or an empty `q`. */
export function listParams<K extends string>(query: {
  sort?: K;
  order?: SortOrder;
  q?: string;
}): ListParams<K> {
  const out: ListParams<K> = {};
  if (query.sort !== undefined) out.sort = query.sort;
  if (query.order !== undefined) out.order = query.order;
  if (query.q) out.q = query.q;
  return out;
}
