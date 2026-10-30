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

/** Checks that `variables` is an object with a string `requestId`, which is what an answer send's mutation gets. */
const hasRequestId = (variables: unknown): variables is { readonly requestId: string } =>
  typeof variables === "object" &&
  variables !== null &&
  "requestId" in variables &&
  typeof variables.requestId === "string";

/**
 * Returns true while a mutation under `mutationKey` is running with variables
 * whose `requestId` is `requestId`.
 *
 * The composer calls this to ignore a second send of the answers to one
 * Request while the first is still running, without blocking the answers to
 * another Request. Like `isMutationRunning`, it reads the mutation cache, so
 * it is right before the next render.
 */
export const isAnswerSendRunning = (
  queryClient: QueryClient,
  mutationKey: MutationKey,
  requestId: string,
): boolean =>
  queryClient
    .getMutationCache()
    .findAll({ mutationKey, status: "pending" })
    .some(
      (mutation) =>
        hasRequestId(mutation.state.variables) && mutation.state.variables.requestId === requestId,
    );
