/**
 * Keeps a screen's data current through the live connection.
 *
 * Records change while a screen is open - an agent triages a task, a machine
 * goes quiet - so a screen should show the controller's current state, not the
 * state when the screen opened. Each push lists the query keys that changed,
 * and the cache fetches them again. The screen itself never deals with the
 * socket.
 *
 * A push never cancels a read that is already running:
 * `invalidateWithoutCancelling` explains why.
 */
import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { invalidateWithoutCancelling, type Live } from "@hercule/client-core";
import type { MutableLiveTopic } from "@hercule/contract";

/** Subscribes to one topic while the calling component is mounted, and invalidates the query keys each push lists. */
export const useLiveInvalidation = (
  live: Live,
  queryClient: QueryClient,
  topic: MutableLiveTopic,
): void => {
  useEffect(
    () =>
      live.subscribe(topic, (keys) => {
        for (const queryKey of keys) invalidateWithoutCancelling(queryClient, queryKey);
      }),
    [live, queryClient, topic],
  );
};
