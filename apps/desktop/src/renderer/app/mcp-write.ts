/**
 * The writes of MCP server lists and switches, which Settings, a thread's
 * `+` menu and a server's page all make. Each write has a target (a started
 * thread's list, a project's list, the default list, one server's switch)
 * and the target's mutation key is its guard: one write runs at a time for a
 * target, wherever the control that started it is, and the guard outlives
 * the control, so closing and reopening a menu or dialog never releases it.
 */
import { useEffect } from "react";
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

/** What `useMcpWrite` returns. */
export interface McpWrite<Variables> {
  /** Starts the write with `variables`. Does nothing while a write of the same target runs. */
  readonly start: (variables: Variables) => void;
  /** Whether a write of the target runs, started by any component. */
  readonly isRunning: boolean;
  /** Why the controller refused the last write of the target, or `null`. */
  readonly refusal: string | null;
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
 *   screen or the composer, never the menu or dialog opened from it.
 * - Each write ends by reading again what it changed, `refresh`, and the
 *   write counts as running until those reads answer. No response of the
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
    // A refusal must outlive the control that made the write.
    gcTime: Infinity,
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
    },
  });
  const isRunning = useIsMutating({ mutationKey }) > 0;
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
      if (isMutationRunning(queryClient, mutationKey)) return;
      mutation.mutate(variables);
    },
    isRunning,
    refusal: isRunning || error === undefined ? null : readErrorMessage(error),
    clearRefusal: () => {
      forgetSettledWrites(queryClient, mutationKey);
    },
  };
}
