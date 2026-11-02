import { useState } from "react";
import { useMutationState, useQueryClient } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import { runnersQuery } from "../../../../app/queries";
import { buildRecordScope, keepSavedRecord } from "../../../../app/saved-record-field";

const ALLOW_MUTATION_KEY = ["fleet", "allow-sessions"] as const;

/** One press of Allow: the machine, and the session cap it asks for. */
interface Allowance {
  readonly runnerId: string;
  readonly cap: number;
}

/** What `useAllowSessions` returns. */
export interface AllowSessions {
  /** Sets the session cap of the machine `runnerId` to `cap` (`runner.update`). */
  readonly allow: (runnerId: string, cap: number) => void;
  /** The machines whose Allow is saving, so each one's button shows it. */
  readonly pendingRunnerIds: ReadonlySet<string>;
  /**
   * The text that says the latest Allow failed, such as "Could not allow 17
   * sessions on atlas: The runner is being retired.", or `null` after a new
   * Allow starts. It is also `null` when the machine is no longer in the
   * fleet, because there is no name left to say it with.
   */
  readonly failureMessage: string | null;
}

/** An Allow that failed: what it asked for, the controller's message, and the name its machine had when it failed. */
interface FailedAllow extends Allowance {
  readonly message: string;
  readonly runnerName: string | null;
}

/**
 * Returns the Allow button's save for every machine of the Fleet page: it sets
 * a machine's session cap, so every waiting session can start.
 *
 * - Machines save independently, so pressing Allow on one does not wait for
 *   another.
 * - An Allow shares the mutation scope of the machine's other saves (the
 *   settings rows and Stop new work), so an Allow followed by an edit of the
 *   same machine's cap reaches the controller in that order. The mutation
 *   cache holds the scope, not this hook, so the order holds also when the
 *   user leaves the page while the Allow is saving.
 * - A successful save puts the runner the controller returns in the cached
 *   list, so the card shows the new cap at once, and then reads the list
 *   again.
 * - A failed save leaves the cap as it was and is kept in `failureMessage`. The
 *   mutation cache forgets a failed mutation that nothing observes, so the
 *   hook keeps it. The next Allow clears it.
 */
export function useAllowSessions(client: HerculeClient): AllowSessions {
  const queryClient = useQueryClient();
  const [failed, setFailed] = useState<FailedAllow | null>(null);
  const pendingRunnerIds = useMutationState({
    filters: { mutationKey: ALLOW_MUTATION_KEY, status: "pending" },
    select: (mutation) => (mutation.state.variables as Allowance).runnerId,
  });
  const { queryKey } = runnersQuery(client);
  return {
    allow: (runnerId, cap) => {
      setFailed(null);
      // A mutation scope is fixed when the mutation is built, and each machine
      // needs its own, so `useMutation` (one scope per hook) does not fit. The
      // mutation is built in the cache directly. Nothing observes it, so the
      // cache drops it when it ends, as it does any other.
      queryClient
        .getMutationCache()
        .build(queryClient, {
          mutationKey: ALLOW_MUTATION_KEY,
          scope: buildRecordScope(runnerId),
          mutationFn: ({ runnerId, cap }: Allowance) =>
            client.runner.update({
              params: { id: runnerId },
              payload: { maxConcurrentSessions: cap },
            }),
          onSuccess: (saved) => keepSavedRecord(queryClient, queryKey, saved),
          onError: (error, allowance) => {
            const runnerName =
              queryClient.getQueryData(queryKey)?.find((each) => each.id === allowance.runnerId)
                ?.name ?? null;
            setFailed({ ...allowance, message: readErrorMessage(error), runnerName });
          },
        })
        .execute({ runnerId, cap })
        // `onError` has recorded the failure.
        .catch(() => {});
    },
    pendingRunnerIds: new Set(pendingRunnerIds),
    failureMessage:
      failed === null || failed.runnerName === null
        ? null
        : `Could not allow ${String(failed.cap)} sessions on ${failed.runnerName}: ${failed.message}`,
  };
}
