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
import {
  listLoopbackEndpoints,
  queryKeys,
  RUNNING_STATUSES,
  type HerculeClient,
} from "@hercule/client-core";
import {
  MAX_PAGE_LIMIT,
  type Runner,
  type TaskFilter,
  type TranscriptRow,
} from "@hercule/contract";

/** Whether first run has been completed. Reachable without a token. */
export const setupQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.setup(),
    queryFn: () => client.setup.read(),
    staleTime: Infinity,
    retry: false,
  });

/** The settings store, both scopes. The user scope carries onboarding progress. */
export const settingsQuery = (client: HerculeClient) =>
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
export const tasksQuery = (client: HerculeClient, filter: TaskFilter) =>
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
export const taskQuery = (client: HerculeClient, id: string) =>
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
export const projectsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.projects(),
    queryFn: () => client.project.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * Every resource, as one page: the repos the workspace menu offers checkouts
 * of. A handful per project, so the whole set is one answer, like the projects
 * above it.
 */
export const resourcesQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.resources(),
    queryFn: () => client.resource.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * Every workspace, as one page: what the composer's menu lists, what the
 * sidebar groups by, and where the branch lists come from. Disposed ones are
 * read along with the rest - a thread that ended in one still names it.
 */
export const workspacesQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.workspaces(),
    queryFn: () => client.workspace.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * One workspace on its own, polled while it is being made: provisioning is the
 * machine's own work and nothing pushes its end, so the form that started it
 * asks again every second until the machine has said either way.
 */
export const workspaceQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.workspace(id),
    queryFn: () => client.workspace.read({ params: { id } }),
    refetchInterval: (query) =>
      query.state.data?.status === "provisioning" ? WORKSPACE_POLL_MS : false,
    retry: false,
  });

/** How often a workspace being made is asked about again. */
const WORKSPACE_POLL_MS = 400;

/**
 * The fleet, as one page. A fleet is a handful of machines and the screen shows
 * all of them, so nothing follows the cursor; a fleet past one page would lose
 * rows silently, and is the point at which this grows a listing of its own.
 */
export const runnersQuery = (client: HerculeClient) =>
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
export const runnerQuery = (client: HerculeClient, id: string) =>
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
export const sessionQuery = (client: HerculeClient, id: string) =>
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
export const transcriptQuery = (client: HerculeClient, sessionId: string) =>
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
 * The page is 500 rows ascending and its readers filter to `queued`
 * themselves, because `input.query` has no status filter; a thread past 500
 * inputs would stop showing its queued ones, which is when this grows one.
 */
export const inputsQuery = (client: HerculeClient, sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.inputs(sessionId),
    queryFn: () =>
      client.input.query({ params: { id: sessionId }, query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * The join tokens still outstanding. A token lives an hour and is spent by one
 * machine, so this is a handful at most and the whole set is one answer.
 */
export const joinTokensQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.joinTokens(),
    queryFn: () => client.runner.queryJoinTokens(),
  });

/**
 * Every plugin the binary was built with, which is the whole set: the registry
 * is compiled in, so there is nothing to page through or narrow by.
 */
export const pluginsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.plugins(),
    queryFn: () => client.plugin.query(),
  });

/**
 * Every secret reference, as one page. A reference is what a read carries -
 * never a value - and there are as many of them as there are connections and
 * plugins, so the whole set is one answer.
 */
export const secretsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.secrets(),
    queryFn: () => client.secret.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * Every connection, as one page. A connection is an account the user set up by
 * hand, so there are a handful; the screen shows all of them, and the point at
 * which they outgrow one page is the point at which this grows a listing.
 */
export const connectionsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.connections(),
    queryFn: () => client.connection.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

export const providersQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.providers(),
    queryFn: () => client.provider.query(),
  });

/**
 * Every session, as one page. The sidebar and All sessions both read the whole
 * set - the point at which a fleet's threads outgrow one page is the point at
 * which this grows a listing of its own, same as the fleet above.
 */
export const sessionsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.sessions(),
    queryFn: () => client.session.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * One machine's live sessions: the runner page reads both its capacity
 * (`starting | idle | busy`) and its queue (`queued`) from the same list, so
 * it is fetched once rather than once per status. `exited` is never read
 * here: a machine that has run hundreds of sessions would otherwise exceed
 * `MAX_PAGE_LIMIT` and the running count would go wrong. Built from
 * `RUNNING_STATUSES` rather than named again, so the fetch and the capacity
 * line it feeds cannot drift apart.
 */
export const runnerSessionsQuery = (client: HerculeClient, runnerId: string) =>
  queryOptions({
    queryKey: queryKeys.sessions({ runnerId }),
    queryFn: () =>
      client.session.query({
        query: { runnerId, status: ["queued", ...RUNNING_STATUSES], limit: MAX_PAGE_LIMIT },
      }),
  });

/**
 * The permission profiles, for the Settings > Threads profile field. Not a
 * live topic, so nothing but this browser's own write ever moves it.
 */
export const profilesQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.profiles(),
    queryFn: () => client.profile.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * The controller itself: its identity, its version and the runner work falls
 * back to. The version is what a runner's own is compared against, so it is
 * read rather than assumed to match.
 */
export const controllerQuery = (client: HerculeClient) =>
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
      listLoopbackEndpoints(runners).map(({ id, port }) => `${id}:${String(port)}`),
    ),
    queryFn: () => detect(runners),
    retry: false,
  });

/**
 * Reads every workflow in a single page. Users write workflows by hand, so
 * there are few of them. If they ever outgrow one page, this query needs
 * paging.
 */
export const workflowsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.workflows(),
    queryFn: () => client.workflow.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * Reads one workflow, including its YAML source. An error is not retried,
 * because a workflow that returns 404 once will keep returning 404.
 */
export const workflowQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.workflow(id),
    queryFn: () => client.workflow.read({ params: { id } }),
    retry: false,
  });

/**
 * Asks the controller to validate a workflow's source, with the same checks a
 * save runs. Returns the errors and warnings together with the source they
 * belong to. The page keeps showing the previous result while the next source
 * is validated, and compares the sources to know which result it is showing.
 *
 * A failed request is not retried: the page shows why it failed, and
 * validates again when the live connection comes back. Window focus does not
 * trigger a refetch either, because the page only validates after the user
 * stops typing or after a failure.
 */
export const workflowValidationQuery = (client: HerculeClient, source: string) =>
  queryOptions({
    queryKey: queryKeys.workflowValidation(source),
    queryFn: async () => ({
      source,
      issues: await client.workflow.validate({ payload: { source } }),
    }),
    retry: false,
    refetchOnWindowFocus: false,
  });

/** Reads every action a step can use. The editor suggests them after `action:`. */
export const workflowActionsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.workflowActions(),
    queryFn: () => client.workflowAction.query(),
  });

/** Reads every event kind a trigger can use. The editor suggests them after `kind:`. */
export const eventKindsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.eventKinds(),
    queryFn: () => client.eventKind.query(),
  });

/**
 * Reads every Agent in a single page. The editor suggests them after
 * `agent:`. Users write Agents by hand, so there are few of them.
 */
export const agentsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.agents(),
    queryFn: () => client.agent.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });
