import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  readErrorMessage,
  type HerculeClient,
  type Live,
  type Thread,
  type ThreadChoice,
  type ThreadPicks,
} from "@hercule/client-core";
import {
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
import { projectQuery, sessionQuery } from "../../app/queries";
import { useMcpServerViews } from "../use-mcp-server-views";

/** The thread's MCP Servers as the composer's menu, submenu and picker use them. */
export interface ThreadServers {
  /** Every MCP Server, or `undefined` while the servers are not read yet. A thread with no server reads them only when a menu or the picker opens. */
  readonly views: readonly McpServerView[] | undefined;
  /** Why the servers could not be read, or `null`. */
  readonly readFailure: string | null;
  /** The thread's list: a draft's pick or its start list, a started thread's `Session.mcpServers`. */
  readonly mcpServerIds: readonly string[];
  /** Where the list started. `undefined` while `views` is. */
  readonly start: ThreadStartList | undefined;
  /** The words for the menu's "MCP servers" row. Until `views` is read they show the count alone. */
  readonly row: ThreadServersRow;
  /** Whether a write of a started thread's list is in flight. The controls ignore clicks meanwhile. */
  readonly writing: boolean;
  /** Why the last write was refused, or `null`. */
  readonly refusal: string | null;
  /** Switches the server of `name` that the thread has: `serverId` on, `null` off, another account swaps. */
  readonly chooseServer: (name: string, serverId: string | null) => void;
  /** Replaces the whole list, for the picker and the button that goes back to the start list. */
  readonly setList: (mcpServerIds: readonly string[]) => void;
  readonly clearRefusal: () => void;
}

/**
 * Reads and writes the MCP Servers of the thread the composer belongs to.
 * This is the only place that knows the two kinds of thread apart:
 *
 * - A Draft Thread keeps its list as a pick, with the project the pick was
 *   made under (`recordThreadChoice`). It starts as its project's list, or
 *   the default list.
 * - A started thread writes `session.update` at once. The new list is
 *   computed when the write starts, from the session in the cache, so two
 *   quick changes never overwrite each other. One write runs at a time, and
 *   `writing` stays true until the session has been read again. A refusal is
 *   `refusal`, and the list stays as the controller holds it.
 *
 * The servers are read only when they are needed: the list is not empty, or
 * `wanted` says a menu or the picker is open. The live topic `mcpServer` is
 * held for as long as they are needed.
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
  /** Whether the `+` menu or the picker is open. */
  readonly wanted: boolean;
}): ThreadServers => {
  const queryClient = useQueryClient();
  const session = thread.kind === "active" ? thread.session : null;
  // The project list stops at its first page, so a draft's project may be
  // missing from it. The draft's loader has read that project on its own, and
  // this reads only what is already in the cache.
  const addressedProject = useQuery({
    ...projectQuery(client, projectId ?? ""),
    enabled: false,
  }).data;
  const projects =
    addressedProject === undefined || listedProjects.some((each) => each.id === addressedProject.id)
      ? listedProjects
      : [...listedProjects, addressedProject];

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
    views === undefined ? undefined : decideThreadStartList(projectId, projects, defaultIds, views);
  const mcpServerIds =
    session === null
      ? (resolveDraftMcpServerIds(picks, projectId, views) ?? start?.mcpServerIds ?? storedIds)
      : storedIds;

  const write = useMutation({
    mutationFn: async (choose: (current: readonly string[]) => readonly string[]) => {
      // Only a started thread writes, and `change` only calls this for one.
      const sessionId = session!.id;
      const cached = queryClient.getQueryData(sessionQuery(client, sessionId).queryKey);
      if (cached === undefined)
        throw new Error("This thread is not loaded, so its list cannot change.");
      await client.session.update({
        params: { id: sessionId },
        payload: { mcpServerIds: choose(cached.mcpServers.map((server) => server.mcpServerId)) },
      });
    },
    // The session is read again after a refusal too, and the mutation stays
    // pending until that read ends, so a control that disables itself while
    // pending never shows the old list between the write and its refresh.
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: sessionQuery(client, session!.id).queryKey }),
  });

  const change = (choose: (current: readonly string[]) => readonly string[]): void => {
    if (session === null) {
      recordThreadChoice({ kind: "mcpServers", projectId, mcpServerIds: choose(mcpServerIds) });
      return;
    }
    if (!write.isPending) write.mutate(choose);
  };

  return {
    views,
    readFailure: failure === null ? null : readErrorMessage(failure),
    mcpServerIds,
    start,
    row: describeThreadServersRow(views ?? [], mcpServerIds),
    writing: write.isPending,
    refusal: write.error === null ? null : readErrorMessage(write.error),
    chooseServer: (name, serverId) => {
      if (views === undefined) return;
      change((current) => chooseNamedServer(current, views, name, serverId));
    },
    setList: (ids) => {
      change(() => ids);
    },
    clearRefusal: write.reset,
  };
};
