/**
 * Every read the app makes, as query options.
 *
 * The query keys come from `client-core`, so the desktop app and the web app
 * key the same reads the same way, and a live push lists the keys the cache
 * uses.
 */
import { queryOptions } from "@tanstack/react-query";
import { ApiError, queryKeys, type HerculeClient } from "@hercule/client-core";
import { MAX_PAGE_LIMIT, type Input } from "@hercule/contract";

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

/** One page of a list, as every list operation returns it. */
interface Page<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly nextCursor?: string;
}

/**
 * Reads a list page by page, passing each page's cursor to the next read,
 * and returns every item. Fails when any page's read fails.
 *
 * The sidebar needs every record a label can come from. A list cut off after
 * its first page would leave threads without their workspace's label and
 * nothing would say so, and the workspace list grows with every thread that
 * gets a worktree of its own.
 */
const readEveryPage = async <Item>(
  readPage: (page: { readonly limit: number; readonly cursor?: string }) => Promise<Page<Item>>,
): Promise<ReadonlyArray<Item>> => {
  const items: Item[] = [];
  let cursor: string | undefined;
  do {
    const page = await readPage(
      cursor === undefined ? { limit: MAX_PAGE_LIMIT } : { limit: MAX_PAGE_LIMIT, cursor },
    );
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return items;
};

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

/** Reads the signed-in user's name, for the sidebar's foot. */
export const userQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.user(),
    queryFn: () => client.user.read(),
    ...LIVE_KEPT_READ_OPTIONS,
  });

/**
 * Checks whether a failed read of one thread's records is worth trying again.
 * Returns `true` for the first three failures that got no answer from the
 * controller, such as a dropped connection, and `false` for an `ApiError`.
 *
 * An `ApiError` is the controller's answer, and asking again gets the same
 * answer: a thread that does not exist keeps not existing, and a read that is
 * forbidden stays forbidden. The not-found screen and the render failure then
 * show at once, rather than after several seconds of retries.
 */
const isWorthRetrying = (failureCount: number, error: Error): boolean =>
  !(error instanceof ApiError) && failureCount < 3;

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
 * Reads a thread's whole transcript, oldest first, page by page until the
 * last one, because the thread screen draws every row.
 *
 * After this read, only the live connection changes the cached transcript:
 * `useThreadLive` merges each row `session:<id>:stream` delivers, and reads
 * the transcript again when the stream reports a reset. The `session` topic
 * never invalidates it, and it is never read again in the background: a read
 * that raced a merge could replace the cache with rows older than the ones
 * the merge had just added.
 */
export const transcriptQuery = (client: HerculeClient, sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.transcript(sessionId),
    queryFn: () =>
      readEveryPage((page) => client.transcript.read({ params: { id: sessionId }, query: page })),
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
        query: { limit: MAX_PAGE_LIMIT, sort: { field: "createdAt", direction: "desc" } },
      });
      return page.items.filter((input) => input.status === "queued").reverse();
    },
    retry: isWorthRetrying,
    ...LIVE_KEPT_READ_OPTIONS,
  });
