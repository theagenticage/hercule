/**
 * The query keys every read is cached under, and the keys a live push
 * invalidates.
 *
 * A key is a plain array, so this package can build keys without depending on
 * TanStack: the web app passes them straight to its query client. The key
 * builders and the push mapping live together because they must agree: a push
 * lists records, and the mapping must return the keys those records are cached
 * under. If the two were written apart they would drift, and the only symptom
 * would be a screen that silently stops updating.
 */
import type {
  Invalidate,
  MutableLiveTopic,
  NotificationFilter,
  RunFilter,
  Runner,
  SessionFilter,
  SignalFilter,
  TaskFilter,
} from "@hercule/contract";
import type { HerculeClient } from "../client";
import { listLoopbackEndpoints } from "../local-runner";

/** A cache key. This package does not read it; the app's query client does. */
export type LiveQueryKey = ReadonlyArray<unknown>;

/**
 * The filter of an event listing that identifies it in the cache: the fields
 * of `event.query` that narrow the listing. Paging and `since` are left out,
 * so every page of one listing shares one key.
 */
export type EventListFilter = Pick<
  NonNullable<Parameters<HerculeClient["event"]["query"]>[0]["query"]>,
  "intake" | "text" | "source" | "handling"
>;

/**
 * The key builder for every read the app makes. The argument of a list or
 * record key is optional: without it, the key is a prefix that matches every
 * variant of that read at once, which is what an invalidation needs.
 */
