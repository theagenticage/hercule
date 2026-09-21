/**
 * What a screen does with the live connection: nothing it has to think about.
 *
 * Records change under a screen all the time - an agent triages a task, a
 * machine goes quiet - so what is on screen is what the controller says it is
 * rather than what it said when the screen opened. A push names the reads that
 * moved and the cache fetches them again; the screen itself never learns of the
 * socket.
 */
import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { Live } from "@hercule/client-core";
import type { MutableLiveTopic } from "@hercule/contract";

/** Follows one topic for as long as the calling screen is mounted. */
export const useLiveInvalidation = (
  live: Live,
  queryClient: QueryClient,
  topic: MutableLiveTopic,
): void => {
  useEffect(
    () =>
      live.subscribe(topic, (keys) => {
        for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
      }),
    [live, queryClient, topic],
  );
};
