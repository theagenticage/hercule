/**
 * Every read the app makes, as query options.
 *
 * The first two queries belong to the shell. They are fetched once per page
 * load and then kept, because first run happens only once, and the settings
 * store changes only through this app's own writes, which put the response
 * into the cache. Neither retries: the user needs to see a failure there, not
 * wait through retries. The list queries below are ordinary reads, keyed on
 * their filters, so a filter that was used before is served from the cache.
 *
 * The query keys come from `client-core`, not from this file. A live push lists
 * changed records, and only key builders that both sides share can turn those
 * records into the keys the cache uses.
 */
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import {
  isNotFound,
  queryKeys,
  readEveryPage,
  readSenderSession,
  RUNNING_STATUSES,
  UNSEEN_COUNT_READ_LIMIT,
  type HerculeClient,
} from "@hercule/client-core";
import {
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
  type RunFilter,
  type Runner,
  type TaskFilter,
} from "@hercule/contract";

/** Reads whether first run has been completed. Works without a token. */
export const setupQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.setup(),
    queryFn: () => client.setup.read(),
    staleTime: Infinity,
    retry: false,
  });

/** Reads the settings store, both scopes. The user scope holds onboarding progress. */
export const settingsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.settings(),
    queryFn: () => client.settings.read(),
    staleTime: Infinity,
    retry: false,
  });

/**
 * Reads the tasks that match one filter, page by page. Every page can be
 * loaded: a list that stopped at its first page would hide tasks without
 * telling the user. When the filter changes, the previous rows stay until the
 * new ones arrive, so the list does not flash empty between keystrokes.
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
 * Reads one task, for the detail drawer. A task opened by URL may not be on a
 * page the list has fetched, and a task the user just edited may no longer
 * match the list's filter, so the drawer reads the task itself instead of
 * looking it up in the list.
 *
 * An error is not retried. A task deleted while the drawer is open keeps
 * returning 404, and retrying in the background would keep the drawer showing
 * a task the list beside it has already dropped.
 */
export const taskQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.task(id),
    queryFn: () => client.task.read({ params: { id } }),
    retry: false,
  });

/**
 * Reads every project in a single page, for the project pickers. There are few
 * projects. If a task's project is not in the page, the task shows the project
 * id instead of claiming it has no project.
 */
export const projectsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.projects(),
    queryFn: () => client.project.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * Reads every resource in a single page: the repos the workspace menu offers
 * checkouts of. There are only a handful per project, as with projects.
 */
export const resourcesQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.resources(),
    queryFn: () => client.resource.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * Reads every workspace in a single page. The composer's menu lists them, the
 * sidebar groups by them, and the branch lists come from them. Disposed
 * workspaces are included, because a thread that ended in one still shows it.
 */
export const workspacesQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.workspaces(),
    queryFn: () => client.workspace.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/** Reads one workspace; its live topic invalidates the query after changes. */
export const workspaceQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.workspace(id),
    queryFn: () => client.workspace.read({ params: { id } }),
    retry: false,
  });

/**
 * Reads the fleet in a single page. A fleet is a handful of machines and the
 * screen shows all of them, so the cursor is not followed. A fleet larger than
 * one page would silently lose rows; at that point this query needs paging.
 */
export const runnersQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.runners(),
    queryFn: () => client.runner.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * Reads one runner, for its page. A runner opened by URL may not be in a list
 * this browser has fetched, and the page shows more than a row does, so the
 * page reads the runner itself instead of looking it up in the list.
 *
 * An error is not retried, because a runner that returns 404 once will keep
 * returning 404.
 */
export const runnerQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.runner(id),
    queryFn: () => client.runner.read({ params: { id } }),
    retry: false,
  });

/**
 * Reads one session, for a thread page. An error is not retried, because a
 * session that returns 404 once will keep returning 404.
 */