export const queryKeys = {
  setup: (): LiveQueryKey => ["setup"],
  settings: (): LiveQueryKey => ["settings"],
  /** Not a live topic: the signed-in user's name never changes, since no operation renames a user. */
  user: (): LiveQueryKey => ["user"],
  tasks: (filter?: TaskFilter): LiveQueryKey =>
    filter === undefined ? ["tasks"] : ["tasks", filter],
  task: (id?: string): LiveQueryKey => (id === undefined ? ["task"] : ["task", id]),
  projects: (): LiveQueryKey => ["projects"],
  /**
   * No live topic yet: a resource changed elsewhere, such as from the CLI,
   * shows up on the next read.
   */
  resources: (): LiveQueryKey => ["resources"],
  /**
   * An assistant's memory: with `name`, one document; with the assistant's id
   * alone, its index, the list `memory.list` returns; with neither, the
   * prefix of every assistant's. The index's key is the prefix of its
   * documents' keys, so one invalidation after a write or a delete reads the
   * index and every document of that assistant again.
   *
   * No live topic yet: an assistant's write shows up on the next read.
   */
  memory: (assistantId?: string, name?: string): LiveQueryKey =>
    assistantId === undefined
      ? ["memory"]
      : name === undefined
        ? ["memory", assistantId]
        : ["memory", assistantId, name],
  workspaces: (): LiveQueryKey => ["workspaces"],
  workspace: (id?: string): LiveQueryKey => (id === undefined ? ["workspace"] : ["workspace", id]),
  connections: (): LiveQueryKey => ["connections"],
  /**
   * The Ignore Rules, with what each caught. Not a live topic: Settings >
   * Intake reads the list each time it opens, and after a delete.
   */
  ignoreRules: (): LiveQueryKey => ["ignore-rules"],
  connection: (id?: string): LiveQueryKey =>
    id === undefined ? ["connection"] : ["connection", id],
  /**
   * The choices one config field of a connection loads from the account. Not a
   * live topic, and kept out of the `connection` prefix on purpose: the account
   * changes without telling Hercule, so a form reads them each time it opens,
   * and a connection push must not load them again while the user picks.
   */
  connectionChoices: (connectionId: string, field: string): LiveQueryKey => [
    "connection-choices",
    connectionId,
    field,
  ],
  runners: (): LiveQueryKey => ["runners"],
  runner: (id?: string): LiveQueryKey => (id === undefined ? ["runner"] : ["runner", id]),
  /**
   * A filtered listing is keyed on its filter, such as:
   *
   * - one runner's sessions, for its page;
   * - one run's sessions, the ones its agent steps started, for the run's page;
   * - `{ thread: true }`, every Thread and no Agent's session, for the
   *   desktop app's sidebar;
   * - `{ thread: false, status: LIVE_SESSION_STATUSES }`, the live sessions
   *   an Agent spawned, which the desktop app's "From runs" reads.
   *
   * Every variant keeps the `sessions` prefix, so a `session` push
   * invalidates them all.
   */
  sessions: (filter?: typeof SessionFilter.Type): LiveQueryKey =>
    filter === undefined ? ["sessions"] : ["sessions", filter],
  /** Not a live topic: profiles change only through this browser's own writes. */
  profiles: (): LiveQueryKey => ["profiles"],
  session: (id?: string): LiveQueryKey => (id === undefined ? ["session"] : ["session", id]),
  /**
   * The session of an agent that sent a message into a thread, read to name
   * the sender when the desktop app's session lists do not hold it (they
   * are read first, and follow `session` pushes). Not a live topic: the key
   * is kept out of the `session` prefix on purpose, so the `session` pushes
   * of a busy sender, which come as often as once a second, never read it
   * again. A title generated after this read is therefore not seen, which
   * is accepted for a session the lists do not hold.
   */
  sender: (sessionId: string): LiveQueryKey => ["sender", sessionId],
  /**
   * A conversation's current session: the newest session that answers it,
   * which an assistant's pose is drawn from. Without the id, the prefix of
   * every conversation's.
   *
   * It is kept out of the `sessions` prefix on purpose. A `session` push
   * reaches it only for the conversations the push names (see
   * `buildConversationSessionKeys`), rather than once per assistant on every
   * push.
   */
  conversationSession: (conversationId?: string): LiveQueryKey =>
    conversationId === undefined
      ? ["conversation-session"]
      : ["conversation-session", conversationId],
  /**
   * One agent's whole transcript, in ascending order: the session's own
   * agent's without `subagentId`, else that subagent's. A delta on the
   * agent's `:stream` topic is appended directly to this entry. Both kinds of
   * key have three parts, so the session's own agent's key is never a prefix
   * of a subagent's, and a prefix match on one never reaches the other.
   */
  transcript: (sessionId: string, subagentId?: string): LiveQueryKey => [
    "transcript",
    sessionId,
    subagentId ?? null,
  ],
  /**
   * The rows of one session's running turn, oldest first, which an
   * assistant's Conversation reads to draw the reply being written. A delta
   * on the session's `:stream` topic is appended directly to this entry, so,
   * like `transcript`, it is never invalidated: no push maps to it in
   * `buildQueryKeys`. The entry is read from the newest `turn.started` on,
   * and the Conversation trims it with `trimToRunningTurn` as rows are
   * appended, so a later `turn.started` drops the rows before it. Its prefix
   * `running-turn` is its own, so an invalidation of another key never
   * reaches it, and it is never the thread's `transcript` entry, which holds
   * the whole transcript. The Conversation removes it when it closes.
   */
  runningTurn: (sessionId: string): LiveQueryKey => ["running-turn", sessionId],
  /** Every page of one session's subagents, whatever the sort; without it, the prefix of all of them. */
  subagents: (sessionId?: string): LiveQueryKey =>
    sessionId === undefined ? ["subagents"] : ["subagents", sessionId],
  /** A session's input history, including queued inputs. The composer's queued list reads it. */
  /**
   * Not a live topic: an uploaded image's bytes never change, so the cached
   * `Blob` is kept for as long as the page shows it.
   */
  attachmentContent: (id: string): LiveQueryKey => ["attachment-content", id],
  inputs: (sessionId?: string): LiveQueryKey =>
    sessionId === undefined ? ["inputs"] : ["inputs", sessionId],
  joinTokens: (): LiveQueryKey => ["join-tokens"],
  plugins: (): LiveQueryKey => ["plugins"],
  /** Not a live topic: secret references change only through this browser's own writes. */
  secrets: (): LiveQueryKey => ["secrets"],
  providers: (): LiveQueryKey => ["providers"],
  controller: (): LiveQueryKey => ["controller"],
  workflows: (): LiveQueryKey => ["workflows"],
  workflow: (id?: string): LiveQueryKey => (id === undefined ? ["workflow"] : ["workflow", id]),
  /**
   * The triggers of one workflow, keyed on its id. Without the id, it is both
   * the key of the desktop app's workflow list, which reads every trigger,
   * and the prefix of every trigger list. Triggers have no topic of their own: a
   * trigger is part of its workflow, so a change to one is pushed on
   * `workflow`.
   */
  triggers: (workflowId?: string): LiveQueryKey =>
    workflowId === undefined ? ["triggers"] : ["triggers", workflowId],
  /**
   * Every start trigger of every workflow, which Settings > Bounds reads for
   * each one's spawn bound and current window. It sits under the `triggers`
   * prefix, so every push that refetches trigger lists refetches it too.
   */
  startTriggers: (): LiveQueryKey => ["triggers", { kind: "start" }],
  /**
   * The oldest events one start trigger holds, which its row on the
   * workflow's page lists. It sits under the `triggers` prefix, so whatever
   * refetches the workflow's triggers, a push or a resume, refetches it too
   * and the list keeps up with the held count beside it.
   */
  heldEvents: (workflowId: string, triggerId: string): LiveQueryKey => [
    "triggers",
    workflowId,
    "held",
    triggerId,
  ],
  /**
   * Not a live topic. The key includes the source text, so validating the same
   * source again reads the cached result.
   */
  workflowValidation: (source: string): LiveQueryKey => ["workflow-validation", source],
  /**
   * Not live topics. The action and event kind catalogs change only when a
   * plugin is turned on or off, and the editor fetches them again each time it
   * opens.
   */
  workflowActions: (): LiveQueryKey => ["workflow-actions"],
  eventKinds: (): LiveQueryKey => ["event-kinds"],
  /**
   * One event, as `event.read` returns it. Not a live topic: the event log is
   * append-only, so a stored event is read once and kept.
   */
  event: (id: number): LiveQueryKey => ["event", id],
  /**
   * Pages of `event.query`, keyed on the filter without its cursor, so every
   * page of one listing shares one key. Without the filter, the prefix of
   * every event listing. Not a live topic: the event log is append-only, so a
   * screen that shows a listing reads it again each time it opens.
   */
  events: (filter?: EventListFilter): LiveQueryKey =>
    filter === undefined ? ["events"] : ["events", filter],
  /** Not a live topic yet. A change to an Agent made elsewhere shows up on the next fetch. */
  agents: (): LiveQueryKey => ["agents"],
  assistants: (): LiveQueryKey => ["assistants"],
  assistant: (id?: string): LiveQueryKey => (id === undefined ? ["assistant"] : ["assistant", id]),
  /** Keyed on the assistant filter; without it, the prefix of every conversation list. */
  conversations: (filter?: { readonly assistantId: string }): LiveQueryKey =>
    filter === undefined ? ["conversations"] : ["conversations", filter],
  conversation: (id?: string): LiveQueryKey =>
    id === undefined ? ["conversation"] : ["conversation", id],
  /** Every page of one conversation's messages, whatever the sort. */
  conversationMessages: (conversationId?: string): LiveQueryKey =>
    conversationId === undefined
      ? ["conversation-messages"]
      : ["conversation-messages", conversationId],
  runs: (filter?: RunFilter): LiveQueryKey => (filter === undefined ? ["runs"] : ["runs", filter]),
  run: (id?: string): LiveQueryKey => (id === undefined ? ["run"] : ["run", id]),
  /** The notification center's pages, keyed on the filter. */
  notifications: (filter?: NotificationFilter): LiveQueryKey =>
    filter === undefined ? ["notifications"] : ["notifications", filter],
  /**
   * The one page the sidebar reads to count the notifications created since
   * `since`. It is a plain read, not pages, so its key must differ from the
   * center's: the two would otherwise share a key when neither filters. It
   * shares the `notifications` prefix, so an invalidation reaches both.
   */
  unseenNotifications: (since: string | undefined): LiveQueryKey => [
    "notifications",
    "unseen",
    since ?? null,
  ],
  /**
   * Intake's lists, keyed on the filter. The `to-do` view is read whole, so
   * one entry holds every open signal and its count.
   */
  signals: (filter?: SignalFilter): LiveQueryKey =>
    filter === undefined ? ["signals"] : ["signals", filter],
  /** One signal, as `signal.read` returns it, with the describe lines of its actions. */
  signal: (id?: string): LiveQueryKey => (id === undefined ? ["signal"] : ["signal", id]),
  /** Every page of the Discussion listing, newest first. */
  discussions: (): LiveQueryKey => ["discussions"],
  /** One Discussion, as `discussion.read` returns it; without the id, the prefix of every Discussion. */
  discussion: (id?: string): LiveQueryKey =>
    id === undefined ? ["discussion"] : ["discussion", id],
  /** Every page of the Wiki Page listing, newest first. */
  wikiPages: (): LiveQueryKey => ["wiki-pages"],
  /**
   * One Wiki Page: with `revision`, that older revision; with the id alone,
   * the current page; with neither, the prefix of every page. The page's key
   * is the prefix of its revisions' keys, so invalidating the page reads its
   * older revisions again too.
   */
  wikiPage: (id?: string, revision?: number): LiveQueryKey =>
    id === undefined
      ? ["wiki-page"]
      : revision === undefined
        ? ["wiki-page", id]
        : ["wiki-page", id, revision],
  /**
   * Every snoozed signal of the kind `kind`, every page of Later. Not a live
   * topic, and kept out of the `signals` prefix on purpose: the offer's pane
   * and the Ignore dialog read it once when they open, so a `signal` push
   * does not read all of Later again.
   */
  laterSignalsOfKind: (kind: string): LiveQueryKey => ["later-signals-of-kind", kind],
  /**
   * Keyed on the loopback endpoints detection asks among `runners`, because
   * the result depends on them. The same runners read again, with the same
   * endpoints, gives the same key, so detection does not run again.
   */
  localRunner: (runners: ReadonlyArray<Runner>): LiveQueryKey => [
    "local-runner",
    listLoopbackEndpoints(runners).map(({ id, port }) => `${id}:${String(port)}`),
  ],
} as const;

