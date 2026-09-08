/**
 * Every read the app makes, as query options.
 *
 * The first two are the shell's own: they are answered once per page load and
 * then held, because first run happens once and the settings store changes only
 * through a write this app made, which puts the answer it got back into the
 * cache. Neither retries - a failure there is something the user has to see,
 * not something to sit through. The listings below are ordinary reads, keyed on
 * what narrows them so a filter that has been seen before answers from cache.
 *
 * The keys themselves are `client-core`'s, not this file's: a live push names
 * records, and only builders both sides share can turn that into the keys the
 * cache holds them under.
 */
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { loopbackEndpoints, queryKeys, type HydraClient } from "@hydra/client-core";
import { MAX_PAGE_LIMIT, type Runner, type TaskFilter, type TranscriptRow } from "@hydra/contract";

/** Whether first run has been completed. Reachable without a token. */
export const setupQuery = (client: HydraClient) =>
  queryOptions({
    queryKey: queryKeys.setup(),
    queryFn: () => client.setup.read(),
    staleTime: Infinity,
    retry: false,
  });

/** The settings store, both scopes. The user scope carries onboarding progress. */
export const settingsQuery = (client: HydraClient) =>
  queryOptions({
    queryKey: queryKeys.settings(),
    queryFn: () => client.settings.read(),
    staleTime: Infinity,
    retry: false,
  });

/**
 * One page of tasks after another, under one filter. Paging is followed rather
 * than capped: a listing that stopped at its first page would be hiding tasks
 * without saying so. A narrowed filter holds the rows it had until the new ones
 * arrive, so a list does not blink out from under the reader between keystrokes.
 */
