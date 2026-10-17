/**
 * Every read the app makes, as query options.
 *
 * The query keys come from `client-core`, so the desktop app and the web app
 * key the same reads the same way, and a live push lists the keys the cache
 * uses.
 */
import {
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  type EnsureInfiniteQueryDataOptions,
  type InfiniteData,
  type EnsureQueryDataOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  ApiError,
  collectRunningTurnRows,
  collectSenderSessionIds,
  detectLocalRunner,
  type EventListFilter,
  isNotFound,
  mergeNewestMessagePage,
  mergeSentMessage,
  queryKeys,
  readEveryPage,
  readSenderSession,
  type HerculeClient,
  type MessagePage,
  type MessagePages,
  waitForOptionalReads,
} from "@hercule/client-core";
import type { TimelineDay } from "@hercule/client-core/run-timeline";
import {
  DEFAULT_PAGE_LIMIT,
  LIVE_SESSION_STATUSES,
  MAX_PAGE_LIMIT,
  type ConversationMessage,
  type EventHandling,
  type Input,
  type Runner,
  type Session,
  type SignalFilter,
  type Task,
  type TranscriptRow,
} from "@hercule/contract";
import type { Bridge } from "../../ipc/bridge";
import { buildThumbnail } from "./thumbnails";

/**
 * Reads whether the controller's first run has been completed. Works without
 * a token. It is read once and then kept, because setup happens only once.
 * It never retries: an unreachable controller must lead to the connect screen
 * at once, not after several seconds of retries.
 */
export const setupQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.setup(),
    queryFn: () => client.setup.read(),
    staleTime: Infinity,
    retry: false,
  });

/**
 * The options of a read from main that the page reads once and then keeps:
 * main's answer changes only through this page's own writes, or after a
 * reload, which starts a new cache. It never retries, because main does not
 * fail on its own.
 */
const KEPT_BRIDGE_READ_OPTIONS = {
  staleTime: Infinity,
  gcTime: Infinity,
  retry: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

/**
 * Reads what main keeps of the first run for the saved controller: the steps
 * the user put off, or null when no first run is in progress. The first run
 * writes the cached value each time it writes main's, so the entry guard
 * reads it from the cache.
 */
export const firstRunQuery = (bridge: Bridge) =>
  queryOptions({
    queryKey: ["first-run"],
    queryFn: () => bridge.firstRunProgress.read(),
    ...KEPT_BRIDGE_READ_OPTIONS,
  });

/**
 * Looks for Hercule on this Mac, once per launch with no saved controller,
 * and returns the address main found for it. Main saves nothing: the welcome
 * saves the address through `controllerUrl.save`.
 */
export const localControllerQuery = (bridge: Bridge) =>
  queryOptions({
    queryKey: ["local-controller"],
    queryFn: () => bridge.localController.find(),
    ...KEPT_BRIDGE_READ_OPTIONS,
  });

/**
 * Reads the saved controller's setup token from main. Main hands out a pasted
 * token only once, so the answer is kept until the first run invalidates it,
 * after the controller refuses the token.
 */
export const setupTokenQuery = (bridge: Bridge) =>
  queryOptions({
    queryKey: ["setup-token"],
    queryFn: () => bridge.setupToken.read(),
    ...KEPT_BRIDGE_READ_OPTIONS,
  });

/** Reads the name of the user's account on this Mac, which the first run offers as the username. */
export const macUserQuery = (bridge: Bridge) =>
  queryOptions({
    queryKey: ["mac-user"],
    queryFn: () => bridge.macUser.read(),
    ...KEPT_BRIDGE_READ_OPTIONS,
  });

/**
 * The options of every read the live connection keeps current: the sidebar's
 * and the open thread's. Such a read is never fetched again because time
 * passed, the window got focus or the network came back. It is fetched again
 * only when a live push, a live reconnect, or a change in the thread list (see
 * `useRelatedReads`) marks it out of date. An app that is idle then makes no
 * requests at all.
 */
const LIVE_KEPT_READ_OPTIONS = {
  staleTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

/**
 * The options of every read `ensureShellData` loads: the records the shell
 * shows on every screen. They are kept current like any live-kept read, and
 * kept in the cache for the life of the window, even while no component on
 * screen reads them.
 *
 * Without that, Query removes a read five minutes after the last component
 * reading it unmounts. A component that is not always on screen, such as a
 * section of one sidebar face, would then find the read gone and suspend the
 * whole app until it is read again. Keeping it here means no component has
 * to read a record it does not draw just to keep it cached. The records are
 * few and small, so keeping them costs little memory.
 */
const SHELL_READ_OPTIONS = {
  ...LIVE_KEPT_READ_OPTIONS,
  gcTime: Infinity,
} as const;

// The sidebar's list reads below follow the cursor to the last page, because
// the sidebar needs every record a label can come from. A list cut off after
// its first page would leave threads without their workspace's label and
// nothing would say so, and the workspace list grows with every thread that
// gets a worktree of its own.

/**
 * Reads every thread: every session no Agent spawned. The sidebar lists all
 * of them, so the read follows the cursor to the last page. Its key sits
 * under the `sessions` prefix, so a push on the `session` topic invalidates
 * it.
 */
export const threadsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.sessions({ thread: true }),
    queryFn: () =>
      readEveryPage((page) => client.session.query({ query: { thread: true, ...page } })),
    ...SHELL_READ_OPTIONS,
  });

/**
 * Reads every live session an Agent spawned: the sessions of runs'
 * agent steps, the assistants' and any other that is not a thread. "From
 * runs" in Waiting on you, and the workflow list's Needs you, keep those of
 * a run that wait on the user (`listWaitingRunSessions`). The controller has
 * no filter for that, so the client keeps them. The read follows the cursor
 * to the last page, and its key sits under the `sessions` prefix, so a push
 * on the `session` topic invalidates it.
 */
export const liveAgentSessionsQuery = (client: HerculeClient) => {
  const filter = { thread: false, status: LIVE_SESSION_STATUSES } as const;
  return queryOptions({
    queryKey: queryKeys.sessions(filter),
    queryFn: () => readEveryPage((page) => client.session.query({ query: { ...filter, ...page } })),
    ...SHELL_READ_OPTIONS,
  });
};

/** Reads every project, for the sidebar's project headers. */
export const projectsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.projects(),
    queryFn: () => readEveryPage((page) => client.project.query({ query: page })),
    ...SHELL_READ_OPTIONS,
  });

/**
 * Reads every workspace, disposed ones included, because a thread that ended
 * in one is still labelled with it.
 */
export const workspacesQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.workspaces(),
    queryFn: () => readEveryPage((page) => client.workspace.query({ query: page })),
    ...SHELL_READ_OPTIONS,
  });

/** Reads every resource. A main workspace is labelled with its repo's name. */
export const resourcesQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.resources(),
    queryFn: () => readEveryPage((page) => client.resource.query({ query: page })),
    ...SHELL_READ_OPTIONS,
  });

/** Reads every runner. A thread on a runner that is offline is drawn as away. */
export const runnersQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.runners(),
    queryFn: () => readEveryPage((page) => client.runner.query({ query: page })),
    ...SHELL_READ_OPTIONS,
  });

/** Reads every provider instance, whose catalogs name the model a thread runs. */
export const providersQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.providers(),
    queryFn: () => client.provider.query(),
    ...SHELL_READ_OPTIONS,
  });

