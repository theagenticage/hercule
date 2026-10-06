/**
 * The one stop the desktop app sends for a session's agents, shared by every
 * control that offers it: the composer's Stop, a subagent's Stop and Stop
 * all. Sharing one hook keeps the request, the guard against a second stop
 * and the failure the user sees the same in every one of them.
 */
import { useMutation } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";

/** What `useStopAgent` returns: the stop itself, whether one is in flight, and the last failure. */
export interface StopAgent {
  /**
   * Sends `session.interrupt`. Without `subagentId` it stops everything the
   * session runs: its own agent's turn and every running subagent. With
   * `subagentId` it stops that subagent and every subagent below it, and the
   * controller cancels the Requests they asked. Does nothing while a stop is
   * already in flight.
   */
  readonly stop: (subagentId?: string) => void;
  readonly isPending: boolean;
  readonly error: Error | null;
  /** Clears the last failure, such as when the user sends a new message. */
  readonly reset: () => void;
}

/**
 * Returns the one way the desktop app stops an agent of the session
 * `sessionId`: the composer's Stop, a subagent's Stop and Stop all.
 *
 * The response is not written into the cache. It is the session as the
 * controller read it before the interrupt, still busy, so writing it could
 * bring back a Stop the live `session` push has already cleared.
 */
export const useStopAgent = (client: HerculeClient, sessionId: string): StopAgent => {
  const interrupt = useMutation({
    mutationFn: (subagentId: string | undefined) =>
      client.session.interrupt({
        params: { id: sessionId },
        payload: subagentId === undefined ? {} : { subagentId },
      }),
  });
  return {
    stop: (subagentId) => {
      if (interrupt.isPending) return;
      interrupt.mutate(subagentId);
    },
    isPending: interrupt.isPending,
    error: interrupt.error,
    reset: interrupt.reset,
  };
};
