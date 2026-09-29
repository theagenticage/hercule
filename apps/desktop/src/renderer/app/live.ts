/**
 * Runs the live connection while the shell is mounted, and keeps the
 * sidebar's reads current through it.
 *
 * The shell subscribes to three topics:
 *
 * - `session`, for the thread list (and an open thread's own reads);
 * - `runner`, for the runners, whose connectivity draws a thread as away;
 * - `provider`, for the providers, whose catalogs name each thread's model.
 *
 * Each push invalidates the query keys it lists. The screens never deal with
 * the socket.
 *
 * Projects, workspaces and resources have no live topic yet (#279 adds
 * them). After a reconnect, pushes may have been lost while the connection
 * was down, so they are read again then (the topics' own reads are read again
 * by the live connection itself). A change made elsewhere, such as a project
 * renamed from the CLI, shows at the next reconnect, or when the thread list
 * names a record the cache does not hold (see `useRelatedReads`).
 */
import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { queryKeys, type Live } from "@hercule/client-core";
import type { MutableLiveTopic } from "@hercule/contract";
import { ageClock } from "./age-clock";
import { invalidateWithoutCancelling } from "./live-invalidation";

/** The topics the shell keeps subscribed. */
const SHELL_TOPICS: readonly MutableLiveTopic[] = ["session", "runner", "provider"];

/**
 * Subscribes to the shell's topics, then starts the live connection, and
 * stops it when the calling component unmounts. Call it once, in the shell.
 *
 * The subscriptions are made before the connection starts. Right after it
 * connects, the live connection reads again every read a subscription covers,
 * because pushes sent between the loader's reads and the connection were
 * lost. A subscription made after that moment would miss that read.
 *
 * It also reacts to the connection's status:
 *
 * - When the controller rejects the token, it runs the entry guard again,
 *   which finds no token and shows the sign-in screen. The live connection
 *   fetches its tickets on its own, so without this a rejected token would
 *   go unnoticed until the user's next navigation. Once the sign-in screen
 *   shows, the router empties the caches (see `createAppRouter`).
 * - When the connection comes back after a drop, it reads the projects,
 *   workspaces and resources again, and has the age clock read the time. A
 *   drop often follows a Mac's sleep, which a timer may not have counted.
 *   The first connection does neither: the loader has just read the lists.
 */
export const useLiveConnection = (live: Live, queryClient: QueryClient): void => {
  const router = useRouter();

  useEffect(() => {
    const unsubscribes = SHELL_TOPICS.map((topic) =>
      live.subscribe(topic, (keys) => {
        for (const queryKey of keys) invalidateWithoutCancelling(queryClient, queryKey);
      }),
    );

    let connectedBefore = false;
    const stopFollowingStatus = live.onStatus((status) => {
      if (status === "unauthenticated") void router.invalidate();
      if (status !== "connected") return;
      if (connectedBefore) {
        for (const queryKey of [
          queryKeys.projects(),
          queryKeys.workspaces(),
          queryKeys.resources(),
        ]) {
          invalidateWithoutCancelling(queryClient, queryKey);
        }
        ageClock.refresh();
      }
      connectedBefore = true;
    });

    live.start();
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      stopFollowingStatus();
      void live.stop();
    };
  }, [live, queryClient, router]);
};
