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
import { useEffect, useMemo } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { invalidateWithoutCancelling, queryKeys, type Live } from "@hercule/client-core";
import type { MutableLiveTopic } from "@hercule/contract";
import { ageClock } from "./age-clock";
import { useWindowVisible } from "./window-visibility";

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

/** Holds no topic, for a hook that holds its topics only some of the time. */
const NO_TOPICS: readonly MutableLiveTopic[] = [];

/**
 * Subscribes to `topics` while the calling component is mounted, and has
 * each push invalidate the query keys it lists. Subscribes again whenever
 * `topics` changes identity, so pass a constant, or `NO_TOPICS` to hold none.
 *
 * Pushes sent while a topic was not held were lost, so a read cached by an
 * earlier visit may be out of date. The controller covers that: its first
 * push on every subscription says that every record of the topic may have
 * changed, so every read the topic covers is read again then.
 */
const useLiveTopics = (
  live: Live,
  queryClient: QueryClient,
  topics: readonly MutableLiveTopic[],
): void => {
  useEffect(() => {
    const unsubscribes = topics.map((topic) =>
      live.subscribe(topic, (keys) => {
        for (const queryKey of keys) invalidateWithoutCancelling(queryClient, queryKey);
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [live, queryClient, topics]);
};

/**
 * Keeps the subagents of the thread `sessionId` current while the calling
 * component is mounted: subscribes to the `subagent` topic, whose pushes
 * invalidate the subagent lists they name. Does nothing while `sessionId` is
 * null.
 *
 * The topic is held only while a thread is open, because only a thread shows
 * subagents (spec 17 §What subagents cost). It is subscribed again when
 * another thread opens. The controller's first push on the subscription
 * names no session, which invalidates every subagent list, so the open
 * thread's list is read again then. The cost is one more read each time a
 * thread opens, right after its loader read the list.
 */
export const useSubagentsLive = (
  live: Live,
  queryClient: QueryClient,
  sessionId: string | null,
): void => {
  // A new list for each thread, so opening another thread subscribes again.
  const topics = useMemo(
    (): readonly MutableLiveTopic[] => (sessionId === null ? NO_TOPICS : ["subagent"]),
    [sessionId],
  );
  useLiveTopics(live, queryClient, topics);
};

/** The topics `useWorkflowsLive` holds: the workflows with their triggers, and the runs. */
const WORKFLOW_TOPICS: readonly MutableLiveTopic[] = ["workflow", "run"];

/**
 * Keeps the workflow pages' reads current while the calling component is
 * mounted and the window is visible: subscribes to the `workflow` topic,
 * whose pushes read the workflows and the triggers again, and to `run`, whose
 * pushes read every run list again.
 *
 * The shell holds neither topic, because the controller pushes on both at
 * every cron fire. While the window is hidden nobody reads the pages, so
 * both topics are dropped (spec 17 §Rules, rule 3). When the window shows
 * again, they are subscribed again, and the controller's first push on each
 * reads every list they cover again.
 */
export const useWorkflowsLive = (live: Live, queryClient: QueryClient): void => {
  const visible = useWindowVisible();
  useLiveTopics(live, queryClient, visible ? WORKFLOW_TOPICS : NO_TOPICS);
};
