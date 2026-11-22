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
 * - `provider`, for the Provider Accounts and the Model Profiles, whose entries
 *   name each thread's model and say whether it can run;
 * - `task`, for the planned tasks a Draft Thread offers to start from, the
 *   sidebar's failed-run dot, and the Inbox's count, which a Task taken on or
 *   finished changes;
 * - `connection`, for the GitHub Connection the New project form clones
 *   through, which may be made in the web app while this app runs;
 * - `assistant`, for the assistants the sidebar's Assistants section lists;
 * - `signal`, for the open signals, whose urgent ones notify on every
 *   screen, and the Inbox's count, which an open signal changes;
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
import {
  invalidateWithoutCancelling,
  queryKeys,
  type Live,
  type LiveInvalidatePush,
  type LiveQueryKey,
} from "@hercule/client-core";
import type { MutableLiveTopic } from "@hercule/contract";
import { ageClock } from "./age-clock";
import { useWindowVisible } from "./window-visibility";

/**
 * The first segments of the keys whose reads are large and that several pushes
 * of one change all name: the Inbox's outline, the sidebar's counts, the
 * entity panes and the context cards. A signal's change pushes `signal`, then
 * `externalEntity`, and a first push on each of five subscribed topics names
 * them all. `invalidateForPush` reads each of these keys once for the pushes
 * that arrive within `SHARED_READ_WINDOW_MS`, see `queueSharedReads`.
 */
const SHARED_READ_KEYS: ReadonlySet<string> = new Set([
  queryKeys.inbox()[0],
  queryKeys.inboxCount()[0],
  queryKeys.externalEntity()[0],
  queryKeys.entityCards()[0],
] as string[]);

/**
 * How long the pushes that name a shared read's key are gathered before the
 * read starts. One change is announced on several topics in a row, and the
 * controller answers a new connection with a first push on every topic, so
 * without a wait each push would cancel the read of the one before and send
 * its request again: a page reload read the Inbox six times.
 *
 * A change is always followed by a read that starts after its push arrived:
 * the read starts when the window ends, and a push that arrives after that
 * opens a window of its own, which ends in another read. A push never joins a
 * read that is already running, because that read may have been answered
 * before the change the push reports.
 */
export const SHARED_READ_WINDOW_MS = 50;

/**
 * What the pushes of one window changed for the Inbox:
 * - `inbox`: a push named the Inbox's keys, so any row may have changed;
 * - `tasks`: only derived `task` pushes came, about `taskIds`. Such a push
 *   (a session or a run of the Task changed status, its summary was written)
 *   changes what a row on one of those Tasks shows, but never which rows the
 *   list holds, and it comes for every turn of every Thread.
 */
export type InboxPushChange =
  | { readonly kind: "inbox" }
  | { readonly kind: "tasks"; readonly taskIds: ReadonlyArray<string> };

type InboxPushListener = (change: InboxPushChange) => void;

/** Who listens for the Inbox's pushes, by the query client the pushes reach. */
const inboxPushListeners = new WeakMap<QueryClient, Set<InboxPushListener>>();

/** What the pushes of one window have named, by the query client they reached. */
interface GatheredPushes {
  readonly keys: Map<string, LiveQueryKey>;
  namesInbox: boolean;
  readonly taskIds: Set<string>;
}
const gatheredPushes = new WeakMap<QueryClient, GatheredPushes>();

/**
 * Remembers that `keys` need a read, and that the Tasks `taskIds` changed,
 * and starts one read of each key, and one call of each Inbox listener, when
 * the window of `SHARED_READ_WINDOW_MS` that the first push opened ends.
 */
const queueSharedReads = (
  queryClient: QueryClient,
  keys: ReadonlyArray<LiveQueryKey>,
  taskIds: ReadonlyArray<string> = [],
): void => {
  let gathered = gatheredPushes.get(queryClient);
  if (gathered === undefined) {
    const opened: GatheredPushes = { keys: new Map(), namesInbox: false, taskIds: new Set() };
    gathered = opened;
    gatheredPushes.set(queryClient, opened);
    setTimeout(() => {
      gatheredPushes.delete(queryClient);
      const change: InboxPushChange | undefined = opened.namesInbox
        ? { kind: "inbox" }
        : opened.taskIds.size > 0
          ? { kind: "tasks", taskIds: [...opened.taskIds] }
          : undefined;
      if (change !== undefined) {
        for (const listener of [...(inboxPushListeners.get(queryClient) ?? [])]) listener(change);
      }
      for (const queryKey of opened.keys.values()) {
        void queryClient.invalidateQueries({ queryKey, refetchType: "active" });
      }
    }, SHARED_READ_WINDOW_MS);
  }
  for (const queryKey of keys) {
    gathered.keys.set(JSON.stringify(queryKey), queryKey);
    if (queryKey[0] === queryKeys.inbox()[0]) gathered.namesInbox = true;
  }
  for (const taskId of taskIds) gathered.taskIds.add(taskId);
};

