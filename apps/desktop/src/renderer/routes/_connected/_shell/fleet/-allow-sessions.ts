import { useState } from "react";
import { useMutation, useMutationState } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import { useKeepSavedRunner } from "./-saved-runner-field";

const ALLOW_MUTATION_KEY = ["fleet", "allow-sessions"] as const;

/** One press of Allow: the machine, and the session cap it asks for. */
interface Allowance {
  readonly runnerId: string;
  readonly cap: number;
}

/** An Allow that failed: what it asked for, and the controller's message. */
export interface AllowFailure extends Allowance {
  readonly message: string;
}

/** What `useAllowSessions` returns. */
export interface AllowSessions {
  /** Sets the session cap of the machine `runnerId` to `cap` (`runner.update`). */
  readonly allow: (runnerId: string, cap: number) => void;
  /** The machines whose Allow is saving, so each one's button shows it. */
  readonly pendingRunnerIds: ReadonlySet<string>;
  /** The latest Allow that failed, or `null` after a new Allow starts. */
  readonly failure: AllowFailure | null;
}

/**
 * Returns the Allow button's save for every machine of the Fleet page: it sets
 * a machine's session cap, so every waiting session can start.
 *
 * - Machines save independently, so pressing Allow on one does not wait for
 *   another.
 * - A successful save puts the runner the controller returns in the cached
 *   list, so the card shows the new cap at once, and then reads the list
 *   again.
 * - A failed save leaves the cap as it was and is kept in `failure`. The
 *   mutation cache forgets a failed mutation that nothing observes, so the
 *   hook keeps it. The next Allow clears it.
 */
export function useAllowSessions(client: HerculeClient): AllowSessions {
  const keepSavedRunner = useKeepSavedRunner(client);
  const [failure, setFailure] = useState<AllowFailure | null>(null);
  const pendingRunnerIds = useMutationState({
    filters: { mutationKey: ALLOW_MUTATION_KEY, status: "pending" },
    select: (mutation) => (mutation.state.variables as Allowance).runnerId,
  });
  const mutation = useMutation({
    mutationKey: ALLOW_MUTATION_KEY,
    mutationFn: ({ runnerId, cap }: Allowance) =>
      client.runner.update({ params: { id: runnerId }, payload: { maxConcurrentSessions: cap } }),
    onError: (error, allowance) => {
      setFailure({ ...allowance, message: readErrorMessage(error) });
    },
    onSuccess: keepSavedRunner,
  });
  return {
    allow: (runnerId, cap) => {
      setFailure(null);
      mutation.mutate({ runnerId, cap });
    },
    pendingRunnerIds: new Set(pendingRunnerIds),
    failure,
  };
}
