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
import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
  type MutationKey,
} from "@tanstack/react-query";
import { ApiError } from "@hercule/client-core";

/** What `useKeyedWrite` returns. */
export interface KeyedWrite<Variables> {
  /** Starts a write, unless one with the same key is already running: then it does nothing. */
  readonly write: (variables: Variables) => void;
  /** Whether a write with this key is running, whoever started it. */
  readonly writing: boolean;
  /**
   * The error of the newest write with this key, or `null` when it succeeded,
   * is running, or none was made. It outlives the component that started the
   * write, so a control that is closed and opened again still shows it.
   */
  readonly refusal: unknown;
  /** Forgets the refusal. */
  readonly clearRefusal: () => void;
}

/** Returns true when the controller refused the write as invalid, which can mean a record the screen holds is out of date. */
export const isValidationRefusal = (error: unknown): boolean =>
  error instanceof ApiError && error.code === "validation";

/**
 * Returns a write keyed by `mutationKey`. `mutationFn` runs the write and
 * `onSettled` runs after it, success or refusal; the mutation stays pending
 * until the promise `onSettled` returns has settled, so a control that
 * disables itself while `writing` never shows the old data between the
 * write and its refresh.
 *
 * Both functions are stored with the write itself, so they run to the end
 * even when the component that started it has unmounted.
 */
export const useKeyedWrite = <Variables>({
  mutationKey,
  mutationFn,
  onSettled,
}: {
  readonly mutationKey: MutationKey;
  readonly mutationFn: (variables: Variables) => Promise<unknown>;
  readonly onSettled: (error: unknown) => Promise<unknown>;
}): KeyedWrite<Variables> => {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationKey,
    mutationFn,
    onSettled: (_result, error) => onSettled(error),
  });
  const writing = useIsMutating({ mutationKey }) > 0;
  const newest = useMutationState({ filters: { mutationKey }, select: (each) => each.state }).at(
    -1,
  );

  return {
    write: (variables) => {
      // Read from the cache at the moment of the click, not from the last render:
      // two clicks in the same tick see the same render.
      if (queryClient.isMutating({ mutationKey }) > 0) return;
      mutation.mutate(variables);
    },
    writing,
    refusal: newest?.status === "error" ? newest.error : null,
    clearRefusal: () => {
      const cache = queryClient.getMutationCache();
      for (const each of cache.findAll({ mutationKey, status: "error" })) cache.remove(each);
    },
  };
};
