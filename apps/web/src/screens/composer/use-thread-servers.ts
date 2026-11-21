import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  queryKeys,
  readErrorMessage,
  type HerculeClient,
  type Live,
  type Thread,
  type ThreadChoice,
  type ThreadPicks,
} from "@hercule/client-core";
import {
  buildMcpServerViews,
  chooseNamedServer,
  decideThreadStartList,
  describeThreadServersRow,
  resolveDraftMcpServerIds,
  type McpServerView,
  type ThreadServersRow,
  type ThreadStartList,
} from "@hercule/client-core/mcp-servers";
import type { Project } from "@hercule/contract";
import { useLiveInvalidation } from "../../app/live-invalidation";
import {
  connectionsQuery,
  mcpServersQuery,
  pluginsQuery,
  projectQuery,
  projectsQuery,
  sessionQuery,
  settingsQuery,
} from "../../app/queries";
import { isValidationRefusal, useKeyedWrite } from "../../app/use-keyed-write";
import type { ListUpdate } from "../mcp-server-picker";
import { useKnownMcpServerIds, useMcpServerViews } from "../use-mcp-server-views";

/** The thread's MCP Servers as the composer's menu, submenu and picker use them. */
export interface ThreadServers {
  /** Every MCP Server, or `undefined` while the servers are not read yet. A thread with no server reads them only when its MCP row or the picker opens. */
  readonly views: readonly McpServerView[] | undefined;
  /** Why the servers could not be read, or `null`. */
  readonly readFailure: string | null;
  /** Why the thread's project, which its start list needs, could not be read, or `null`. A thread's own list can be changed without it. */
  readonly startFailure: string | null;
  /** The thread's list: a draft's pick or its start list, a started thread's `Session.mcpServers`. */
  readonly mcpServerIds: readonly string[];
  /** Where the list started. `undefined` while the servers or the thread's project are not read yet, or the project could not be read. */
  readonly start: ThreadStartList | undefined;
  /** The words for the menu's "MCP servers" row. Until `views` is read they show the count alone. */
  readonly row: ThreadServersRow;
  /** Whether a write of the started thread's list is in flight, whichever control started it. The controls ignore clicks meanwhile. */
  readonly writing: boolean;
  /** Why the last write was refused, or `null`. It stays until the next write or `clearRefusal`. */
  readonly refusal: string | null;
  /** Switches the server of `name` that the thread has: `serverId` on, `null` off, another account swaps. */
  readonly chooseServer: (name: string, serverId: string | null) => void;
  /** Changes the list, for the picker. `update` is applied to the list as it is when the change is made. */
  readonly changeList: (update: ListUpdate) => void;
  /** Goes back to the list the thread started from, resolved when the button is pressed. */
  readonly resetToStart: () => void;
  readonly clearRefusal: () => void;
}

/**
 * Returns the start list of a thread in `projectId` from what the query cache
 * holds right now, or `undefined` when a read it needs is not there. Pressing
 * the reset button uses it, so the list that comes back is the project's or
 * the default list as they are at that moment, not as they were when the menu
 * was drawn.
 */
const readStartListNow = (
  queryClient: QueryClient,
  client: HerculeClient,
  projectId: string | null,
): ThreadStartList | undefined => {
  const settings = queryClient.getQueryData(settingsQuery(client).queryKey);
  const servers = queryClient.getQueryData(mcpServersQuery(client).queryKey);
  const connections = queryClient.getQueryData(connectionsQuery(client).queryKey);
  const plugins = queryClient.getQueryData(pluginsQuery(client).queryKey);
  if (settings === undefined || servers === undefined) return undefined;
  if (connections === undefined || plugins === undefined) return undefined;
  const listed = queryClient.getQueryData(projectsQuery(client).queryKey)?.items ?? [];
  const addressed =
    projectId === null
      ? undefined
      : queryClient.getQueryData(projectQuery(client, projectId).queryKey);
  const projects =
    addressed === undefined || listed.some((each) => each.id === addressed.id)
      ? listed
      : [...listed, addressed];
  if (projectId !== null && !projects.some((each) => each.id === projectId)) return undefined;
  return decideThreadStartList(
    projectId,
    projects,
    settings.user["thread.mcpServerIds"] ?? [],
    buildMcpServerViews(servers.items, connections.items, plugins),
  );
};

/**
 * Reads and writes the MCP Servers of the thread the composer belongs to.
 * This is the only place that knows the two kinds of thread apart:
 *
 * - A Draft Thread keeps its list as a pick, with the project the pick was
 *   made under (`recordThreadChoice`). It starts as its project's list, or
 *   the default list.
 * - A started thread writes `session.update` at once. Each change is a
 *   function of the list, applied to the session in the cache when the write
 *   starts, so two quick changes never overwrite each other. One write runs
 *   at a time for the session, whichever menu or picker started it, and the
 *   guard survives closing and opening them: `writing` stays true until the
 *   session has been read again, and, when that read fails, until a read
 *   succeeds. A refusal is `refusal`, and the list stays
 *   as the controller holds it. A refusal as invalid also reads the servers
 *   again, because it can mean a server was deleted.
 *
 * The servers are read only when they are needed: the list is not empty, or
 * `wanted` says the MCP row or the picker is open. The live topic `mcpServer`
 * is held for as long as they are needed.
 */
