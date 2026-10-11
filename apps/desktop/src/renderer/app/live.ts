/**
 * Runs the live connection while the shell is mounted, and keeps the
 * sidebar's reads current through it.
 *
 * The shell subscribes to these topics:
 *
 * - `session`, for the thread list, the current session of each assistant's
 *   main conversation (and an open thread's own reads). An assistant's
 *   current session is read again only when the push names a session of its
 *   conversation, so a push about a thread or a workflow run's session reads
 *   no assistant's session;
 * - `runner`, for the runners, whose connectivity draws a thread as away;
 * - `workspace`, for working files, observations and retained work;
 * - `provider`, for the providers, whose catalogs name each thread's model;
 * - `task`, for the open tasks a Draft Thread offers to start from;
 * - `connection`, for the GitHub Connection the New project form clones
 *   through, which may be made in the web app while this app runs;
 * - `assistant`, for the assistants the sidebar's Assistants section lists;
 * - `signal`, for Intake's To do list, whose count the Hercule segment shows
 *   and whose Now signals notify, so it stays subscribed while Intake is
 *   closed;
 * - `plugin`, for the plugins whose names label each signal's source.
 *
 * Each push invalidates the query keys it lists. The screens never deal with
 * the socket.
 *
 * Projects and resources have no live topic yet (#279 adds
 * them). After a reconnect, pushes may have been lost while the connection
 * was down, so they are read again then (the topics' own reads are read again
 * on the controller's first push on each subscription). A change made elsewhere, such as a project
 * renamed from the CLI, shows at the next reconnect, or when the thread list
 * names a record the cache does not hold (see `useRelatedReads`).
 */
import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { invalidateWithoutCancelling, queryKeys, type Live } from "@hercule/client-core";
import type { MutableLiveTopic } from "@hercule/contract";
import { ageClock } from "./age-clock";

/** The topics the shell keeps subscribed. */
const SHELL_TOPICS: readonly MutableLiveTopic[] = [
  "session",
  "runner",
  "workspace",
  "provider",
  "task",
  "connection",
  "assistant",
  "signal",
  "plugin",
];

/**
 * Subscribes to the shell's topics, then starts the live connection, and
 * stops it when the calling component unmounts. Call it once, in the shell.
 *
 * Pushes sent between the loader's reads and a subscription are lost. The
 * controller covers that gap: its first push on every subscription, on every
 * new connection, says that every record of the topic may have changed, so
 * every read the subscription covers is read again.
 *
 * It also reacts to the connection's status:
 *
 * - When the controller rejects the token, it runs the entry guard again,
 *   which finds no token and shows the sign-in screen. The live connection
 *   fetches its tickets on its own, so without this a rejected token would
 *   go unnoticed until the user's next navigation. Once the sign-in screen
 *   shows, the router empties the caches (see `createAppRouter`).
 * - When the connection comes back after a drop, it reads the projects,
 *   resources again, and has the age clock read the time. A
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
        for (const queryKey of [queryKeys.projects(), queryKeys.resources()]) {
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

/**
 * Keeps the subagents of the thread `sessionId` current while the calling
 * component is mounted: subscribes to the `subagent` topic, whose pushes
 * invalidate the subagent lists they name. Does nothing while `sessionId` is
 * null.
 *
 * The topic is held only while a thread is open, because only a thread shows
 * subagents (spec 17 §What subagents cost). Pushes sent while the topic was
 * not held were lost, so a list cached by an earlier visit may be out of
 * date. The controller's first push on the subscription names no session,
 * which invalidates every subagent list, so the open thread's list is read
 * again then. The cost is one more read each time a thread opens, right
 * after its loader read the list.
 */
export const useSubagentsLive = (
  live: Live,
  queryClient: QueryClient,
  sessionId: string | null,
): void => {
  useEffect(() => {
    if (sessionId === null) return;
    return live.subscribe("subagent", (keys) => {
      for (const queryKey of keys) invalidateWithoutCancelling(queryClient, queryKey);
    });
  }, [live, queryClient, sessionId]);
};
