/**
 * The writes of MCP server lists and switches, which Settings, a thread's
 * `+` menu and a server's page all make. Each write has a target (a started
 * thread's list, a project's list, the default list, one server's switch)
 * and the target's mutation key is its guard: one write runs at a time for a
 * target, wherever the control that started it is, and the guard outlives
 * the control, so closing and reopening a menu or dialog never releases it.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
  type MutationKey,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { ApiError, isMutationRunning, readErrorMessage } from "@hercule/client-core";
import { mcpServersQuery } from "./queries";

/**
 * The mutation keys of the targets of an MCP write. A target has one key
 * wherever it is written from, so a project box and the default list's picker
 * guard the same default list.
 */
export const mcpWriteKeys = {
  /** The list of MCP servers of the started thread `sessionId`. */
  threadList: (sessionId: string): MutationKey => ["mcp-write", "thread-list", sessionId],
  /** The list of MCP servers of the project `projectId`. */
  projectList: (projectId: string): MutationKey => ["mcp-write", "project-list", projectId],
  /** The setting `thread.mcpServerIds`, the list of threads without a project. */
  defaultList: (): MutationKey => ["mcp-write", "default-list"],
  /** The switch of the MCP server `serverId`. */
  serverSwitch: (serverId: string): MutationKey => ["mcp-write", "server-switch", serverId],
  /** The switch of a Connection's server that has no record yet, which creates it. */
  serverCreation: (contributionId: string, connectionId: string): MutationKey => [
    "mcp-write",
    "server-creation",
    contributionId,
    connectionId,
  ],
} as const;

/** What a target says when its write ended but the read that follows it failed. */
const LIST_UNREAD_MESSAGE = "Saved, but the list could not be read again.";

/** How long a write nobody shows any more stays in the mutation cache after it ends. */
const DETACHED_WRITE_LIFETIME_MS = 5 * 60 * 1000;

/**
 * The targets whose last write ended while a read of what it changed failed,
 * by query client and target key. The cache then still holds the list as it
 * was before the write, and a next write built on it would undo this one.
 */
const unreadTargets = new WeakMap<QueryClient, Set<string>>();

/** Returns true when a read of one of the `refresh` queries has failed last. */
const hasFailedRead = (queryClient: QueryClient, refresh: readonly QueryKey[]): boolean =>
  refresh.some((queryKey) => queryClient.getQueryState(queryKey)?.status === "error");

/**
 * Returns true while the last write of the target ended with a failed read of
 * what it changed. The mark is dropped as soon as no `refresh` read is in
 * error, so the next successful read of them releases the target.
 */
const isTargetUnread = (
  queryClient: QueryClient,
  mutationKey: MutationKey,
  refresh: readonly QueryKey[],
): boolean => {
  const marks = unreadTargets.get(queryClient);
  const mark = JSON.stringify(mutationKey);
  if (marks?.has(mark) !== true) return false;
  if (hasFailedRead(queryClient, refresh)) return true;
  marks.delete(mark);
  return false;
};

/** Returns true while a write of the target runs, or its last write left the list unread. */
export const isMcpWriteBlocked = (
  queryClient: QueryClient,
  mutationKey: MutationKey,
  refresh: readonly QueryKey[],
): boolean =>
  isMutationRunning(queryClient, mutationKey) || isTargetUnread(queryClient, mutationKey, refresh);

/** What `useMcpWrite` returns. */
export interface McpWrite<Variables> {
  /** Starts the write with `variables`. Does nothing while the target `isBlocked`. */
  readonly start: (variables: Variables) => void;
  /**
   * Whether the target takes no new write: one runs, started by any
   * component, or the last one ended and the read of what it changed failed.
   */
  readonly isBlocked: boolean;
  /**
   * Returns what to show for the target, or `null`: why the controller
   * refused the last write, with `prefix` before it, or that the write was
   * saved but could not be read again. Nothing shows while a write runs.
   */
  readonly problem: (prefix?: string) => string | null;
  /** Forgets the last refusal. */
  readonly clearRefusal: () => void;
}

/** Returns true when the controller refused the write with `validation`, whatever it lists. */
const isValidationRefusal = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "validation";