/**
 * The options of a read that no live topic covers: the settings, the
 * permission profiles, the controller's record and the workflows. Such a read is fetched again each time a screen that
 * shows it opens, so a change made elsewhere, such as a default model set in
 * the web app, reaches the next Draft Thread and the next opening of
 * Settings > Profile. The screen's loader decides that, see `readOnOpen`.
 *
 * Nothing else fetches it: it never goes stale on its own, so a component
 * that starts reading it, such as the sidebar's draft row, finds it fresh.
 * Like every other read, it is not fetched again when the window gets focus
 * or the network comes back.
 */
const READ_ON_OPEN_OPTIONS = {
  staleTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

/** Reads the controller's settings, whose user part holds the defaults of a new thread. */
export const settingsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.settings(),
    queryFn: () => client.settings.read(),
    ...READ_ON_OPEN_OPTIONS,
  });

/**
 * Reads every plain agent. `agent.query` does not list assistants;
 * `assistantsQuery` reads those. No live topic covers agents, so a screen
 * reads it with `readOnOpen`.
 */
export const agentsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.agents(),
    queryFn: () => readEveryPage((page) => client.agent.query({ query: page })),
    ...READ_ON_OPEN_OPTIONS,
  });

/** Reads every permission profile, one of which a new thread runs under. */
export const profilesQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.profiles(),
    queryFn: () => readEveryPage((page) => client.profile.query({ query: page })),
    ...READ_ON_OPEN_OPTIONS,
  });

/**
 * Reads the index of an assistant's memory: `core` first, then each topic's
 * name, size and gist. Memory has no live topic, so a screen that shows it
 * reads it with `readOnOpen`.
 */
export const memoryIndexQuery = (client: HerculeClient, assistantId: string) =>
  queryOptions({
    queryKey: queryKeys.memory(assistantId),
    queryFn: () => client.memory.list({ params: { id: assistantId } }),
    ...READ_ON_OPEN_OPTIONS,
  });

/**
 * Reads one document of an assistant's memory, `core` or a topic, with its
 * body. Memory has no live topic, so a screen that shows it reads it with
 * `readOnOpen`. An error is not retried: a topic the assistant deleted
 * returns 404 on every try, and the page goes back to the section at once.
 * The web app reads it with the same setting.
 */
export const memoryDocumentQuery = (client: HerculeClient, assistantId: string, name: string) =>
  queryOptions({
    queryKey: queryKeys.memory(assistantId, name),
    queryFn: () => client.memory.read({ params: { id: assistantId, name } }),
    retry: false,
    ...READ_ON_OPEN_OPTIONS,
  });

/**
 * Reads `options` once for this opening of a screen, and returns its data.
 *
 * The first time, there is nothing to show, so the screen waits for the
 * read. After that, the data read last is returned at once and the read runs
 * in the background, so opening the screen waits on the controller only the
 * first time. The data never goes stale on its own, so marking it out of
 * date here is what makes it read again. A component that starts reading it
 * while that read runs joins it rather than sending a second one.
 *
 * A screen's loader calls it for each read that no live push keeps current.
 * Fails when the read fails and no earlier data is cached.
 */
export const readOnOpen = <Data>(
  queryClient: QueryClient,
  options: EnsureQueryDataOptions<Data, Error, Data, QueryKey>,
): Promise<Data> => {
  void queryClient.invalidateQueries({ queryKey: options.queryKey, refetchType: "none" });
  return queryClient.ensureQueryData({ ...options, revalidateIfStale: true });
};

/**
 * Finds which of `runners` runs on this Mac, and returns its id, or `null`
 * when none does. Main asks each identity port for the page: the page's
 * Content Security Policy lets it reach only the controller, and a runner
 * lets only the controller's origin read its identity.
 *
 * The key holds each online runner's identity port, so the probe runs again
 * only when those change: a runner comes online, goes away or moves port.
 * The runners read, which the live connection keeps current, decides that.
 * A probe that finds nothing is an answer, not a failure, so it never
 * retries.
 *
 * While a new probe runs, the query keeps the previous answer. Otherwise a
 * runner coming online would blank the draft's machine until the probe
 * returns, and a screen that suspends on the read would flash its fallback.
 */
export const localRunnerQuery = (bridge: Bridge, runners: ReadonlyArray<Runner>) =>
  queryOptions({
    queryKey: queryKeys.localRunner(runners),
    queryFn: () => detectLocalRunner(runners, (port) => bridge.runnerIdentity.read({ port })),
    retry: false,
    placeholderData: keepPreviousData,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/** How many open tasks a Draft Thread offers to start from. */
const START_TASK_COUNT = 3;

/**
 * The order of the start cards: highest priority first, and newest first among
 * tasks of the same priority. `priority` ascends low to urgent, so urgent
 * first is `desc`.
 */
const START_TASK_SORT = [
  { field: "priority", direction: "desc" },
  { field: "createdAt", direction: "desc" },
] as const;

/**
 * Reads the open tasks of `projectId` a Draft Thread offers to start from:
 * the three most urgent, newest first within one priority. The key sits under
 * the `tasks` prefix, so a push on the `task` topic reads them again while a
 * Draft Thread shows them.
 */
export const startTasksQuery = (client: HerculeClient, projectId: string) =>
  queryOptions({
    queryKey: [
      ...queryKeys.tasks({ projectId, status: ["open"] }),
      { sort: START_TASK_SORT, limit: START_TASK_COUNT },
    ],
    queryFn: async (): Promise<readonly Task[]> => {
      const page = await client.task.query({
        query: {
          projectId,
          status: ["open"],
          sort: START_TASK_SORT,
          limit: START_TASK_COUNT,
        },
      });
      return page.items;
    },
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads the controller's own record. Its `localRunnerId` is the runner on the
 * controller's machine, or `null` when no runner runs there.
 *
 * Its text generation status can change with a runner or a provider
 * instance, so pushes on the `runner` and `provider` topics, which the shell
 * holds, read it again. Its default runner and its text generation model
 * can change from the CLI or the web app with no push, so Settings > System
 * and a run's page read it with `readOnOpen`.
 */
export const controllerQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.controller(),
    queryFn: () => client.controller.read(),
    ...READ_ON_OPEN_OPTIONS,
  });

/**
 * Reads every Connection: for the first run's GitHub step, the default
 * GitHub account on Settings > Profile, and the dot on the Settings list's
 * Connections row.
 */
export const connectionsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.connections(),
    queryFn: () => readEveryPage((page) => client.connection.query({ query: page })),
    ...SHELL_READ_OPTIONS,
  });

/**
 * Reads the events each Connection received in the last 24 hours, for
 * Settings > Connections. No live topic covers the counts, and a push for
 * every event would cost more than the counts are worth, so the section reads
 * them each time it opens, see `readOnOpen`.
 */
export const eventCountsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.eventCounts(),
    queryFn: () => client.event.countByConnection(),
    ...READ_ON_OPEN_OPTIONS,
  });

/**
 * Reads one Connection with its Intake settings, for the segment of Settings >
 * Intake that edits it. Unlike the listing, `connection.read` works out the
 * value in effect for every kind the Connection's plugin declares. A push on
 * the `connection` topic that names the Connection reads it again, and so
 * does a push on the `plugin` topic, which changes what every Connection of
 * the plugin resolves to. Fails with a `not_found` `ApiError` when no such
 * Connection exists.
 */
export const connectionQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.connection(id),
    queryFn: () => client.connection.read({ params: { id } }),
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads the choices a Connection's setting offers, for the picker that draws
 * the setting in Settings > Connections. The choices come from the account
 * behind the Connection, so they are read each time the picker opens and
 * dropped as soon as it closes; a failed read is not tried again, because the
 * picker falls back to a plain field.
 */