export const useThreadServers = ({
  client,
  live,
  thread,
  projectId,
  projects: listedProjects,
  defaultIds,
  picks,
  recordThreadChoice,
  wanted,
}: {
  readonly client: HerculeClient;
  readonly live: Live;
  readonly thread: Thread;
  /** The project the thread is in (`null` for none), as the composer resolved it. */
  readonly projectId: string | null;
  readonly projects: readonly Project[];
  /** The ids of the setting `thread.mcpServerIds`. */
  readonly defaultIds: readonly string[];
  readonly picks: ThreadPicks;
  readonly recordThreadChoice: (choice: ThreadChoice) => void;
  /** Whether the MCP row of the `+` menu or the picker is open. */
  readonly wanted: boolean;
}): ThreadServers => {
  const queryClient = useQueryClient();
  const session = thread.kind === "active" ? thread.session : null;
  // The project list stops at its first page, so the thread's project may be
  // missing from it. A draft's loader has read that project by its id, so
  // there this reads only the cache. A started thread reads it when the menu
  // needs the start list.
  const missingFromList =
    projectId !== null && !listedProjects.some((each) => each.id === projectId);
  const addressed = useQuery({
    ...projectQuery(client, projectId ?? ""),
    enabled: missingFromList && session !== null && wanted,
  });
  const projects =
    addressed.data === undefined || !missingFromList
      ? listedProjects
      : [...listedProjects, addressed.data];
  const projectKnown = projectId === null || projects.some((each) => each.id === projectId);

  // A draft's pick is checked against the servers the controller knows when it
  // is sent, from the cached list alone.
  const knownServerIds = useKnownMcpServerIds(client);

  // Before the servers are read, the list cannot be checked against them, so
  // these ids are as stored. They only decide whether a read is needed. The
  // list a draft starts with is its project's, and for no project the default.
  const storedStartIds = projects.find((each) => each.id === projectId)?.mcpServerIds ?? defaultIds;
  const storedIds =
    session === null
      ? (resolveDraftMcpServerIds(picks, projectId, undefined) ?? storedStartIds)
      : session.mcpServers.map((server) => server.mcpServerId);
  const reads = storedIds.length > 0 || wanted;

  useLiveInvalidation(live, queryClient, "mcpServer", reads);
  const { views, failure } = useMcpServerViews(client, reads);

  const start =
    views === undefined || !projectKnown
      ? undefined
      : decideThreadStartList(projectId, projects, defaultIds, views);
  const mcpServerIds =
    session === null
      ? (resolveDraftMcpServerIds(picks, projectId, knownServerIds) ??
        start?.mcpServerIds ??
        storedIds)
      : storedIds;

  const sessionId = session?.id ?? "";
  const write = useKeyedWrite<ListUpdate>({
    mutationKey: ["mcp-list", "session", sessionId],
    reads: [sessionQuery(client, sessionId).queryKey],
    mutationFn: async (update) => {
      const cached = queryClient.getQueryData(sessionQuery(client, sessionId).queryKey);
      if (cached === undefined)
        throw new Error("This thread is not loaded, so its list cannot change.");
      await client.session.update({
        params: { id: sessionId },
        payload: { mcpServerIds: update(cached.mcpServers.map((server) => server.mcpServerId)) },
      });
    },
    // The session is read again after a refusal too, and the mutation stays
    // pending until that read ends, so a control that disables itself while
    // pending never shows the old list between the write and its refresh.
    onSettled: (error) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: sessionQuery(client, sessionId).queryKey }),
        // An invalid list can name a server that was deleted since the servers were read.
        isValidationRefusal(error)
          ? queryClient.invalidateQueries({ queryKey: queryKeys.mcpServers() })
          : undefined,
      ]),
  });

  const changeList = (update: ListUpdate): void => {
    if (session === null) {
      recordThreadChoice({ kind: "mcpServers", projectId, mcpServerIds: update(mcpServerIds) });
      return;
    }
    write.write(update);
  };

  return {
    views,
    readFailure: failure === null ? null : readErrorMessage(failure),
    startFailure: addressed.error === null ? null : readErrorMessage(addressed.error),
    mcpServerIds,
    start,
    row: describeThreadServersRow(views?.map((view) => view.server) ?? [], mcpServerIds),
    writing: write.writing,
    refusal: write.refusal === null ? null : readErrorMessage(write.refusal),
    chooseServer: (name, serverId) => {
      if (views === undefined) return;
      changeList((current) => chooseNamedServer(current, views, name, serverId));
    },
    changeList,
    resetToStart: () => {
      changeList(() => {
        const startNow = readStartListNow(queryClient, client, projectId);
        if (startNow === undefined) {
          throw new Error("The list this thread started from is not read yet. Try again.");
        }
        // A list with ids the servers do not know yet would be written without them.
        if (!startNow.complete) {
          throw new Error(
            "The servers are not fully read yet, so the list cannot be reset. Try again.",
          );
        }
        return startNow.mcpServerIds;
      });
    },
    clearRefusal: write.clearRefusal,
  };
};