export const tasksQuery = (client: HydraClient, filter: TaskFilter) =>
  infiniteQueryOptions({
    queryKey: queryKeys.tasks(filter),
    queryFn: ({ pageParam }) =>
      client.task.query({
        query: pageParam === undefined ? filter : { ...filter, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: (previous) => previous,
  });

/**
 * One task on its own, which is what the detail drawer reads. A task opened by
 * address is not necessarily on a page the listing has fetched, and a task the
 * user has just edited may have left the listing's filter entirely, so the
 * panel showing it reads it rather than looking it up in a list.
 *
 * A refusal is answered at once rather than retried: a task deleted while the
 * panel is open answers 404 for good, and retrying it behind the reader leaves
 * the panel showing a record the list beside it has already dropped.
 */
export const taskQuery = (client: HydraClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.task(id),
    queryFn: () => client.task.read({ params: { id } }),
    retry: false,
  });

/**
 * Every project, for the pickers that name one. One page: there are few of
 * them, and a task naming a project outside it says the id rather than
 * claiming the task has none.
 */
export const projectsQuery = (client: HydraClient) =>
  queryOptions({
    queryKey: queryKeys.projects(),
    queryFn: () => client.project.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * The fleet, as one page. A fleet is a handful of machines and the screen shows
 * all of them, so nothing follows the cursor; a fleet past one page would lose
 * rows silently, and is the point at which this grows a listing of its own.
 */
export const runnersQuery = (client: HydraClient) =>
  queryOptions({
    queryKey: queryKeys.runners(),
    queryFn: () => client.runner.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * One machine on its own, which is what its page reads. A runner reached by
 * address is not necessarily on a listing this browser has fetched, and the
 * page shows more than a row does, so it is read rather than looked up.
 *
 * A refusal is answered at once rather than retried: a runner that is not there
 * answers 404 for good.
 */
export const runnerQuery = (client: HydraClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.runner(id),
    queryFn: () => client.runner.read({ params: { id } }),
    retry: false,
  });

/**
 * One session on its own, which is what a thread page reads. A refusal is
 * answered at once rather than retried: a session that is not there answers
 * 404 for good.
 */
export const sessionQuery = (client: HydraClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.session(id),
    queryFn: () => client.session.read({ params: { id } }),
    retry: false,
  });

/**
 * A session's whole transcript, oldest first - every row is fetched rather
 * than a page of them, because the thread surface renders every turn it
 * covers. `session:<id>:stream` appends straight to this cache entry as new
 * rows are written, and a `reset` refetches it; neither is TanStack Query's
 * own staleness knowing anything happened, so this entry never goes stale on
 * its own and is never refetched behind those two - a background refetch
 * racing a live append could otherwise win with an answer older than what the
 * append just wrote.
 */
export const transcriptQuery = (client: HydraClient, sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.transcript(sessionId),
    queryFn: async () => {
      const rows: TranscriptRow[] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await client.transcript.read({
          params: { id: sessionId },
          query:
            cursor === undefined ? { limit: MAX_PAGE_LIMIT } : { limit: MAX_PAGE_LIMIT, cursor },
        });
        rows.push(...page.items);
        cursor = page.nextCursor;
        if (cursor === undefined) break;
      }
      return rows;
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

/**
 * A session's input history, queued rows included: the composer's queued list
 * above the textarea. One page, same as the fleet and the session listing
 * above - a thread queues a handful of turns at most, never enough to page.
 */
export const inputsQuery = (client: HydraClient, sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.inputs(sessionId),
    queryFn: () =>
      client.input.query({ params: { id: sessionId }, query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * The join tokens still outstanding. A token lives an hour and is spent by one
 * machine, so this is a handful at most and the whole set is one answer.
 */
export const joinTokensQuery = (client: HydraClient) =>
  queryOptions({
    queryKey: queryKeys.joinTokens(),
    queryFn: () => client.runner.queryJoinTokens(),
  });

/**
 * Every plugin the binary was built with, which is the whole set: the registry
 * is compiled in, so there is nothing to page through or narrow by.
 */
export const pluginsQuery = (client: HydraClient) =>
  queryOptions({
    queryKey: queryKeys.plugins(),
    queryFn: () => client.plugin.query(),
  });

export const providersQuery = (client: HydraClient) =>
  queryOptions({
    queryKey: queryKeys.providers(),
    queryFn: () => client.provider.query(),
  });

/**
 * Every session, as one page. The sidebar and All sessions both read the whole
 * set - the point at which a fleet's threads outgrow one page is the point at
 * which this grows a listing of its own, same as the fleet above.
 */
export const sessionsQuery = (client: HydraClient) =>
  queryOptions({
    queryKey: queryKeys.sessions(),
    queryFn: () => client.session.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * The permission profiles, for the Settings > Threads profile field. Not a
 * live topic, so nothing but this browser's own write ever moves it.
 */
export const profilesQuery = (client: HydraClient) =>
  queryOptions({
    queryKey: queryKeys.profiles(),
    queryFn: () => client.profile.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * The controller itself: its identity, its version and the runner work falls
 * back to. The version is what a runner's own is compared against, so it is
 * read rather than assumed to match.
 */
export const controllerQuery = (client: HydraClient) =>
  queryOptions({
    queryKey: queryKeys.controller(),
    queryFn: () => client.controller.read(),
  });

/**
 * Which listed runner is on the machine this browser is on.
 *
 * Keyed on the machines that could answer and on where each says to ask, so a
 * runner that joined, left or moved its port is asked again while a refetch of
 * the same fleet is not. A refusal is not retried: silence, a hang and a
 * stranger's answer all mean the same thing, and retrying only turns a bounded
 * wait into a longer one.
 */
export const localRunnerQuery = (
  detect: (runners: ReadonlyArray<Runner>) => Promise<string | null>,
  runners: ReadonlyArray<Runner>,
) =>
  queryOptions({
    queryKey: queryKeys.localRunner(
      loopbackEndpoints(runners).map(({ id, port }) => `${id}:${String(port)}`),
    ),
    queryFn: () => detect(runners),
    retry: false,
  });