export const connectionChoicesQuery = (
  client: HerculeClient,
  connectionId: string,
  field: string,
) =>
  queryOptions({
    queryKey: queryKeys.connectionChoices(connectionId, field),
    queryFn: async () =>
      (await client.connection.listChoices({ params: { id: connectionId, field } })).choices,
    gcTime: 0,
    retry: false,
    ...READ_ON_OPEN_OPTIONS,
  });

/**
 * Reads every assistant: for the sidebar, the assistant screen, and the one
 * the first run's room seats in the lobby.
 */
export const assistantsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.assistants(),
    queryFn: () => readEveryPage((page) => client.assistant.query({ query: page })),
    ...SHELL_READ_OPTIONS,
  });

/** The key of the soonest `until` on Later, which each read of To do writes. See `snoozeTimerQuery`. */
const SNOOZE_TIMER_KEY = ["snooze-timer"] as const;

/**
 * Reads Intake's To do list: every open signal that is not snoozed, read
 * whole, because every client counts it. The Hercule segment's count and
 * Intake's list both come from it, and a push on the `signal` topic reads it
 * again.
 *
 * Each read first reads the soonest `until` on Later and stores it for the
 * snooze timer. Read in that order, a snooze that runs out between the two
 * reads is missing from To do but still sets the timer, which reads To do
 * again once it has run out. Read in the other order, or apart, that snooze
 * could be missing from both, and To do would stay without it.
 */
export const signalsToDoQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.signals({ view: "to-do" }),
    queryFn: async ({ client: queryClient }) => {
      const soonest = await client.signal.query({ query: { view: "later", limit: 1 } });
      queryClient.setQueryData(SNOOZE_TIMER_KEY, soonest.items[0]?.snooze?.until ?? null);
      return (await client.signal.query({ query: { view: "to-do" } })).items;
    },
    ...SHELL_READ_OPTIONS,
  });

/**
 * Reads Intake's Later list page by page, soonest snooze first: every open
 * signal snoozed until a future time, or only those of the plugin `source`
 * for a plugin's tab. A push on the `signal` topic reads the held pages
 * again. Intake reads it only while it shows Later, or the Later count.
 */
