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
import type { MutableLiveTopic, TaskFilter } from "@hercule/contract";

/** A cache key. This package does not read it; the app's query client does. */
export type LiveQueryKey = ReadonlyArray<unknown>;

/**
 * The key builder for every read the app makes. The argument of a list or
 * record key is optional: without it, the key is a prefix that matches every
 * variant of that read at once, which is what an invalidation needs.
 */
export const queryKeys = {
  setup: (): LiveQueryKey => ["setup"],
  settings: (): LiveQueryKey => ["settings"],
  tasks: (filter?: TaskFilter): LiveQueryKey =>
    filter === undefined ? ["tasks"] : ["tasks", filter],
  task: (id?: string): LiveQueryKey => (id === undefined ? ["task"] : ["task", id]),
  projects: (): LiveQueryKey => ["projects"],
  /**
   * No live topic yet: a resource changed elsewhere, such as from the CLI,
   * shows up on the next read.
   */
  resources: (): LiveQueryKey => ["resources"],
  /** No live topic yet either: the app polls a workspace while it is being created. */
  workspaces: (): LiveQueryKey => ["workspaces"],
  workspace: (id?: string): LiveQueryKey => (id === undefined ? ["workspace"] : ["workspace", id]),
  connections: (): LiveQueryKey => ["connections"],
  connection: (id?: string): LiveQueryKey =>
    id === undefined ? ["connection"] : ["connection", id],
  runners: (): LiveQueryKey => ["runners"],
  runner: (id?: string): LiveQueryKey => (id === undefined ? ["runner"] : ["runner", id]),
  sessions: (filter?: { readonly runnerId: string }): LiveQueryKey =>
    filter === undefined ? ["sessions"] : ["sessions", filter],
  /** Not a live topic: profiles change only through this browser's own writes. */
  profiles: (): LiveQueryKey => ["profiles"],
  session: (id?: string): LiveQueryKey => (id === undefined ? ["session"] : ["session", id]),
  /**
   * The whole transcript, in ascending order. A `:stream` delta is appended
   * directly to this entry.
   */
  transcript: (sessionId: string): LiveQueryKey => ["transcript", sessionId],
  /** A session's input history, including queued inputs. The composer's queued list reads it. */
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
  /** Not a live topic yet. A change to an Agent made elsewhere shows up on the next fetch. */
  agents: (): LiveQueryKey => ["agents"],
  /** Keyed on the loopback endpoints detection asks, because the result depends on them. */
  localRunner: (endpoints: ReadonlyArray<string>): LiveQueryKey => ["local-runner", endpoints],
} as const;

/**
 * Returns the query keys to invalidate for a push on a mutable topic. A push
 * with no ids means every record of the topic may have changed (a reconnect
 * assumes this), so it returns the list and record prefixes rather than one
 * key per record.
 */
export const buildQueryKeys = (
  topic: MutableLiveTopic,
  ids: ReadonlyArray<string>,
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
  // Any session change refetches the list that the sidebar and All sessions
  // read. A session's thread page and its queued-input list are refetched
  // only when the push lists the session's id, or when the push lists no ids.
  // The queued-input list is included because it changes whenever the session
  // does (an input is delivered or queued). The transcript is not listed: it
  // is never invalidated, only appended to from the `:stream` topic's deltas.
  if (topic === "session") {
    return ids.length === 0
      ? [queryKeys.sessions(), queryKeys.session(), queryKeys.inputs()]
      : [
          queryKeys.sessions(),
          ...ids.map((id) => queryKeys.session(id)),
          ...ids.map((id) => queryKeys.inputs(id)),
        ];
  }
  // Any connection change refetches the list. A connection's own page is
  // refetched only when the push lists its id, or when the push lists no ids.
  if (topic === "connection") {
    return ids.length === 0
      ? [queryKeys.connections(), queryKeys.connection()]
      : [queryKeys.connections(), ...ids.map((id) => queryKeys.connection(id))];
  }
  // Any workflow change refetches the listing. A workflow's own page is
  // refetched only when the push lists its id, or when the push lists no ids.
  if (topic === "workflow") {
    return ids.length === 0
      ? [queryKeys.workflows(), queryKeys.workflow()]
      : [queryKeys.workflows(), ...ids.map((id) => queryKeys.workflow(id))];
  }
  // The plugin set is fixed at build time and read as one list, so the whole
  // list is refetched whichever plugin changed.
  if (topic === "plugin") return [queryKeys.plugins()];
  // Provider instances are read as one list (there is one per shipped
  // provider), so the whole list is refetched whichever instance changed.
  if (topic === "provider") return [queryKeys.providers()];
  return [];
};
