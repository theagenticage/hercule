/**
 * What a list edit and a server switch do after a write, so both keep one
 * order and one proof (private to this folder).
 *
 * After a write the cache holds the list as it was before it. The edit base,
 * the query an edit is built from, is read again, and an edit of the same
 * target waits until that read succeeded. Three rules make the wait safe:
 *
 * - A read of the base that was in flight when the write ended is cancelled
 *   first, so it cannot put the old list back.
 * - The watch for a successful read starts before the read does. A read that
 *   somebody else makes while ours fails still counts.
 * - Only a fetch counts. `setQueryData` also marks a query as a success, but
 *   it proves nothing about what the controller holds.
 */
import { matchQuery, type QueryClient, type QueryKey } from "@tanstack/query-core";

/** A query the module reads: its key, and a read of it that never answers from the cache. */
export interface McpListQuery {
  readonly queryKey: QueryKey;
  /** Reads the query from the controller and puts the answer in the cache, even when the cache holds a fresh one. */
  readonly fetch: () => Promise<unknown>;
}

/** Watches one query for a fetch that succeeded after the watch started. */
export interface BaseReadWatch {
  /** Returns true once a fetch of the query succeeded. */
  readonly hasSucceeded: () => boolean;
  /** Calls `listener` once, when a fetch succeeded, or at once when one did. */
  readonly whenSucceeded: (listener: () => void) => void;
  /** Stops watching. Call it when nobody needs the answer any more. */
  readonly stop: () => void;
}

/** Starts watching `queryKey` in the cache of `queryClient`. Ignores data that was put in by hand. */
const watchBaseReads = (queryClient: QueryClient, queryKey: QueryKey): BaseReadWatch => {
  let succeeded = false;
  const listeners = new Set<() => void>();
  const stopCache = queryClient.getQueryCache().subscribe((event) => {
    if (
      succeeded ||
      event.type !== "updated" ||
      event.action.type !== "success" ||
      event.action.manual === true ||
      !matchQuery({ queryKey, exact: true }, event.query)
    ) {
      return;
    }
    succeeded = true;
    stopCache();
    const waiting = [...listeners];
    listeners.clear();
    for (const listener of waiting) listener();
  });
  return {
    hasSucceeded: () => succeeded,
    whenSucceeded: (listener) => {
      if (succeeded) listener();
      else listeners.add(listener);
    },
    stop: () => {
      stopCache();
      listeners.clear();
    },
  };
};

/**
 * Reads `base` again after a write, and returns the watch of that read. It
 * never fails: `watch.hasSucceeded()` tells whether the read, or another
 * fetch of the base in the meantime, succeeded.
 *
 * The caller stops the watch, or hands it to the guard, which stops it when a
 * later fetch succeeds.
 */
export const readBaseAfterWrite = async (
  queryClient: QueryClient,
  base: McpListQuery,
): Promise<BaseReadWatch> => {
  await queryClient.cancelQueries({ queryKey: base.queryKey, exact: true });
  const watch = watchBaseReads(queryClient, base.queryKey);
  await base.fetch().catch(() => {});
  return watch;
};

/**
 * Reads `catalogue` again, after the write that was refused as invalid
 * because the list names a server that no longer exists. A read already in
 * flight started before the refusal and may still hold the deleted server, so
 * it is cancelled first: reading with `fetchQuery` alone would join it.
 * Never fails.
 */
export const readCatalogueAfterRefusal = async (
  queryClient: QueryClient,
  catalogue: McpListQuery,
): Promise<void> => {
  await queryClient.cancelQueries({ queryKey: catalogue.queryKey, exact: true });
  await catalogue.fetch().catch(() => {});
};

/**
 * Marks the queries `queryKeys` as out of date without reading them. They
 * show the same list as the base in another shape, and the next time somebody
 * uses one it is read again.
 */
export const markQueriesStale = (
  queryClient: QueryClient,
  queryKeys: readonly QueryKey[],
): void => {
  for (const queryKey of queryKeys) {
    void queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
  }
};
