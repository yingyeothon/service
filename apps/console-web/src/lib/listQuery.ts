import { useDebouncedValue } from "@mantine/hooks";
import { useMemo, useState } from "react";
import type { ListParams, SortOrder } from "../types";

export interface SortState {
  key: string;
  order: SortOrder;
}

/**
 * The page-side half of a sortable, searchable list: the chosen column and
 * the search text, folded into the `ListParams` a list call sends. `params`
 * carries no `undefined` keys, so it doubles as a query-key member and as
 * the exact argument a test can assert. The text is debounced because every
 * change is a request; clearing it is immediate. `scope` (a team, project or
 * site id) resets both when it changes, so a section that stays mounted
 * across a route change never carries one scope's order into another.
 */
export function useListQuery(
  opts: { debounceMs?: number; scope?: string } = {},
) {
  const [sort, setSort] = useState<SortState | null>(null);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState(opts.scope);
  if (opts.scope !== scope) {
    // React's sanctioned "reset state on a prop change" during render.
    setScope(opts.scope);
    setSort(null);
    setQ("");
  }
  const [debounced] = useDebouncedValue(q.trim(), opts.debounceMs ?? 300);
  const effective = q.trim() === "" ? "" : debounced;
  const params = useMemo<ListParams>(() => {
    const p: ListParams = {};
    if (sort) {
      p.sort = sort.key;
      p.order = sort.order;
    }
    if (effective) p.q = effective;
    return p;
  }, [sort, effective]);
  return { sort, setSort, q, setQ, params, filtering: !!params.q };
}

/** The empty state a list shows while a search matches nothing. */
export const noMatch = (q: string) => ({
  title: `No rows match \u201c${q}\u201d.`,
  hint: "Clear the search to see everything.",
});
