import {
  QueryClient,
  useQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { errorMessage } from "./format";

/** One client for the whole SPA; queries refetch on demand, not on focus. */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        // Refetch on mount (old useAsync semantics): mutations on other pages
        // never leave a list stale, while cached data still paints instantly.
        staleTime: 0,
      },
    },
  });
}

export interface AsyncState<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** Replace the cached value without a round-trip. */
  set: (v: T) => void;
}

/**
 * TanStack Query wrapper keeping the previous `useAsync` surface: the key both
 * caches and decides when to refetch, `set` writes through to the cache so a
 * mutation response replaces the query data.
 */
export function useApiQuery<T>(
  key: QueryKey,
  fn: () => Promise<T>,
  opts: { enabled?: boolean } = {},
): AsyncState<T> {
  const client = useQueryClient();
  const q = useQuery({
    queryKey: key,
    queryFn: fn,
    enabled: opts.enabled,
  });
  const reload = useCallback(async () => {
    await q.refetch();
  }, [q.refetch]);
  const set = useCallback(
    (v: T) => client.setQueryData(key, v),
    // key is data, not identity: serialize for the dep list.
    [client, JSON.stringify(key)],
  );
  return {
    data: q.data,
    error: q.error ? errorMessage(q.error) : null,
    loading: q.isPending,
    reload,
    set,
  };
}

/** Wraps a mutation: tracks busy + error, clears error on success. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError(null);
      try {
        return await fn();
      } catch (e) {
        setError(errorMessage(e));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [],
  );
  return { busy, error, run, clear: () => setError(null) };
}