export const sessionQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.session(id),
    queryFn: () => client.session.read({ params: { id } }),
    retry: false,
  });

/**
 * Reads the session whose agent sent a message into a thread, or queued one
 * there, so the message can name its sender. Holds null when the sender
 * cannot be read, as `readSenderSession` says; the message then shows as from
 * "another agent". Any other error fails the read, and the screen shows the
 * same "another agent".
 *
 * The read is made once per sender and kept: the sender's name comes from
 * fields that never change, and `queryKeys.sender` is outside the `session`
 * prefix, so no push reads it again, and the messages that mount after the
 * read do not read it again either. The desktop app reads it the same way.
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
  });

/**
 * Reads one agent's whole transcript, oldest first: the session's own agent's
 * without `subagentId`, else that subagent's. Every page is fetched, because
 * an agent's page renders every turn.
 *
 * After the first fetch, only the live connection updates this cache entry:
 * the agent's `:stream` topic appends new rows directly, and a `reset`
 * refetches it. TanStack Query's own staleness knows about neither, so the
 * entry never goes stale on its own and is never refetched in the background.
 * A background refetch that raced a live append could otherwise replace the
 * entry with older data than the append just wrote. A page that opens again
 * catches up without a refetch: its stream subscribes from the last row the
 * entry holds, and the controller replays every row written since.
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
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

/**
 * Reads every subagent of one session, oldest first. Every page is fetched,
 * because the side pane draws the whole tree and a page that stopped early
 * would hide subagents without telling the user. The `subagent` live topic
 * refetches it whenever one of the session's subagents changes.
 */
export const subagentsQuery = (client: HerculeClient, sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.subagents(sessionId),
    queryFn: () =>
      readEveryPage((page) =>
        client.session.querySubagents({ params: { id: sessionId }, query: page }),
      ),
  });

/**
 * Reads a session's input history, including queued inputs, for the queued
 * list above the composer's textarea. It reads a single page, like the fleet
 * and session queries: a thread queues a handful of turns at most.
 *
 * The page holds up to `MAX_PAGE_LIMIT` rows, oldest first, and callers filter
 * to `queued` themselves, because `input.query` has no status filter. A
 * thread with more inputs than that would stop showing its queued ones; at
 * that point `input.query` needs a status filter.
 */
export const inputsQuery = (client: HerculeClient, sessionId: string) =>
  queryOptions({
    queryKey: queryKeys.inputs(sessionId),
    queryFn: () =>
      client.input.query({ params: { id: sessionId }, query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * Reads an uploaded image's bytes as a `Blob`, for a thumbnail in the
 * transcript or the queued list. An image never changes once uploaded, so
 * the entry never goes stale. An image can be up to 10 MB, so the entry is
 * dropped a minute after no screen shows it, rather than after TanStack
 * Query's default of five minutes.
 */
export const attachmentContentQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.attachmentContent(id),
    queryFn: () => client.readAttachmentContent(id),
    staleTime: Infinity,
    gcTime: 60_000,
  });

/**
 * Reads the join tokens that are still unused. A token lasts an hour and is
 * used by one machine, so there are a handful at most.
 */
export const joinTokensQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.joinTokens(),
    queryFn: () => client.runner.queryJoinTokens(),
  });

/**
 * Reads every plugin the binary was built with. The registry is compiled in,
 * so the list is small and has no paging or filters.
 */
export const pluginsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.plugins(),
    queryFn: () => client.plugin.query(),
  });

/**
 * Reads every secret reference in a single page. A read returns references,
 * never secret values. There is about one per connection and plugin, so there
 * are few.
 */
export const secretsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.secrets(),
    queryFn: () => client.secret.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * Reads every connection in a single page. A connection is an account the user
 * set up by hand, so there are a handful, and the screen shows all of them. If
 * they ever outgrow one page, this query needs paging.
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
 * Reads every session in a single page. The sidebar and All sessions both read
 * the whole set. If a fleet's threads ever outgrow one page, this query needs
 * paging, like the fleet query.
 */