export const signalsLaterQuery = (client: HerculeClient, source?: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.signals(buildPagedSignalFilter("later", source)),
    queryFn: ({ pageParam }) =>
      client.signal.query({ query: buildPagedSignalFilter("later", source, pageParam) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Returns the soonest `until` on Later, or `null` when nothing is snoozed,
 * as the last read of To do stored it (see `signalsToDoQuery`). The snooze
 * timer waits for that time on every screen (see `SnoozeTimer`), so this is
 * a shell read. It reads To do when To do has not been read yet, and never
 * reads Later on its own.
 */
export const snoozeTimerQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: SNOOZE_TIMER_KEY,
    queryFn: async ({ client: queryClient }): Promise<string | null> => {
      await queryClient.fetchQuery(signalsToDoQuery(client));
      return queryClient.getQueryData<string | null>(SNOOZE_TIMER_KEY) ?? null;
    },
    ...SHELL_READ_OPTIONS,
  });

/**
 * Reads Intake's Done list page by page, newest first: every resolved
 * signal, or only those of the plugin `source` for a plugin's tab. A push on
 * the `signal` topic reads the held pages again.
 */
export const signalsDoneQuery = (client: HerculeClient, source?: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.signals(buildPagedSignalFilter("done", source)),
    queryFn: ({ pageParam }) =>
      client.signal.query({ query: buildPagedSignalFilter("done", source, pageParam) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads Done newest first in the largest pages the controller gives, for the
 * count of signals cleared today under To do. The foot reads the next page
 * only until a page reaches a signal resolved before today, so most days it
 * takes one request. A push on the `signal` topic reads the held pages again.
 */
export const signalsClearedTodayQuery = (client: HerculeClient) =>
  infiniteQueryOptions({
    queryKey: queryKeys.signals(
      buildPagedSignalFilter("done", undefined, undefined, MAX_PAGE_LIMIT),
    ),
    queryFn: ({ pageParam }) =>
      client.signal.query({
        query: buildPagedSignalFilter("done", undefined, pageParam, MAX_PAGE_LIMIT),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads every signal of the kind `kind` on Later, following the cursor to
 * the last page. Together with To do, which the shell holds whole, it gives
 * every open signal of the kind, so the count of signals an Ignore Rule would
 * take off the list is never cut short by a page.
 *
 * Intake reads it once each time Hercule's offer or the Ignore dialog opens.
 * Its key lies outside the `signals` prefix, so a push on the `signal` topic
 * does not read all of Later again. The entry is dropped as soon as nothing
 * reads it (`gcTime: 0`), so the next opening reads Later afresh.
 */
export const laterSignalsOfKindQuery = (client: HerculeClient, kind: string) =>
  queryOptions({
    queryKey: queryKeys.laterSignalsOfKind(kind),
    queryFn: () =>
      readEveryPage((page) => client.signal.query({ query: { view: "later", kind, ...page } })),
    ...LIVE_KEPT_READ_OPTIONS,
    gcTime: 0,
  });

/**
 * Reads every Ignore Rule, with what each caught, for Settings > Intake. No
 * live topic covers the rules, so the section reads them each time it opens,
 * see `readOnOpen`.
 */
export const ignoreRulesQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.ignoreRules(),
    queryFn: () => client.ignoreRule.query({ query: {} }),
    ...READ_ON_OPEN_OPTIONS,
  });

/**
 * Builds the filter of one page of the paged view `view`, `limit` signals
 * long. The query key is built from the same filter without a cursor, so
 * every page of one list shares one key.
 */
const buildPagedSignalFilter = (
  view: "later" | "done",
  source: string | undefined,
  cursor?: string,
  limit: number = DEFAULT_PAGE_LIMIT,
): SignalFilter => ({
  view,
  limit,
  ...(source === undefined ? {} : { source }),
  ...(cursor === undefined ? {} : { cursor }),
});

/**
 * Reads every plugin, for the names Intake gives each signal's source. A push
 * on the `plugin` topic reads it again.
 */
export const pluginsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.plugins(),
    queryFn: () => client.plugin.query(),
    ...SHELL_READ_OPTIONS,
  });

/**
 * Reads every workflow: the workflow list's rows, and the name Intake gives a
 * signal a workflow's run raised. The shell holds no `workflow` topic,
 * because the controller pushes on it at every cron fire. The workflows page
 * holds it while it is mounted and the window is visible (`useScreenTopicsLive`),
 * so a push reads the list again there. Intake holds no topic, so it reads
 * the list each time it opens, see `readOnOpen`.
 */
export const workflowsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.workflows(),
    queryFn: () => readEveryPage((page) => client.workflow.query({ query: page })),
    ...READ_ON_OPEN_OPTIONS,
  });

/**
 * Reads every trigger of every workflow, for the workflow list's Starts on,
 * Next, and a trigger in error. A trigger is part of its workflow, so a push
 * on the `workflow` topic reads it again.
 */
export const triggersQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.triggers(),
    queryFn: () => readEveryPage((page) => client.trigger.query({ query: page })),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/** How many of a workflow's newest runs its strip in the workflow list shows. */
export const STRIP_RUN_LIMIT = 20;

/**
 * Reads every workflow's newest runs, at most `STRIP_RUN_LIMIT` per workflow,
 * each workflow's newest first: the strips of the workflow list, in one read
 * rather than one per workflow. Its key sits under the `runs` prefix, so a
 * push on the `run` topic reads it again.
 */
export const newestRunsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.runs({ newestPerWorkflow: STRIP_RUN_LIMIT }),
    queryFn: () =>
      readEveryPage((page) =>
        client.run.query({ query: { newestPerWorkflow: STRIP_RUN_LIMIT, ...page } }),
      ),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads every run with the status `status`. The workflow list reads the
 * `running` runs and the `pending` ones, which are its Running group: the
 * filter takes one status, so it takes two reads. Its key sits under the
 * `runs` prefix, so a push on the `run` topic reads it again.
 */
export const liveRunsQuery = (client: HerculeClient, status: "running" | "pending") =>
  queryOptions({
    queryKey: queryKeys.runs({ status }),
    queryFn: () => readEveryPage((page) => client.run.query({ query: { status, ...page } })),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads one workflow with its stored YAML source, for its page, which parses
 * the source to draw the graph. A push on the `workflow` topic that names the
 * workflow reads it again. A workflow that does not exist is not read again:
 * the page shows that it was not found.
 */
export const workflowQuery = (client: HerculeClient, workflowId: string) =>
  queryOptions({
    queryKey: queryKeys.workflow(workflowId),
    queryFn: () => client.workflow.read({ params: { id: workflowId } }),
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads the workflow actions, whose names label a graph's action steps. No
 * topic covers them: they change only when a plugin is turned on or off, so
 * the open workflow reads them each time it opens, see `readOnOpen`.
 */
export const workflowActionsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.workflowActions(),
    queryFn: () => client.workflowAction.query(),
    ...READ_ON_OPEN_OPTIONS,
  });

/**
 * Reads a workflow's runs, newest first, a page at a time, for the open
 * workflow's Runs list. A workflow can have thousands of runs, so the list
 * reads the next page only when the user scrolls to the end of the last. Its
 * key sits under the `runs` prefix, so a push on the `run` topic reads the
 * pages read so far again.
 */
export const workflowRunsQuery = (client: HerculeClient, workflowId: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.runs({ workflowId }),
    queryFn: ({ pageParam }) =>
      client.run.query({
        query: pageParam === undefined ? { workflowId } : { workflowId, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads every run of a workflow that was live at some moment of `day`: one
 * day of the Runs tab's timeline. It reads the runs created before the day
 * ended that had not ended before it started, so a run that waits on the
 * user for days shows on each of them. Its key sits under the `runs`
 * prefix, so a push on the `run` topic reads it again.
 */
export const workflowDayRunsQuery = (
  client: HerculeClient,
  workflowId: string,
  day: TimelineDay,
) => {
  const activeSince = day.start.toISOString();
  const until = day.end.toISOString();
  return queryOptions({
    queryKey: queryKeys.runs({ workflowId, activeSince, until }),
    queryFn: () =>
      readEveryPage((page) =>
        client.run.query({ query: { workflowId, activeSince, until, ...page } }),
      ),
    ...LIVE_KEPT_READ_OPTIONS,
  });
};

/**
 * Reads one run with its plan and step records, for its page. A push on the
 * `run` topic that names the run reads it again. Fails with a `not_found`
 * `ApiError` when no run has the id, which is not tried again: the page shows
 * that the run was not found.
 */
export const runQuery = (client: HerculeClient, runId: string) =>
  queryOptions({
    queryKey: queryKeys.run(runId),
    queryFn: () => client.run.read({ params: { id: runId } }),
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads every session a run's agent steps started, for the run's page: what
 * a waiting step asks, and a step's model, tokens and tool calls. Its key
 * sits under the `sessions` prefix, so a push on the `session` topic, which
 * the shell holds, reads it again.
 */
export const runSessionsQuery = (client: HerculeClient, runId: string) =>
  queryOptions({
    queryKey: queryKeys.sessions({ runId }),
    queryFn: () => readEveryPage((page) => client.session.query({ query: { runId, ...page } })),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Starts reading the workflow `workflowId`, which a run was started from,
 * unless an earlier read found it gone. Resolves when the read ends, and
 * never fails: a deleted workflow answers `not_found`, which the run's page
 * and a step session's header show as "deleted" rather than as a failure.
 */
export const prefetchRunWorkflow = (
  queryClient: QueryClient,
  client: HerculeClient,
  workflowId: string,
): Promise<void> => {
  const workflow = workflowQuery(client, workflowId);
  if (isNotFound(queryClient.getQueryState(workflow.queryKey)?.error)) return Promise.resolve();
  return queryClient.prefetchQuery(workflow);
};

/**
 * Reads every session the agent steps of the runs `runIds` started, exited
 * ones included, for the Office: a run's sessions stay in the Office until
 * the run ends. The ids are sorted, so the same runs in another order share
 * one read, and no ids reads nothing. Its key sits under the `sessions`
 * prefix, so a push on the `session` topic, which the shell holds, reads it
 * again.
 */
export const liveRunSessionsQuery = (client: HerculeClient, runIds: readonly string[]) => {
  const [first, ...rest] = [...runIds].sort();
  const filter = first === undefined ? null : ({ runId: [first, ...rest] } as const);
  return queryOptions({
    queryKey: filter === null ? [...queryKeys.sessions(), "of no run"] : queryKeys.sessions(filter),
    queryFn: () =>
      filter === null
        ? Promise.resolve<readonly Session[]>([])
        : readEveryPage((page) => client.session.query({ query: { ...filter, ...page } })),
    ...LIVE_KEPT_READ_OPTIONS,
  });
};

/**
 * Reads what the Office draws beyond the shell's reads, so the Office opens
 * with every colleague in place: the runs that are pending or running, and
 * the sessions of those runs.
 */
export const ensureOfficeData = async (
  queryClient: QueryClient,
  client: HerculeClient,
): Promise<void> => {
  const [running, pending] = await Promise.all([
    queryClient.ensureQueryData(liveRunsQuery(client, "running")),
    queryClient.ensureQueryData(liveRunsQuery(client, "pending")),
  ]);
  const runIds = [...running, ...pending].map((run) => run.id);
  await queryClient.ensureQueryData(liveRunSessionsQuery(client, runIds));
};

/**
 * Reads every re-run of a run, newest first, for the re-run links of its
 * page. Its key sits under the `runs` prefix, so a push on the `run` topic
 * reads it again, which also brings in a re-run started while the page is
 * open.
 */
export const rerunsQuery = (client: HerculeClient, runId: string) =>
  queryOptions({
    queryKey: queryKeys.runs({ originalRunId: runId }),
    queryFn: () =>
      readEveryPage((page) => client.run.query({ query: { originalRunId: runId, ...page } })),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Checks whether a failed read, such as a thread's records or an assistant's
 * current session, is worth trying again. Returns `true` for the first three
 * failures that got no answer from the controller, such as a dropped
 * connection, and `false` for an `ApiError`.
 *
 * An `ApiError` is the controller's answer, and asking again gets the same
 * answer: a thread that does not exist keeps not existing, and a read that is
 * forbidden stays forbidden. The not-found screen and the render failure then
 * show at once, rather than after several seconds of retries.
 */
const isWorthRetrying = (failureCount: number, error: Error): boolean =>
  !(error instanceof ApiError) && failureCount < 3;

/**
 * Reads a conversation's current session: the newest session that answers
 * it, or null when none has started yet. An assistant's pose is drawn from
 * the current session of its main conversation. The server picks the newest,
 * because a list filtered here could be cut off at its page size and then
 * return an older session.
 *
 * A push on the `session` topic reads it again only when the push names a
 * session of this conversation, since only such a session can be or replace
 * its current one. The web app keys the same read the same way.
 */
export const currentConversationSessionQuery = (client: HerculeClient, conversationId: string) =>
  queryOptions({
    queryKey: queryKeys.conversationSession(conversationId),
    queryFn: async (): Promise<Session | null> => {
      const page = await client.session.query({
        query: { conversationId, sort: [{ field: "createdAt", direction: "desc" }], limit: 1 },
      });
      return page.items[0] ?? null;
    },
    retry: isWorthRetrying,
    ...SHELL_READ_OPTIONS,
  });

/**
 * Reads one page of a conversation's messages, newest first: the newest page
 * when `cursor` is `undefined`, else the page the cursor points to, which
 * holds older messages.
 */
export const readMessagePage = (
  client: HerculeClient,
  conversationId: string,
  cursor: string | undefined,
) =>
  client.conversation.queryMessages({
    params: { id: conversationId },
    query: {
      sort: [{ field: "position", direction: "desc" }],
      limit: DEFAULT_PAGE_LIMIT,
      ...(cursor === undefined ? {} : { cursor }),
    },
  });

/**
 * Removes the query `queryKey` from `queryClient` once nothing observes it.
 * A screen that alone keeps a query current calls it from its effect
 * cleanup, so the cache does not hold the query out of date after the
 * screen unmounts.
 *
 * The check runs after the current commit, not at once. In development
 * React's StrictMode runs every effect's cleanup and then the effect again
 * when a component mounts, and the query's observers subscribe again in
 * between. Removed at once, the query would leave them reading an entry the
 * cache no longer holds, and the screen would read it again without end.
 */
export const removeQueryOnceUnobserved = (queryClient: QueryClient, queryKey: QueryKey): void => {
  setTimeout(() => {
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    if (query !== undefined && query.getObserversCount() === 0) {
      queryClient.getQueryCache().remove(query);
    }
  }, 0);
};

/**
 * Reads a conversation's messages a page at a time, newest page first, for an
 * assistant's Conversation. The first read holds the newest page only; each
 * `fetchNextPage` adds the page of older messages before it, as the user
 * scrolls up.
 *
 * Nothing reads the pages again on its own. While the Conversation is open,
 * a push on the `conversation` topic reads the newest page and merges it into
 * the held pages (see `useConversationLive`), so the pages read earlier are
 * never read twice. The pages are dropped when the Conversation unmounts,
 * so opening it again reads the newest page afresh.
 */
export const conversationMessagesQuery = (client: HerculeClient, conversationId: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.conversationMessages(conversationId),
    queryFn: ({ pageParam }) => readMessagePage(client, conversationId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Replaces the pages of the conversation `conversationId` held in
 * `queryClient` with `update` applied to them. Resolves once the change is
 * in the cache. Does nothing while no pages are held: the user has left the
 * Conversation, and an entry created now would hold a newest page with no
 * history before it, which nothing would read again.
 *
 * While an earlier page is being read, the change is made twice: at once,
 * and again when that read ends. A read of a page writes back the pages it
 * found when it started, with the new page added, so it would undo a change
 * made in between. `update` must give the same pages when applied twice.
 */
const updateHeldMessages = async (
  queryClient: QueryClient,
  conversationId: string,
  update: (held: MessagePages) => MessagePages,
): Promise<void> => {
  const queryKey = queryKeys.conversationMessages(conversationId);
  const apply = (): void => {
    // An updater that returns undefined leaves the cache as it is, and
    // creates no entry.
    queryClient.setQueryData<MessagePages>(queryKey, (held) =>
      held === undefined ? undefined : update(held),
    );
  };
  apply();
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  const reading = query?.state.fetchStatus === "fetching" ? query.promise : undefined;
  if (reading === undefined) return;
  await reading.catch(() => undefined);
  apply();
};

/**
 * Merges `newest`, a fresh read of the newest messages, into the pages of the
 * conversation `conversationId` held in `queryClient`, by
 * `mergeNewestMessagePage`. Resolves once the merge is in the cache. Does
 * nothing while no pages are held (see `updateHeldMessages`).
 */
export const storeNewestMessages = (
  queryClient: QueryClient,
  conversationId: string,
  newest: MessagePage,
): Promise<void> =>
  updateHeldMessages(queryClient, conversationId, (held) => mergeNewestMessagePage(held, newest));

/**
 * Stores `message`, which the user has just sent, in the pages of the
 * conversation `conversationId` held in `queryClient`, as
 * `mergeSentMessage` decides:
 *
 * - when it comes right after the newest message held, it is merged into
 *   the newest page;
 * - when more messages were stored since, the newest page is read and
 *   merged instead, because the message alone would leave a gap before it.
 *   When that read fails, nothing is stored: the `conversation` push that
 *   follows every stored message reads the newest page again;
 * - while no pages are held, because the user has left the Conversation,
 *   nothing is stored.
 *
 * Resolves once the message is in the cache, or nothing will be stored.
 */
export const storeSentMessage = async (
  queryClient: QueryClient,
  client: HerculeClient,
  conversationId: string,
  message: ConversationMessage,
): Promise<void> => {
  const held = queryClient.getQueryData<MessagePages>(
    queryKeys.conversationMessages(conversationId),
  );
  const merge = mergeSentMessage(held, message);
  if (merge.kind === "nothing-held") return;
  if (merge.kind === "merged") {
    await updateHeldMessages(queryClient, conversationId, (pages) => {
      const again = mergeSentMessage(pages, message);
      return again.kind === "merged" ? again.pages : pages;
    });
    return;
  }
  const newest = await readMessagePage(client, conversationId, undefined).catch(() => null);
  if (newest !== null) await storeNewestMessages(queryClient, conversationId, newest);
};

/**
 * Reads the rows of a session's running turn, oldest first: the rows from its
 * newest `turn.started` on, or every row when the session has none. An
 * assistant's Conversation draws the reply being written from them.
 *
 * The transcript is read newest first, a page at a time, and the read stops
 * at the page that holds the newest `turn.started`. A long conversation then
 * costs one or two pages, not its whole history.
 *
 * After this read, only the live connection changes the cached rows:
 * `useSessionLive` merges each row the session's stream delivers, trimmed by
 * `trimToRunningTurn` so the entry keeps holding the running turn alone
 * when the next turn starts, and reads the rows again when the stream
 * reports a reset. The rows are dropped when the Conversation showing the
 * session unmounts.
 */
export const runningTurnQuery = (client: HerculeClient, sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.runningTurn(sessionId),
    queryFn: async (): Promise<readonly TranscriptRow[]> => {
      const rowsNewestFirst: TranscriptRow[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await client.transcript.read({
          params: { id: sessionId },
          query: {
            sort: [{ field: "position", direction: "desc" }],
            limit: MAX_PAGE_LIMIT,
            ...(cursor === undefined ? {} : { cursor }),
          },
        });
        rowsNewestFirst.push(...page.items);
        const collected = collectRunningTurnRows(rowsNewestFirst);
        if (collected.reachedTurnStart || page.nextCursor === undefined) return collected.rows;
        cursor = page.nextCursor;
      }
    },
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/** Reads the signed-in user's name, for the sidebar's foot and Settings > Profile. */
export const userQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.user(),
    queryFn: () => client.user.read(),
    ...SHELL_READ_OPTIONS,
  });

/**
 * Reads a stored image, one a user sent or one a tool returned, at full
 * size, as a `Blob`, for the lightbox. An image never changes once
 * uploaded, so the entry never goes stale. It is dropped a minute after the
 * lightbox closes, so a full-size image is not held after it is shown.
 *
 * An upload puts its file here as soon as it succeeds, so the image the user
 * just sent is not read back from the controller.
 */
export const attachmentContentQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.attachmentContent(id),
    queryFn: () => client.readAttachmentContent(id),
    staleTime: Infinity,
    gcTime: 60_000,
  });

/**
 * Builds a thumbnail of a stored image, `width` × `height` device pixels,
 * for the images above a user's bubble, in a queued input's row, and under
 * a tool's step.
 * Only the small WebP is cached: the image's full bytes are taken from the
 * cache when an upload left them there, and read from the controller
 * otherwise, and are dropped once the thumbnail is built.
 *
 * Like the image, the thumbnail never goes stale, and it is dropped a minute
 * after no row shows it. A build that no row waits for any more is cancelled
 * before it decodes the image. A failed build is not tried again: an image
 * Chromium cannot decode does not change.
 */
export const attachmentThumbnailQuery = (
  client: HerculeClient,
  queryClient: QueryClient,
  id: string,
  width: number,
  height: number,
) =>
  queryOptions({
    queryKey: [...queryKeys.attachmentContent(id), "thumbnail", width, height] as const,
    queryFn: async ({ signal }) => {
      const content =
        queryClient.getQueryData(attachmentContentQuery(client, id).queryKey) ??
        (await client.readAttachmentContent(id));
      return buildThumbnail(content, width, height, signal);
    },
    staleTime: Infinity,
    gcTime: 60_000,
    retry: false,
  });

/**
 * Reads one thread's session, for the thread screen. A push on the `session`
 * topic that names the thread reads it again. Fails with a `not_found`
 * `ApiError` when no such session exists.
 */
export const sessionQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.session(id),
    queryFn: () => client.session.read({ params: { id } }),
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads one signal for Intake's pane. Unlike the To do list, `signal.read`
 * carries the describe line of each action of an open signal. A push on the
 * `signal` topic that names the signal reads it again. Fails with a
 * `not_found` `ApiError` when no such signal exists.
 */
export const signalQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.signal(id),
    queryFn: () => client.signal.read({ params: { id } }),
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * What the Everything view narrows its events by. A field is `undefined` or
 * empty when that filter is off, so a caller passes the URL's values as they
 * are.
 */
export interface EverythingFilter {
  readonly text?: EventListFilter["text"] | undefined;
  readonly source?: EventListFilter["source"] | undefined;
  readonly handling?: EventHandling | undefined;
}

/**
 * Reads Intake's Everything view page by page, newest first: the events
 * Intake covers, received since `since`, with the facts their handlings are
 * drawn from, narrowed by `filter`. Not a live topic: the log is append-only,
 * so Intake reads it again each time it opens, see `readInfiniteOnOpen`.
 *
 * `since` is the start of the retention horizon. It is not part of the key,
 * because it moves with the clock and a listing is read again from its first
 * page on every opening anyway.
 */
export const eventsEverythingQuery = (
  client: HerculeClient,
  filter: EverythingFilter,
  since: string,
) => {
  const listing: EventListFilter = {
    intake: true,
    ...(filter.text === undefined || filter.text === "" ? {} : { text: filter.text }),
    ...(filter.source === undefined || filter.source === "" ? {} : { source: filter.source }),
    ...(filter.handling === undefined ? {} : { handling: [filter.handling] }),
  };
  return infiniteQueryOptions({
    queryKey: queryKeys.events(listing),
    queryFn: ({ pageParam }) =>
      client.event.query({
        query: { ...listing, since, ...(pageParam === undefined ? {} : { cursor: pageParam }) },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    retry: isWorthRetrying,
    ...READ_ON_OPEN_OPTIONS,
  });
};

/**
 * Reads the first page of the infinite `options` once for this opening of a
 * screen, as `readOnOpen` does for a plain read, and resolves when it is
 * done.
 *
 * A listing already held starts again from its first page: later pages are
 * dropped, so the opening reads one page and not every page the last visit
 * scrolled through. The first page shows at once and is read again behind.
 *
 * Never fails. A listing that cannot be read is drawn by the screen as an
 * error of its own, with a way to try again, rather than failing the route,
 * which would replace the whole screen. The read is made once here; the screen
 * tries it again when it mounts.
 */
export const readInfiniteOnOpen = async <Page, PageParam>(
  queryClient: QueryClient,
  options: EnsureInfiniteQueryDataOptions<Page, Error, Page, QueryKey, PageParam>,
): Promise<void> => {
  queryClient.setQueryData(options.queryKey, (held: InfiniteData<Page, PageParam> | undefined) =>
    held === undefined || held.pages.length < 2
      ? held
      : { pages: held.pages.slice(0, 1), pageParams: held.pageParams.slice(0, 1) },
  );
  void queryClient.invalidateQueries({ queryKey: options.queryKey, refetchType: "none" });
  try {
    await queryClient.ensureInfiniteQueryData({
      ...options,
      revalidateIfStale: true,
      retry: false,
    });
  } catch {
    // The screen reads the failure from the query.
  }
};

/**
 * Reads one event, for the address Intake's pane opens a signal at on its
 * source. The event log is append-only, so the read is made once and kept.
 */
export const eventQuery = (client: HerculeClient, id: number) =>
  queryOptions({
    queryKey: queryKeys.event(id),
    queryFn: () => client.event.read({ params: { id } }),
    retry: isWorthRetrying,
    staleTime: Infinity,
  });

/**
 * Reads the Discussions, newest Post first, a page at a time, for the
 * Discussions list. The list reads the next page only when the user scrolls
 * to the end of the last. A push on the `discussion` topic, which the
 * Discussions pages hold while they are open, reads the pages read so far
 * again.
 */
export const discussionsQuery = (client: HerculeClient) =>
  infiniteQueryOptions({
    queryKey: queryKeys.discussions(),
    queryFn: ({ pageParam }) =>
      client.discussion.query({ query: pageParam === undefined ? {} : { cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads one Discussion with its Posts, oldest first, for the open
 * Discussion. A push on the `discussion` topic that names it reads it again.
 */
export const discussionQuery = (client: HerculeClient, discussionId: string) =>
  queryOptions({
    queryKey: queryKeys.discussion(discussionId),
    queryFn: () => client.discussion.read({ params: { id: discussionId }, query: {} }),
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads the wiki pages, last changed first, a page at a time, for the Wiki
 * list. The list reads the next page only when the user scrolls to the end
 * of the last. A push on the `wikiPage` topic, which the Wiki pages hold
 * while they are open, reads the pages read so far again.
 */
export const wikiPagesQuery = (client: HerculeClient) =>
  infiniteQueryOptions({
    queryKey: queryKeys.wikiPages(),
    queryFn: ({ pageParam }) =>
      client.wikiPage.query({ query: pageParam === undefined ? {} : { cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads one wiki page with its newest revisions, for the open page: the
 * current page, or with `revision` that older revision of it. A push on the
 * `wikiPage` topic that names the page reads both again, because the
 * page's key is the prefix of its revisions' keys.
 */
export const wikiPageQuery = (client: HerculeClient, pageId: string, revision?: number) =>
  queryOptions({
    queryKey: queryKeys.wikiPage(pageId, revision),
    queryFn: () =>
      client.wikiPage.read({
        params: { id: pageId },
        query: revision === undefined ? {} : { revision },
      }),
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads the session whose agent sent a message into a thread, or queued one
 * there, so the message can name its sender. Holds null when the sender
 * cannot be read, as `readSenderSession` says; the message then shows as from
 * "Another agent". Any other error fails the read, and the screen shows the
 * same "Another agent".
 *
 * This is the read for a sender the shell's session lists do not hold, such
 * as an archived or deleted session (see `useSenderReading`). A sender in
 * those lists is read from them instead: they follow `session` pushes, so a
 * title generated after the session started shows up, and they cost no
 * request.
 *
 * This read is made once per sender and kept. It is not a live read: its
 * key, `queryKeys.sender`, is outside the `session` prefix, so no push reads
 * it again, and a sender's title may be generated after it was read. That
 * is accepted for a session the lists do not hold, which no longer changes
 * or is out of reach. Being fresh forever, it is not read again on focus or
 * reconnect either, once it holds data. The web app reads it the same way.
 *
 * A read that fails is not tried again, neither at once nor when the next
 * message from the same sender mounts: a read that fails for a network error
 * or a 5xx would otherwise be made again by every message and queued row that
 * shows the sender, each time one mounts. The thread's loader skips a sender
 * whose read failed, for the same reason.
 */
export const senderSessionQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.sender(id),
    queryFn: () => readSenderSession(client, id),
    staleTime: Infinity,
    retry: false,
    // Without data, a mounting component reads the query again whatever its
    // `staleTime`; this option alone stops that after an error.
    retryOnMount: false,
    // Without data the query is stale, so focus would read it again too.
    refetchOnWindowFocus: false,
  });

/**
 * Reads one agent's whole transcript, oldest first, page by page until the
 * last one, because the thread screen draws every row. Without `subagentId`
 * it reads the session's own agent; with it, that subagent's transcript.
 *
 * After this read, only the live connection changes the cached transcript:
 * `useSessionLive` merges each row the agent's `:stream` topic delivers, and
 * reads the transcript again when the stream reports a reset. The `session`
 * topic never invalidates it, and it is never read again in the background: a
 * read that raced a merge could replace the cache with rows older than the
 * ones the merge had just added.
 */
export const transcriptQuery = (client: HerculeClient, sessionId: string, subagentId?: string) =>
  queryOptions({
    queryKey: queryKeys.transcript(sessionId, subagentId),
    queryFn: () =>
      readEveryPage((page) =>
        client.transcript.read({
          params: { id: sessionId },
          query: subagentId === undefined ? page : { ...page, subagentId },
        }),
      ),
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads every subagent of one session, oldest first. Every page is read,
 * because the Subagents surface draws the whole tree and a list cut short
 * would hide subagents without telling the user. While a thread is open, the
 * `subagent` live topic reads it again whenever one of its subagents changes
 * (see `useSubagentsLive`).
 */
export const subagentsQuery = (client: HerculeClient, sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.subagents(sessionId),
    queryFn: () =>
      readEveryPage((page) =>
        client.session.querySubagents({ params: { id: sessionId }, query: page }),
      ),
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads a thread's queued inputs, oldest first: the inputs the controller
 * still holds for delivery when the running turn ends. A push on the
 * `session` topic that names the thread reads them again.
 *
 * `input.query` lists the session's whole input history and cannot filter by
 * status, so this reads one page of the newest inputs and keeps the queued
 * ones. A queue drains oldest first, so the queued inputs are always among
 * the newest; reading from the oldest end, as the web app does, would lose
 * them once a thread has had more inputs than fit on a page.
 */
export const queuedInputsQuery = (client: HerculeClient, sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.inputs(sessionId),
    queryFn: async (): Promise<readonly Input[]> => {
      const page = await client.input.query({
        params: { id: sessionId },
        query: { limit: MAX_PAGE_LIMIT, sort: [{ field: "createdAt", direction: "desc" }] },
      });
      return page.items.filter((input) => input.status === "queued").reverse();
    },
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads everything the shell shows into `queryClient`: the sidebar's records,
 * the live sessions an Agent spawned, for "From runs" in Waiting on you, the
 * assistants and the current session of each one's main conversation, the
 * Connections, the signed-in user, Intake's To do list, whose count the
 * Hercule segment shows, and the plugins that name each signal's source.
 * Resolves once every read is cached,
 * and fails with the first read that fails.
 *
 * The current sessions can only be read once the assistants are, because
 * each read names an assistant's main conversation. They start as soon as
 * the assistants arrive, without waiting for the other reads.
 *
 * The New project form and the starter threads read the Connections, to know
 * whether a GitHub Connection exists, and the sidebar's System section reads
 * them for the Connections row's red dot, so none of them waits for them.
 *
 * Every read it loads uses `SHELL_READ_OPTIONS`, so it stays cached for the
 * life of the window, whichever screens and sidebar face are showing.
 *
 * The shell's loader calls it, and so does a test that renders one part of a
 * screen alone, so the part finds the same records cached as in the app.
 */
export const ensureShellData = async (
  queryClient: QueryClient,
  client: HerculeClient,
): Promise<void> => {
  await Promise.all([
    queryClient.ensureQueryData(threadsQuery(client)),
    queryClient.ensureQueryData(liveAgentSessionsQuery(client)),
    queryClient.ensureQueryData(projectsQuery(client)),
    queryClient.ensureQueryData(workspacesQuery(client)),
    queryClient.ensureQueryData(resourcesQuery(client)),
    queryClient.ensureQueryData(runnersQuery(client)),
    queryClient.ensureQueryData(providersQuery(client)),
    queryClient.ensureQueryData(connectionsQuery(client)),
    queryClient.ensureQueryData(userQuery(client)),
    queryClient.ensureQueryData(signalsToDoQuery(client)),
    queryClient.ensureQueryData(snoozeTimerQuery(client)),
    queryClient.ensureQueryData(pluginsQuery(client)),
    queryClient
      .ensureQueryData(assistantsQuery(client))
      .then((assistants) =>
        Promise.all(
          assistants.map(({ mainConversationId }) =>
            queryClient.ensureQueryData(
              currentConversationSessionQuery(client, mainConversationId),
            ),
          ),
        ),
      ),
  ]);
};

/**
 * Reads everything the first run shows once the user has an account into
 * `queryClient`: the records its steps and its room are drawn from, the
 * signed-in user and their settings, and what main keeps of the first run.
 * Resolves once every read is cached, and fails with the first read that
 * fails.
 *
 * The first run's loader calls it when it resumes a first run, and its
 * account step calls it right after setup, so the next step never waits.
 */
export const ensureFirstRunData = async (
  queryClient: QueryClient,
  client: HerculeClient,
  bridge: Bridge,
): Promise<void> => {
  await Promise.all([
    queryClient.ensureQueryData(controllerQuery(client)),
    queryClient.ensureQueryData(runnersQuery(client)),
    queryClient.ensureQueryData(providersQuery(client)),
    queryClient.ensureQueryData(connectionsQuery(client)),
    queryClient.ensureQueryData(projectsQuery(client)),
    queryClient.ensureQueryData(assistantsQuery(client)),
    queryClient.ensureQueryData(resourcesQuery(client)),
    queryClient.ensureQueryData(userQuery(client)),
    queryClient.ensureQueryData(settingsQuery(client)),
    queryClient.ensureQueryData(firstRunQuery(bridge)),
  ]);
};

/**
 * Reads the permission profiles once for this opening of a screen, as
 * `readOnOpen` does, when `session` has an open Permission Request, and
 * does nothing otherwise. The Requests dock names the session's profile in
 * the "Add to profile" answer, and the read lets it do so at the first paint.
 * A screen with no Permission Request open makes no read: the dock reads the
 * profiles itself when one opens later.
 *
 * Never fails. A failed read must not keep the thread or the Conversation
 * from opening: the dock then shows the answer without its line.
 */
const readProfilesForPermissionRequests = async (
  queryClient: QueryClient,
  client: HerculeClient,
  session: Session,
): Promise<void> => {
  if (session.openPermissionRequests.length === 0) return;
  await readOnOpen(queryClient, profilesQuery(client)).catch(() => {});
};

/**
 * Reads what a step session's header draws of its run into `queryClient`: the
 * run, its workflow and the settings, whose time zone the run's start time
 * is shown in. Resolves when the reads end.
 *
 * Never fails. A run that cannot be read, such as one that was deleted, must
 * not keep the session from opening: its header then shows only the
 * Workflows crumb.
 */
const prefetchRunCrumbData = async (
  queryClient: QueryClient,
  client: HerculeClient,
  runId: string,
): Promise<void> => {
  const run = runQuery(client, runId);
  await Promise.all([
    queryClient.prefetchQuery(run),
    queryClient.prefetchQuery(settingsQuery(client)),
  ]);
  const workflowId = queryClient.getQueryData(run.queryKey)?.workflowId;
  if (workflowId !== undefined && workflowId !== null) {
    await prefetchRunWorkflow(queryClient, client, workflowId);
  }
};

/**
 * Reads everything the thread's own agent's page shows of the thread
 * `sessionId` into `queryClient`: its session, its subagents, its whole
 * transcript and its queued inputs, and the session of each agent that sent
 * a message into the transcript or queued one, once per sender. Resolves once
 * the thread's own four reads are cached, and fails with the first of them
 * that fails, such as a `not_found` `ApiError` when no such session exists.
 *
 * The senders' reads start as soon as the transcript and the queued inputs
 * have arrived, and the returned promise waits for them for at most
 * `OPTIONAL_READ_WAIT_MS`, so a sender that answers in time is named at the
 * first paint, and a controller that never answers a sender's read cannot
 * keep the thread from opening. A sender whose read is still running after
 * that is named when it answers; until then its messages and queued rows
 * hold the sender's place (see `useSenderReading`). A sender's read never
 * fails the thread, and a sender whose read already failed is not read
 * again. The assistants a sender may answer for are shell data, already
 * cached.
 *
 * When the session has an open Permission Request, it also reads the
 * permission profiles, for the name the dock's "Add to profile" answer
 * shows (see `readProfilesForPermissionRequests`). When it is a run's step
 * session, it reads the run and its workflow for the header's crumb (see
 * `prefetchRunCrumbData`), waiting for them at most `OPTIONAL_READ_WAIT_MS`
 * like the senders: the crumbs fill in when the reads answer.
 *
 * The thread's loader calls it, and so do the Office, whose drawer shows the
 * thread's page outside the thread's route, and a test that renders one
 * part of the page alone.
 */
export const ensureThreadData = async (
  queryClient: QueryClient,
  client: HerculeClient,
  sessionId: string,
): Promise<void> => {
  const transcript = queryClient.ensureQueryData(transcriptQuery(client, sessionId));
  const inputs = queryClient.ensureQueryData(queuedInputsQuery(client, sessionId));
  const senders = Promise.all([transcript, inputs]).then(
    ([rows, queued]) => readSenders(queryClient, client, collectSenderSessionIds(rows, queued)),
    // The thread's own reads fail through the promises awaited below.
    () => {},
  );
  await Promise.all([
    queryClient
      .ensureQueryData(sessionQuery(client, sessionId))
      .then((session) =>
        Promise.all([
          readProfilesForPermissionRequests(queryClient, client, session),
          session.runId === null
            ? undefined
            : waitForOptionalReads([prefetchRunCrumbData(queryClient, client, session.runId)]),
        ]),
      ),
    queryClient.ensureQueryData(subagentsQuery(client, sessionId)),
    transcript,
    inputs,
    senders,
  ]);
};

/**
 * Reads the session of each agent in `senderSessionIds` that the shell's
 * session lists do not hold, once per sender, so the screen can name it (see
 * `useSenderReading`). A sender in those lists needs no read: the screen
 * names it from the list. Resolves when the reads settle, or after
 * `OPTIONAL_READ_WAIT_MS` (`waitForOptionalReads`), and never fails. A sender
 * whose read already failed is not read again.
 *
 * The lists are awaited first, because a route's loader may run before the
 * shell's loader has cached them. Awaiting shares the shell's read instead
 * of starting another. If a list cannot be read, its sessions are read one
 * by one.
 *
 * A thread, an open Discussion and an open wiki page wait here before they
 * render, so the agents they show are named at the first paint, and a
 * controller that never answers cannot keep them from opening.
 */
export const readSenders = (
  queryClient: QueryClient,
  client: HerculeClient,
  senderSessionIds: readonly string[],
): Promise<void> =>
  waitForOptionalReads([
    (async () => {
      const lists = await Promise.all([
        queryClient.ensureQueryData(threadsQuery(client)).catch((): readonly Session[] => []),
        queryClient
          .ensureQueryData(liveAgentSessionsQuery(client))
          .catch((): readonly Session[] => []),
      ]);
      const listedIds = new Set(lists.flat().map((session) => session.id));
      await Promise.allSettled(
        senderSessionIds
          .filter((id) => !listedIds.has(id))
          .map((id) => senderSessionQuery(client, id))
          .filter((sender) => queryClient.getQueryState(sender.queryKey)?.status !== "error")
          .map((sender) => queryClient.prefetchQuery(sender)),
      );
    })(),
  ]);

/**
 * Reads what the Conversation of the assistant `assistantId` draws, unless
 * the cache holds it already: the assistants, the runners, the current
 * session of its main conversation, the newest page of its messages and,
 * when a session has started, the rows of its running turn.
 *
 * Returns false, after reading the assistants, when no assistant has the
 * id. Fails when one of the reads fails.
 *
 * The assistant's route calls it, and so does the Office, whose drawer shows
 * the Conversation outside that route, so neither suspends while it draws.
 */
export const ensureConversationData = async (
  queryClient: QueryClient,
  client: HerculeClient,
  assistantId: string,
): Promise<boolean> => {
  const [assistants] = await Promise.all([
    queryClient.ensureQueryData(assistantsQuery(client)),
    queryClient.ensureQueryData(runnersQuery(client)),
  ]);
  const assistant = assistants.find((each) => each.id === assistantId);
  if (assistant === undefined) return false;
  const conversationId = assistant.mainConversationId;
  const [session] = await Promise.all([
    queryClient.ensureQueryData(currentConversationSessionQuery(client, conversationId)),
    queryClient.ensureInfiniteQueryData(conversationMessagesQuery(client, conversationId)),
  ]);
  if (session !== null) {
    await Promise.all([
      queryClient.ensureQueryData(runningTurnQuery(client, session.id)),
      readProfilesForPermissionRequests(queryClient, client, session),
    ]);
  }
  return true;
};
