import type { QueryKey } from "@tanstack/react-query";
import { useState } from "react";
import { useAction, useApiQuery } from "./query";

/**
 * A cursor-paged table with a "Load more" button (`rules/workflow.md`, the
 * pattern of `useEntries` in `pages/KvCollection.tsx`): the first page is a
 * query under `key`, the appended pages are local state tagged with the first
 * page's object identity, so a key change or a reload drops them by
 * construction rather than by an effect that has to remember to.
 */
export function useCursorList<P extends { next: string | null }, T>(
  key: QueryKey,
  fetchPage: (cursor?: string) => Promise<P>,
  rowsOf: (page: P) => T[],
  opts: { enabled?: boolean; keepPrevious?: boolean } = {},
) {
  const first = useApiQuery(key, () => fetchPage(), opts);
  const [extra, setExtra] = useState<{
    of: unknown;
    rows: T[];
    next: string | null;
  } | null>(null);
  const more = useAction();
  const live = extra && extra.of === first.data ? extra : null;
  const rows = first.data
    ? live
      ? [...rowsOf(first.data), ...live.rows]
      : rowsOf(first.data)
    : undefined;
  const next = live ? live.next : (first.data?.next ?? null);
  const loadMore = async () => {
    // While page one refetches under a new key, `next` is still the old
    // listing's cursor: a click now would mix the two.
    if (!next || !first.data || first.fetching) return;
    const of = first.data;
    const kept = live?.rows ?? [];
    const page = await more.run(() => fetchPage(next));
    if (!page) return;
    setExtra({ of, rows: [...kept, ...rowsOf(page)], next: page.next });
  };
  // TanStack keeps the same `data` object when a refetch returns equal
  // content (structural sharing), so a reload drops the pages by hand too.
  const reload = async () => {
    setExtra(null);
    more.clear();
    await first.reload();
  };
  return {
    /** The first page as it came (counts beside the rows, like `pending`). */
    first: first.data,
    rows,
    next,
    loading: first.loading,
    fetching: first.fetching,
    error: first.error ?? more.error,
    busy: more.busy,
    loadMore,
    reload,
  };
}