/**
 * Calls `listener` once for the pushes of one window (`SHARED_READ_WINDOW_MS`)
 * that change the Inbox, on any topic, as the shell and the screens deliver
 * them to `invalidateForPush`, with what they changed (`InboxPushChange`).
 * Returns a function that stops. The Inbox visit listens through this
 * instead of subscribing to topics itself: a new subscription is answered
 * with a first push that would read the list again right after it opened.
 */
export const listenForInboxPushes = (
  queryClient: QueryClient,
  listener: InboxPushListener,
): (() => void) => {
  const listeners = inboxPushListeners.get(queryClient) ?? new Set<InboxPushListener>();
  inboxPushListeners.set(queryClient, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Reads again every query a push on `topic` makes stale: the queries under
 * `keys`. The large reads that several pushes of one change name are read
 * once per window (see `queueSharedReads`), and derived `task` pushes tell
 * the Inbox which Tasks changed (see `InboxPushChange`).
 */
export const invalidateForPush = (
  queryClient: QueryClient,
  topic: MutableLiveTopic,
  keys: ReadonlyArray<LiveQueryKey>,
  push: LiveInvalidatePush,
): void => {
  const sharedKeys = keys.filter((queryKey) => SHARED_READ_KEYS.has(queryKey[0] as string));
  const changedTaskIds = topic === "task" && push.derived ? push.ids : [];
  if (sharedKeys.length > 0 || changedTaskIds.length > 0) {
    queueSharedReads(queryClient, sharedKeys, changedTaskIds);
  }
  for (const queryKey of keys) {
    if (!SHARED_READ_KEYS.has(queryKey[0] as string)) {
      invalidateWithoutCancelling(queryClient, queryKey);
    }
  }
};

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
  "externalEntity",
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
  // The runs, while the window is visible. This is the only `run`
  // subscription: the screens that read runs rely on it.
  useScreenTopicsLive(live, queryClient, RUN_TOPICS);

  useEffect(() => {
    const unsubscribes = SHELL_TOPICS.map((topic) =>
      live.subscribe(topic, (keys, push) => {
        invalidateForPush(queryClient, topic, keys, push);
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

/**
 * The topic the workflow pages hold: the workflows with their triggers. Not
 * the runs: the shell holds `run` (see `RUN_TOPICS`), and a push on it reads
 * every run list and run again, whichever screen shows them.
 */
export const WORKFLOW_TOPICS: readonly MutableLiveTopic[] = ["workflow"];

/**
 * The topic the shell holds while the window is visible: the runs. The
 * Workflows pages, a run's page, Work and the Office read the runs. It is one
 * subscription, held by the shell, so a
 * push arrives once. It is dropped while the window is hidden and read again
 * when it shows, as `useScreenTopicsLive` does for every screen's topics.
 */
export const RUN_TOPICS: readonly MutableLiveTopic[] = ["run"];

/** The topic the Discussions pages hold. */
export const DISCUSSION_TOPICS: readonly MutableLiveTopic[] = ["discussion"];

/** The topic the Wiki pages hold. */
export const WIKI_TOPICS: readonly MutableLiveTopic[] = ["wikiPage"];

/**
 * The topic the Work screen holds: the open Initiatives, which draw the
 * board's rows, lanes and flags. Only Work reads them, so the shell does not
 * hold the topic.
 */
export const INITIATIVE_TOPICS: readonly MutableLiveTopic[] = ["initiative"];

/** The topic Settings > Skills holds, on its list and on a skill's page. */
export const SKILL_TOPICS: readonly MutableLiveTopic[] = ["skill"];

/**
 * Keeps a screen's reads current while the calling component is mounted and
 * the window is visible, by subscribing to each of `topics`. A push on a
 * topic reads again every query it names.
 *
 * The shell holds none of these topics except `run` (see `RUN_TOPICS`, which
 * `useLiveConnection` holds this way too): the `workflow` topic is pushed at
 * every cron fire, and the Discussions, Wiki and Skills pages are read only
 * by their own screens. While the window is hidden nobody reads the screen,
 * so its topics are dropped (spec 17 §Rules, rule 3). When the window shows
 * again, they are subscribed again, and the controller's first push on each
 * reads every query it covers again.
 *
 * `topics` must keep its identity across renders, such as one of the
 * constants above: a new array subscribes to every topic again.
 */
export const useScreenTopicsLive = (
  live: Live,
  queryClient: QueryClient,
  topics: readonly MutableLiveTopic[],
): void => {
  const visible = useWindowVisible();
  useEffect(() => {
    if (!visible) return;
    const unsubscribes = topics.map((topic) =>
      live.subscribe(topic, (keys, push) => {
        invalidateForPush(queryClient, topic, keys, push);
      }),
    );
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [live, queryClient, topics, visible]);
};
