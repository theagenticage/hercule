/**
 * A write whose guard and refusal belong to its target, not to the component
 * that started it.
 *
 * A control that closes (a menu, a dialog) unmounts its mutation observer
 * while the request is still running. If the guard were that observer's
 * `isPending`, reopening the control would show no write in flight, and a
 * second write would be built from the same list as the first. So the guard
 * is the mutation key: every write of one target has the same key, and the
 * query client knows whether one with that key is running, whoever started it.
 * The refusal is kept the same way, in the mutation cache under that key.
 */
import { useSyncExternalStore } from "react";
import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
  type MutationKey,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { ApiError } from "@hercule/client-core";

/** The message of the refusal a write has when it succeeded but the list could not be read again. */
const REREAD_FAILED = new Error("Saved, but the list could not be read again.");

/** What a successful write holds as its result. */
interface WriteResult {
  /** True when the write succeeded and a read of one of its `reads` queries then failed. */
  readonly rereadFailed: boolean;
}

/** What `useKeyedWrite` returns. */
export interface KeyedWrite<Variables> {
  /** Starts a write, unless `writing` is true: then it does nothing. */
  readonly write: (variables: Variables) => void;
  /**
   * Whether a write with this key is running, whoever started it, or the
   * newest write succeeded and its reads have not succeeded since. Controls
   * disable themselves meanwhile, because the cached list may lack the change.
   */
  readonly writing: boolean;
  /**
   * The error of the newest write with this key, or `null` when it succeeded,
   * is running, or none was made. It outlives the component that started the
   * write, so a control that is closed and opened again still shows it. After
   * a write that succeeded but whose reads failed, it says so and stays until a
   * read succeeds; `clearRefusal` does not remove it.
   */
  readonly refusal: unknown;
  /** Forgets the refusal. */
  readonly clearRefusal: () => void;
}

/** Returns true when the controller refused the write as invalid, which can mean a record the screen holds is out of date. */
export const isValidationRefusal = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "validation";

/** Returns true when one of the queries under `reads` is in the error state. A failed refetch leaves the old data in place. */
const hasFailedRead = (queryClient: QueryClient, reads: readonly QueryKey[]): boolean =>
  reads.some((queryKey) =>
    queryClient
      .getQueryCache()
      .findAll({ queryKey, exact: true })
      .some((query) => query.state.status === "error"),
  );

/** Returns true when the newest write of `mutationKey` succeeded and the reads that followed it failed, and none has succeeded since. */
const isUnread = (
  queryClient: QueryClient,
  mutationKey: MutationKey,
  reads: readonly QueryKey[],
): boolean => {
  const newest = queryClient.getMutationCache().findAll({ mutationKey }).at(-1);
  return (
    newest?.state.status === "success" &&
    (newest.state.data as WriteResult).rereadFailed &&
    hasFailedRead(queryClient, reads)
  );
};

/**
 * Returns a write keyed by `mutationKey`. `mutationFn` runs the write and
 * `onSettled` runs after it, success or refusal; the mutation stays pending
 * until the promise `onSettled` returns has settled, so a control that
 * disables itself while `writing` never shows the old data between the
 * write and its refresh.
 *
 * `reads` are the queries `onSettled` reads again. Reading again does not
 * fail the promise when the read fails: the query keeps the old list in the
 * error state. If the write succeeded and one of them is in that state, the
 * cached list may lack the change, and a next write built from it would undo
 * the change. So `writing` stays true and `refusal` says what happened, until
 * a read of them succeeds.
 *
 * Both functions are stored with the write itself, so they run to the end
 * even when the component that started it has unmounted.
 */
export const useKeyedWrite = <Variables>({
  mutationKey,
  mutationFn,
  onSettled,
  reads = [],
}: {
  readonly mutationKey: MutationKey;
  readonly mutationFn: (variables: Variables) => Promise<unknown>;
  readonly onSettled: (error: unknown) => Promise<unknown>;
  readonly reads?: readonly QueryKey[];
}): KeyedWrite<Variables> => {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationKey,
    mutationFn: async (variables: Variables): Promise<WriteResult> => {
      let failed = false;
      let failure: unknown = null;
      try {
        await mutationFn(variables);
      } catch (error) {
        failed = true;
        failure = error;
      }
      await onSettled(failure);
      if (failed) throw failure;
      return { rereadFailed: hasFailedRead(queryClient, reads) };
    },
  });
  const running = useIsMutating({ mutationKey }) > 0;
  const newest = useMutationState({ filters: { mutationKey }, select: (each) => each.state }).at(
    -1,
  );
  // Subscribed to the query cache, so the control is enabled again as soon as a read succeeds.
  const unread = useSyncExternalStore(
    (notify) => queryClient.getQueryCache().subscribe(notify),
    () => isUnread(queryClient, mutationKey, reads),
  );

  return {
    write: (variables) => {
      // Read from the cache at the moment of the click, not from the last render:
      // two clicks in the same tick see the same render.
      if (queryClient.isMutating({ mutationKey }) > 0) return;
      if (isUnread(queryClient, mutationKey, reads)) return;
      mutation.mutate(variables);
    },
    writing: running || unread,
    refusal: newest?.status === "error" ? newest.error : unread ? REREAD_FAILED : null,
    clearRefusal: () => {
      const cache = queryClient.getMutationCache();
      for (const each of cache.findAll({ mutationKey, status: "error" })) cache.remove(each);
    },
  };
};
