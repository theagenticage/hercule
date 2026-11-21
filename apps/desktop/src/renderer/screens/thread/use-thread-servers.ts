/**
 * What a composer's `+` menu knows of the MCP servers of its thread: the
 * thread's list, the words on the menu's "MCP servers" row, and how a change
 * to the list is written. A Draft Thread keeps its list with its other unsent
 * picks. A started thread writes `session.update` at once.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { queryKeys, type DraftView, type ThreadChoice } from "@hercule/client-core";
import {
  decideThreadStartList,
  describeThreadServersRow,
  type ThreadServersRow,
} from "@hercule/client-core/mcp-servers";
import type { Session } from "@hercule/contract";
import { useMcpServerViews, readCachedStartList } from "../../app/mcp-server-views";
import { mcpWriteKeys, useMcpWrite } from "../../app/mcp-write";
import { sessionQuery } from "../../app/queries";
import {
  useCachedMcpServers,
  useDraftListRecords,
  useStartedThreadIds,
} from "./thread-server-rows";

/**
 * What the `+` menu needs of the thread's servers. The row's words and the
 * red dot come from `row`. A change goes through `change`, which gives the
 * caller the list as it is when the change is made, so a switch is always
 * applied to the current list and never to one drawn earlier.
 */
export interface ThreadServers {
  /** The thread's list now. */
  readonly ids: readonly string[];
  /** The project the thread is in, which decides the list it started from. `null` for no project. */
  readonly projectId: string | null;
  readonly row: ThreadServersRow;
  /** Writes the list `update` returns for the thread's current list. Does nothing while `busy`. */
  readonly change: (update: (current: readonly string[]) => readonly string[]) => void;
  /**
   * Returns the list the thread would start with, from the records the cache
   * holds now. A reset to the start list calls it when the user presses, so
   * it never writes a list drawn from an older read.
   */
  readonly readStartIds: () => readonly string[];
  /** Whether a write runs or its list could not be read again, which draws the switches as off. */
  readonly busy: boolean;
  /** Why the controller refused the last write, such as a session without `mcp.manage`. `null` when it did not. */
  readonly refusal: string | null;
  /** Forgets a settled refusal, when the user dismisses the menu or the picker that showed it. */
  readonly clearRefusal: () => void;
}

/**
 * Returns the servers of a Draft Thread. The list is the draft's own pick
 * while it holds one for this project, and else the list the thread would
 * start with: its project's, or the default list. A change is passed to
 * `onChoose`, which records it with the draft's other picks.
 *
 * Reads the servers once while the list is not empty, to know whether one of
 * them needs sign-in, and nothing while it is empty. A pick changes only when the
 * user acts. A pick that names a server deleted since is dropped when the draft
 * is submitted, and a change in the menu keeps it, so a write never erases a
 * server the catalogue has not read yet.
 */
export function useDraftServers({
  view,
  onChoose,
}: {
  readonly view: DraftView;
  readonly onChoose: (choice: ThreadChoice) => void;
}): ThreadServers {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const { projectId, projects, defaultIds, pick, recordedIds } = useDraftListRecords(view);
  const holdsServers = recordedIds.length > 0;
  const { views } = useMcpServerViews(holdsServers ? "read" : "off");
  const ids =
    pick ??
    (views === undefined
      ? recordedIds
      : decideThreadStartList(projectId, projects, defaultIds, views).mcpServerIds);
  const row = describeThreadServersRow(useCachedMcpServers() ?? [], ids);
  const readStartIds = (): readonly string[] => readCachedStartList(queryClient, client, projectId);
  return {
    ids,
    projectId,
    row,
    // The picks are in a store that re-renders the draft before the next event, so `pick` is
    // current. Without one, the draft's list is the start list, which the cache holds now.
    change: (update) => {
      onChoose({
        kind: "mcpServers",
        projectId,
        mcpServerIds: [...update(pick ?? readStartIds())],
      });
    },
    readStartIds,
    busy: false,
    refusal: null,
    clearRefusal: () => undefined,
  };
}

/**
 * Returns the servers of the started thread `session`. A change writes
 * `session.update` with the new list, on the list the session's cached
 * record holds when the change starts. One write runs at a time for the
 * thread, wherever its menu or picker was opened from, and it counts as
 * running until the session is read again, so a second switch never starts
 * from a list the first one replaced. Closing the menu or the picker keeps
 * the guard and the refusal.
 *
 * It reads no servers itself: the thread's page reads them (see
 * `useMcpServerViews`), and this only uses what the cache holds.
 */
export function useStartedThreadServers(session: Session): ThreadServers {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const sessionId = session.id;
  const ids = useStartedThreadIds(session);
  const row = describeThreadServersRow(useCachedMcpServers() ?? [], ids);
  const write = useMcpWrite<(current: readonly string[]) => readonly string[]>({
    mutationKey: mcpWriteKeys.threadList(sessionId),
    mutationFn: (update) => {
      const held = queryClient.getQueryData(sessionQuery(client, sessionId).queryKey);
      const current = (held ?? session).mcpServers.map((server) => server.mcpServerId);
      return client.session.update({
        params: { id: sessionId },
        payload: { mcpServerIds: [...update(current)] },
      });
    },
    refresh: [queryKeys.session(sessionId)],
  });
  return {
    ids,
    projectId: session.projectId,
    row,
    change: write.start,
    readStartIds: () => readCachedStartList(queryClient, client, session.projectId),
    busy: write.isBlocked,
    refusal: write.problem(),
    clearRefusal: write.clearRefusal,
  };
}