/**
 * The keys of every signal read, the lists and each signal's own.
 *
 * A signal's actions carry describe lines, which the controller writes on
 * each read from the current names of the workflows and Connections they
 * name, and from the plugins that own their actions. A change to any of
 * these sends no `signal` push, so the pushes of those three topics make
 * every signal read stale as well.
 */
const SIGNAL_DESCRIBE_KEYS: ReadonlyArray<LiveQueryKey> = [queryKeys.signals(), queryKeys.signal()];

/**
 * Returns the query keys to invalidate for a push on a mutable topic. A push
 * with no ids means every record of the topic may have changed (the
 * controller sends one first on every subscription), so it returns the list
 * and record prefixes rather than one key per record. `conversationIds` is
 * the push's map from each session to its conversation, which only a
 * `session` push carries.
 */
export const buildQueryKeys = (
  topic: MutableLiveTopic,
  ids: ReadonlyArray<string>,
  conversationIds?: Invalidate["conversationIds"],
): ReadonlyArray<LiveQueryKey> => {
  // A topic that no screen reads has no key to invalidate. Add a case here
  // when a screen starts reading a new topic.
  if (topic === "task") {
    return ids.length === 0
      ? [queryKeys.tasks(), queryKeys.task()]
      : [queryKeys.tasks(), ...ids.map((id) => queryKeys.task(id))];
  }
  // Any runner change refetches the list. A runner's own page is refetched
  // only when the push lists its id, or when the push lists no ids.
  if (topic === "runner") {
    return ids.length === 0
      ? [queryKeys.runners(), queryKeys.runner()]
      : [queryKeys.runners(), ...ids.map((id) => queryKeys.runner(id))];
  }
  if (topic === "workspace") {
    return ids.length === 0
      ? [queryKeys.workspaces(), queryKeys.workspace()]
      : [queryKeys.workspaces(), ...ids.map((id) => queryKeys.workspace(id))];
  }
  // Any session change refetches the list that the sidebar and All sessions
  // read. A session's thread page and its queued-input list are refetched
  // only when the push lists the session's id, or when the push lists no ids.
  // The queued-input list is included because it changes whenever the session
  // does (an input is delivered or queued). The transcript is not listed: it
  // is never invalidated, only appended to from the `:stream` topic's deltas.
  // A conversation's current session is refetched only for the conversations
  // the push names, see `buildConversationSessionKeys`.
  if (topic === "session") {
    return ids.length === 0
      ? [
          queryKeys.sessions(),
          queryKeys.session(),
          queryKeys.inputs(),
          queryKeys.conversationSession(),
        ]
      : [
          queryKeys.sessions(),
          ...ids.map((id) => queryKeys.session(id)),
          ...ids.map((id) => queryKeys.inputs(id)),
          ...buildConversationSessionKeys(ids, conversationIds),
        ];
  }
  // Any connection change refetches the list. A connection's own page is
  // refetched only when the push lists its id, or when the push lists no ids.
  // Every signal read is refetched too, see `SIGNAL_DESCRIBE_KEYS`.
  if (topic === "connection") {
    return ids.length === 0
      ? [queryKeys.connections(), queryKeys.connection(), ...SIGNAL_DESCRIBE_KEYS]
      : [
          queryKeys.connections(),
          ...ids.map((id) => queryKeys.connection(id)),
          ...SIGNAL_DESCRIBE_KEYS,
        ];
  }
  // Any workflow change refetches the listing and every trigger list. A
  // trigger's change, such as a pause or a failing filter, is pushed with its
  // workflow's id, and the read of every trigger holds that workflow's
  // triggers too, so the `triggers` prefix covers both it and the one
  // workflow's list. A workflow's own page is refetched only when the push
  // lists its id, or when the push lists no ids. Every signal read is
  // refetched too, see `SIGNAL_DESCRIBE_KEYS`.
  if (topic === "workflow") {
    return ids.length === 0
      ? [queryKeys.workflows(), queryKeys.workflow(), queryKeys.triggers(), ...SIGNAL_DESCRIBE_KEYS]
      : [
          queryKeys.workflows(),
          ...ids.map((id) => queryKeys.workflow(id)),
          queryKeys.triggers(),
          ...SIGNAL_DESCRIBE_KEYS,
        ];
  }
  // Any run change refetches the run list, whatever its filter. A run's own
  // page is refetched only when the push lists its id, or when the push
  // lists no ids.
  if (topic === "run") {
    return ids.length === 0
      ? [queryKeys.runs(), queryKeys.run()]
      : [queryKeys.runs(), ...ids.map((id) => queryKeys.run(id))];
  }
  // Any assistant change refetches the list. An assistant's own page is
  // refetched only when the push lists its id, or when the push lists no ids.
  if (topic === "assistant") {
    return ids.length === 0
      ? [queryKeys.assistants(), queryKeys.assistant()]
      : [queryKeys.assistants(), ...ids.map((id) => queryKeys.assistant(id))];
  }
  // A conversation push means the conversation was created or deleted, or a
  // message was stored in it. The list, the conversation and its messages are
  // refetched; the messages because a new one is the usual reason for the push.
  if (topic === "conversation") {
    return ids.length === 0
      ? [queryKeys.conversations(), queryKeys.conversation(), queryKeys.conversationMessages()]
      : [
          queryKeys.conversations(),
          ...ids.map((id) => queryKeys.conversation(id)),
          ...ids.map((id) => queryKeys.conversationMessages(id)),
        ];
  }
  // A subagent is read through its session, so a push lists the ids of the
  // sessions whose subagents changed, and those sessions' lists are
  // refetched.
  if (topic === "subagent") {
    return ids.length === 0
      ? [queryKeys.subagents()]
      : ids.map((sessionId) => queryKeys.subagents(sessionId));
  }
  // Notifications are read only as lists: the notification center's pages
  // and the sidebar's count. Any change refetches both, whatever their filter.
  if (topic === "notification") return [queryKeys.notifications()];
  // Any signal change refetches every list, whatever its filter, because a
  // raised or resolved signal moves in or out of them. A signal's own read is
  // refetched only when the push lists its id, or when the push lists no ids.
  if (topic === "signal") {
    return ids.length === 0
      ? [queryKeys.signals(), queryKeys.signal()]
      : [queryKeys.signals(), ...ids.map((id) => queryKeys.signal(id))];
  }
  // Any Discussion change refetches every page of the listing. A
  // Discussion's own page is refetched only when the push lists its id, or
  // when the push lists no ids.
  if (topic === "discussion") {
    return ids.length === 0
      ? [queryKeys.discussions(), queryKeys.discussion()]
      : [queryKeys.discussions(), ...ids.map((id) => queryKeys.discussion(id))];
  }
  // Any Wiki Page change refetches every page of the listing. A page's own
  // read, and its older revisions under the same prefix, is refetched only
  // when the push lists its id, or when the push lists no ids.
  if (topic === "wikiPage") {
    return ids.length === 0
      ? [queryKeys.wikiPages(), queryKeys.wikiPage()]
      : [queryKeys.wikiPages(), ...ids.map((id) => queryKeys.wikiPage(id))];
  }
  // The plugin set is fixed at build time and read as one list, so the whole
  // list is refetched whichever plugin changed. Every signal read is
  // refetched too, see `SIGNAL_DESCRIBE_KEYS`. So is every Connection's own
  // page: a plugin-level write changes what every Connection of the plugin
  // resolves to.
  if (topic === "plugin") {
    return [queryKeys.plugins(), queryKeys.connection(), ...SIGNAL_DESCRIBE_KEYS];
  }
  // Provider instances are read as one list (there is one per shipped
  // provider), so the whole list is refetched whichever instance changed.
  if (topic === "provider") return [queryKeys.providers()];
  return [];
};

/**
 * Returns the `conversationSession` keys a `session` push makes stale, from
 * the conversation it names for each session in `ids`.
 *
 * A conversation's current session is its newest session, so a push changes
 * it only when one of the conversation's sessions changed or a new one
 * started there. Either way the push names that conversation, so:
 *
 * - each conversation the push names is stale, once;
 * - a session in no conversation, such as a thread or a workflow run's
 *   session, makes nothing stale;
 * - a session the push names no conversation for, as from a controller that
 *   predates `conversationIds`, may be in any conversation, so every
 *   conversation is stale and the prefix is returned.
 */
const buildConversationSessionKeys = (
  ids: ReadonlyArray<string>,
  conversationIds: Invalidate["conversationIds"],
): ReadonlyArray<LiveQueryKey> => {
  const stale = new Set<string>();
  for (const id of ids) {
    const conversationId = conversationIds?.[id];
    if (conversationId === undefined) return [queryKeys.conversationSession()];
    if (conversationId !== null) stale.add(conversationId);
  }
  return [...stale].map((conversationId) => queryKeys.conversationSession(conversationId));
};
