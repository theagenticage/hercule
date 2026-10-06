import { useMutation } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";

/** What `useStopAgent` returns: the stop itself, whether one is in flight, and the last failure. */
export interface StopAgent {
  /**
   * Sends `session.interrupt`. Without `subagentId` it stops everything the
   * session runs: its own agent's turn and every running subagent. With
   * `subagentId` it stops that subagent and every subagent below it. Does
   * nothing while a stop is already in flight, or when there is no session.
   */
  readonly stop: (subagentId?: string) => void;
  readonly isPending: boolean;
  readonly error: Error | null;
}

/**
 * Returns the one way the web app stops an agent of the session `sessionId`.
 * `sessionId` is null in a draft's composer, which has nothing to stop yet.
 *
 * The response is not written into the cache. It is the session as the
 * controller read it before the interrupt, still busy, so writing it could
 * bring back a Stop the live `session` push has already cleared.
 */
export const useStopAgent = (client: HerculeClient, sessionId: string | null): StopAgent => {
  const interrupt = useMutation({
    mutationFn: ({ id, subagentId }: { readonly id: string; readonly subagentId?: string }) =>
      client.session.interrupt({
        params: { id },
        payload: subagentId === undefined ? {} : { subagentId },
      }),
  });
  return {
    stop: (subagentId) => {
      if (sessionId === null || interrupt.isPending) return;
      interrupt.mutate(
        subagentId === undefined ? { id: sessionId } : { id: sessionId, subagentId },
      );
    },
    isPending: interrupt.isPending,
    error: interrupt.error,
  };
};