/** Removes the settled writes under `mutationKey` from the mutation cache, and with them their refusal. */
const forgetSettledWrites = (queryClient: QueryClient, mutationKey: MutationKey): void => {
  const cache = queryClient.getMutationCache();
  for (const write of cache.findAll({ mutationKey, exact: true })) {
    if (write.state.status !== "pending") cache.remove(write);
  }
};

/**
 * Returns the write of one target, guarded and refused by its `mutationKey`.
 *
 * - `start` does nothing while a write under the key runs. The guard is the
 *   mutation cache's, not this component's, so it holds while the control is
 *   closed and opened again.
 * - The refusal of the last write stays in the mutation cache, so it shows
 *   wherever the target is shown, until `clearRefusal`, the next `start`, or
 *   the unmount of the component that called this hook. That component is the
 *   screen or the composer, never the menu or dialog opened from it. Opening
 *   a menu or dialog never clears it; closing one may, through `clearRefusal`.
 * - Each write ends by reading again what it changed, `refresh`, and the
 *   target stays blocked until those reads answer. When one of them fails,
 *   the target stays blocked after that, with the refusal "Saved, but the
 *   list could not be read again.", until a read of `refresh` succeeds: the
 *   cache still holds the old list, and a write built on it would undo this
 *   one. No response of the
 *   write is put in the cache: only reads fill it, so a late response can
 *   never put back what a newer read removed. When the controller refuses
 *   with `validation`, which a server deleted since the list was read
 *   causes, the list of servers is read again too.
 *
 * `mutationFn` runs when the write starts, so it applies a choice to the
 * target's list as the cache holds it then.
 */
export function useMcpWrite<Variables>({
  mutationKey,
  mutationFn,
  refresh,
}: {
  readonly mutationKey: MutationKey;
  readonly mutationFn: (variables: Variables) => Promise<unknown>;
  readonly refresh: readonly QueryKey[];
}): McpWrite<Variables> {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationKey,
    // The component that called this hook observes the write, which keeps it and its refusal
    // while that component is mounted. Once it is gone, the record of a write that ended is
    // removed after this time, and a write that still runs is kept until it ends.
    gcTime: DETACHED_WRITE_LIFETIME_MS,
    mutationFn,
    onMutate: () => {
      forgetSettledWrites(queryClient, mutationKey);
    },
    onSettled: async (_result, error) => {
      const keys = isValidationRefusal(error)
        ? [...refresh, mcpServersQuery(client).queryKey]
        : refresh;
      await Promise.all(
        keys.map((queryKey) => queryClient.invalidateQueries({ queryKey, exact: true })),
      );
      // A failed read does not reject the invalidation, so it is looked for in the queries.
      if (hasFailedRead(queryClient, keys)) {
        const marks = unreadTargets.get(queryClient) ?? new Set<string>();
        marks.add(JSON.stringify(mutationKey));
        unreadTargets.set(queryClient, marks);
      }
    },
  });
  const isRunning = useIsMutating({ mutationKey }) > 0;
  const subscribe = useCallback(
    (notify: () => void) => {
      const stopQueries = queryClient.getQueryCache().subscribe(notify);
      const stopMutations = queryClient.getMutationCache().subscribe(notify);
      return () => {
        stopQueries();
        stopMutations();
      };
    },
    [queryClient],
  );
  const isUnread = useSyncExternalStore(subscribe, () =>
    isTargetUnread(queryClient, mutationKey, refresh),
  );
  const keyText = JSON.stringify(mutationKey);
  useEffect(
    () => () => {
      forgetSettledWrites(queryClient, JSON.parse(keyText) as MutationKey);
    },
    [queryClient, keyText],
  );
  const errors = useMutationState({
    filters: { mutationKey, status: "error" },
    select: (write) => write.state.error,
  });
  const error = errors.at(-1);
  return {
    start: (variables) => {
      if (isMcpWriteBlocked(queryClient, mutationKey, refresh)) return;
      mutation.mutate(variables);
    },
    isBlocked: isRunning || isUnread,
    problem: (prefix = "") => {
      if (isRunning) return null;
      if (error !== undefined) return `${prefix}${readErrorMessage(error)}`;
      return isUnread ? LIST_UNREAD_MESSAGE : null;
    },
    clearRefusal: () => {
      forgetSettledWrites(queryClient, mutationKey);
    },
  };
}
