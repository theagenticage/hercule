import type { MutationKey, QueryClient } from "@tanstack/query-core";

/**
 * Returns true while a mutation under `mutationKey` is running.
 *
 * A form that stays enabled while its mutation runs calls this to ignore a
 * second submit. The mutation cache knows at once that a mutation started,
 * while `isPending` from `useMutation` knows only after the next render, and
 * two quick presses of Enter can both arrive before it.
 */
export const isMutationRunning = (queryClient: QueryClient, mutationKey: MutationKey): boolean =>
  queryClient.isMutating({ mutationKey }) > 0;
