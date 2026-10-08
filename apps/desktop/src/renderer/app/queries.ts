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
  type EnsureQueryDataOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import {
  ApiError,
  collectRunningTurnRows,
  detectLocalRunner,
  mergeNewestMessagePage,
  mergeSentMessage,
  queryKeys,
  readEveryPage,
  type HerculeClient,
  type MessagePage,
  type MessagePages,
} from "@hercule/client-core";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type ConversationMessage,
  type Input,
  type Runner,
  type Session,
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
    ...LIVE_KEPT_READ_OPTIONS,
  });

/** Reads every project, for the sidebar's project headers. */
export const projectsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.projects(),
    queryFn: () => readEveryPage((page) => client.project.query({ query: page })),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads every workspace, disposed ones included, because a thread that ended
 * in one is still labelled with it.
 */
export const workspacesQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.workspaces(),
    queryFn: () => readEveryPage((page) => client.workspace.query({ query: page })),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/** Reads every resource. A main workspace is labelled with its repo's name. */
export const resourcesQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.resources(),
    queryFn: () => readEveryPage((page) => client.resource.query({ query: page })),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/** Reads every runner. A thread on a runner that is offline is drawn as away. */
export const runnersQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.runners(),
    queryFn: () => readEveryPage((page) => client.runner.query({ query: page })),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/** Reads every provider instance, whose catalogs name the model a thread runs. */
export const providersQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.providers(),
    queryFn: () => client.provider.query(),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * The options of a read that no live topic covers: the settings, the
 * permission profiles and the controller's record. Such a read is fetched again each time a screen that
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

/** Reads every permission profile, one of which a new thread runs under. */
export const profilesQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.profiles(),
    queryFn: () => readEveryPage((page) => client.profile.query({ query: page })),
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
 * No live topic covers it, so Settings > System reads it with `readOnOpen`:
 * its default runner can change from the CLI while the app runs.
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
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads every assistant: for the sidebar, the assistant screen, and the one
 * the first run's room seats in the lobby.
 */
export const assistantsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.assistants(),
    queryFn: () => readEveryPage((page) => client.assistant.query({ query: page })),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Checks whether a failed read of a thread's records, or of an assistant's
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
    ...LIVE_KEPT_READ_OPTIONS,
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
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Reads an image a user sent, at full size, as a `Blob`, for the lightbox.
 * An image never changes once uploaded, so the entry never goes stale. It is
 * dropped a minute after the lightbox closes, so a full-size image is not
 * held after it is shown.
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
 * Builds a thumbnail of an image a user sent, `width` × `height` device
 * pixels, for the images above their bubble and in a queued input's row.
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
 * the assistants and the current session of each one's main conversation,
 * the Connections and the signed-in user. Resolves once every read is cached,
 * and fails with the first read that fails.
 *
 * The current sessions can only be read once the assistants are, because
 * each read names an assistant's main conversation. They start as soon as
 * the assistants arrive, without waiting for the other reads.
 *
 * The New project form and the starter threads read the Connections, to know
 * whether a GitHub Connection exists, so neither waits for them when it opens.
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
    queryClient.ensureQueryData(projectsQuery(client)),
    queryClient.ensureQueryData(workspacesQuery(client)),
    queryClient.ensureQueryData(resourcesQuery(client)),
    queryClient.ensureQueryData(runnersQuery(client)),
    queryClient.ensureQueryData(providersQuery(client)),
    queryClient.ensureQueryData(connectionsQuery(client)),
    queryClient.ensureQueryData(userQuery(client)),
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
 * Reads everything the thread's own agent's page shows of the thread
 * `sessionId` into `queryClient`: its session, its subagents, its whole
 * transcript and its queued inputs.
 * Resolves once every read is cached, and fails with the first read that
 * fails, such as a `not_found` `ApiError` when no such session exists.
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
  await Promise.all([
    queryClient.ensureQueryData(sessionQuery(client, sessionId)),
    queryClient.ensureQueryData(subagentsQuery(client, sessionId)),
    queryClient.ensureQueryData(transcriptQuery(client, sessionId)),
    queryClient.ensureQueryData(queuedInputsQuery(client, sessionId)),
  ]);
};