export const sessionsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.sessions(),
    queryFn: () => client.session.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * Reads one runner's queued and running sessions. The runner page reads both
 * its capacity (`starting | idle | busy`) and its queue (`queued`) from this
 * one list, so it is fetched once rather than once per status.
 *
 * `exited` sessions are left out: a machine that has run hundreds of sessions
 * would otherwise exceed `MAX_PAGE_LIMIT`, and the running count would be
 * wrong. The statuses come from `RUNNING_STATUSES` rather than being listed
 * again, so this query and the capacity line it feeds cannot drift apart.
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
 * Reads the sessions one run's agent steps started, for the run's page, which
 * names each step's session under its row. A run starts at most one session
 * each time an agent step runs, far fewer than a page holds, so the query
 * does not page.
 */
export const runSessionsQuery = (client: HerculeClient, runId: string) =>
  queryOptions({
    queryKey: queryKeys.sessions({ runId }),
    queryFn: () => client.session.query({ query: { runId, limit: MAX_PAGE_LIMIT } }),
  });

/**
 * Reads the permission profiles, for the profile fields in Settings > Threads
 * and Settings > Assistants.
 * Profiles have no live topic, so only this browser's own writes update them.
 */
export const profilesQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.profiles(),
    queryFn: () => client.profile.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * Reads the controller itself: its identity, its version and the fallback
 * runner. Each runner's version is compared with the controller's, so the
 * version is read rather than assumed to match.
 */
export const controllerQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.controller(),
    queryFn: () => client.controller.read(),
  });

/**
 * Finds which listed runner runs on the same machine as this browser.
 *
 * The key holds each runner's id and loopback port. So the check runs again
 * when a runner joins, leaves or changes its port, but not when the same fleet
 * is refetched. A failure is not retried: no response, a timeout and a
 * response from the wrong runner all mean "no local runner", and retrying
 * would only make a bounded wait longer.
 */
export const localRunnerQuery = (
  detect: (runners: ReadonlyArray<Runner>) => Promise<string | null>,
  runners: ReadonlyArray<Runner>,
) =>
  queryOptions({
    queryKey: queryKeys.localRunner(runners),
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
 * Reads the triggers of one workflow, in a single page: a workflow declares
 * only a handful. The list is empty until the workflow is saved.
 */
export const triggersQuery = (client: HerculeClient, workflowId: string) =>
  queryOptions({
    queryKey: queryKeys.triggers(workflowId),
    queryFn: () => client.trigger.query({ query: { workflowId, limit: MAX_PAGE_LIMIT } }),
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

/**
 * Reads the runs that match one filter, newest first, page by page, like the
 * task list. When the filter changes, the previous rows stay until the new
 * ones arrive, so the list does not flash empty.
 */
export const runsQuery = (client: HerculeClient, filter: RunFilter) =>
  infiniteQueryOptions({
    queryKey: queryKeys.runs(filter),
    queryFn: ({ pageParam }) =>
      client.run.query({
        query: pageParam === undefined ? filter : { ...filter, cursor: pageParam },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: (previous) => previous,
  });

/** Reads every notification, newest first, a page at a time, for the notification center. */
export const notificationsQuery = (client: HerculeClient) =>
  infiniteQueryOptions({
    queryKey: queryKeys.notifications({}),
    queryFn: ({ pageParam }) =>
      client.notification.query({ query: pageParam === undefined ? {} : { cursor: pageParam } }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });

/**
 * Reads the notifications created at or after `since`, or all of them without
 * it, up to one more than the sidebar shows as a number. The sidebar counts
 * them; the count needs only the length of this one page.
 */
export const unseenNotificationsQuery = (client: HerculeClient, since: string | undefined) =>
  queryOptions({
    queryKey: queryKeys.unseenNotifications(since),
    queryFn: () =>
      client.notification.query({
        query: {
          limit: UNSEEN_COUNT_READ_LIMIT,
          ...(since === undefined ? {} : { since }),
        },
      }),
  });

/**
 * Reads one run, for its page: its frozen plan, its inputs and its step
 * records. An error is not retried, because a run that returns 404 once will
 * keep returning 404.
 */
export const runQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.run(id),
    queryFn: () => client.run.read({ params: { id } }),
    retry: false,
  });

/**
 * Reads every assistant in a single page, oldest first, for the sidebar's
 * Assistants group, the onboarding step and Settings > Assistants. A user
 * keeps a handful of assistants, so one page of the largest size holds them
 * all.
 */
export const assistantsQuery = (client: HerculeClient) =>
  queryOptions({
    queryKey: queryKeys.assistants(),
    queryFn: () => client.assistant.query({ query: { limit: MAX_PAGE_LIMIT } }),
  });

/**
 * Reads one assistant, for its conversation screen and for the session view
 * of its sessions. An error is not retried, because an assistant that returns 404
 * once will keep returning 404.
 */
export const assistantQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: queryKeys.assistant(id),
    queryFn: () => client.assistant.read({ params: { id } }),
    retry: false,
  });

/**
 * Reads the assistant a session answered, for the session view, or returns
 * null when the assistant has been deleted since. The session outlives its
 * assistant, so a not-found answer here is a fact to show, not a failure;
 * any other error still fails the read.
 *
 * The key sits under the assistant's own key, so the `assistant` live nudge
 * that renames or deletes it refetches this read too.
 */
export const answeredAssistantQuery = (client: HerculeClient, id: string) =>
  queryOptions({
    queryKey: [...queryKeys.assistant(id), "answered"],
    queryFn: () =>
      client.assistant.read({ params: { id } }).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      }),
    retry: false,
  });

/**
 * Reads one assistant's conversations in a single page. An assistant has one
 * conversation per channel container, and the web is the only channel so far,
 * so the page holds one.
 */
export const conversationsQuery = (client: HerculeClient, assistantId: string) =>
  queryOptions({
    queryKey: queryKeys.conversations({ assistantId }),
    queryFn: () => client.conversation.query({ query: { assistantId, limit: MAX_PAGE_LIMIT } }),
  });

/**
 * Reads a conversation's messages newest first, one page of 50 at a time. The
 * conversation screen opens on the latest page, and "Show earlier messages"
 * fetches the next one. `flattenMessagePages` puts the pages back in reading
 * order.
 */
export const conversationMessagesQuery = (client: HerculeClient, conversationId: string) =>
  infiniteQueryOptions({
    queryKey: queryKeys.conversationMessages(conversationId),
    queryFn: ({ pageParam }) =>
      client.conversation.queryMessages({
        params: { id: conversationId },
        query: {
          sort: [{ field: "position", direction: "desc" }],
          limit: DEFAULT_PAGE_LIMIT,
          ...(pageParam === undefined ? {} : { cursor: pageParam }),
        },
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    // A page that fails to load shows its error beside "Show earlier
    // messages" at once, and the user decides whether to try again, rather
    // than waiting through retries in the background.
    retry: false,
  });

/**
 * Reads a conversation's current session: the newest session that answers
 * it, or null when none has started yet. The server applies the rule, because
 * a list filtered in the browser could be cut off at its page size and then
 * return an older session.
 *
 * A `session` push refetches it only when the push names a session of this
 * conversation, since only such a session can be or replace its current one.
 */
export const currentConversationSessionQuery = (client: HerculeClient, conversationId: string) =>
  queryOptions({
    queryKey: queryKeys.conversationSession(conversationId),
    queryFn: async () =>
      (
        await client.session.query({
          query: { conversationId, sort: [{ field: "createdAt", direction: "desc" }], limit: 1 },
        })
      ).items[0] ?? null,
  });
