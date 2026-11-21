/**
 * What a composer's `+` menu knows of the MCP servers of its thread: the
 * thread's list, the words on the menu's "MCP servers" row, and how a change
 * to the list is written. A Draft Thread keeps its list with its other unsent
 * picks. A started thread writes `session.update` at once.
 */
import { useMemo } from "react";
import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  isMutationRunning,
  queryKeys,
  readErrorMessage,
  type DraftView,
  type ThreadChoice,
} from "@hercule/client-core";
import {
  decideThreadStartList,
  describeThreadServersRow,
  type ThreadServersRow,
} from "@hercule/client-core/mcp-servers";
import type { Session } from "@hercule/contract";
import { useMcpServerViews } from "../../app/mcp-server-views";
import { settingsQuery, sessionQuery } from "../../app/queries";

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
  /** Whether a write is running, which draws the switches as off. */
  readonly busy: boolean;
  /** Why the controller refused the last write, such as a session without `mcp.manage`. `null` when it did not. */
  readonly refusal: string | null;
  /** Forgets a settled refusal, when the user opens the menu again. */
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
 * user acts. A pick that names a server deleted since is sent as it is, and the
 * controller refuses the start with its validation message; the next change in
 * the menu drops the unknown id (`chooseNamedServer`).
 */
export function useDraftServers({
  view,
  onChoose,
}: {
  readonly view: DraftView;
  readonly onChoose: (choice: ThreadChoice) => void;
}): ThreadServers {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const projectId = view.resolved.config.projectId ?? null;
  const { projects } = view.catalogs;
  // The new-thread route's loader caches the settings, and a draft never reads them itself.
  const settings = useQuery({ ...settingsQuery(client), enabled: false }).data;
  const defaultIds = settings?.user["thread.mcpServerIds"] ?? [];
  // Until the servers are read, the start list is taken as the records hold it. The
  // default list may still name a deleted server then, which only the count shows.
  const unreadStartIds = projects.find((each) => each.id === projectId)?.mcpServerIds ?? defaultIds;
  const pick = view.resolved.mcpServerIds;
  const holdsServers = (pick ?? unreadStartIds).length > 0;
  const { views } = useMcpServerViews(holdsServers ? "read" : "off");
  const ids =
    pick ??
    (views === undefined
      ? unreadStartIds
      : decideThreadStartList(projectId, projects, defaultIds, views).mcpServerIds);
  return {
    ids,
    projectId,
    row: describeThreadServersRow(views ?? [], ids),
    // The picks are in a store that re-renders the draft before the next event, so `ids` is current.
    change: (update) => {
      onChoose({ kind: "mcpServers", projectId, mcpServerIds: [...update(ids)] });
    },
    busy: false,
    refusal: null,
    clearRefusal: () => undefined,
  };
}

/**
 * Returns the servers of the started thread `session`. A change writes
 * `session.update` with the new list at once, on the list the session's
 * cached record holds when the change is made. One write runs at a time, and
 * it counts as running until the session is read again, so a second switch
 * never starts from a list the first one replaced.
 *
 * It reads no servers itself: the thread's page reads them (see
 * `useMcpServerViews`), and this only uses what the cache holds.
 */
export function useStartedThreadServers(session: Session): ThreadServers {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const sessionId = session.id;
  const writeKey = ["session-mcp-servers", sessionId];
  const ids = useMemo(
    () => session.mcpServers.map((server) => server.mcpServerId),
    [session.mcpServers],
  );
  const { views } = useMcpServerViews("cache");
  const write = useMutation({
    mutationKey: writeKey,
    mutationFn: (mcpServerIds: readonly string[]) =>
      client.session.update({
        params: { id: sessionId },
        payload: { mcpServerIds: [...mcpServerIds] },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId), exact: true });
    },
  });
  const busy = useIsMutating({ mutationKey: writeKey }) > 0;
  return {
    ids,
    projectId: session.projectId,
    row: describeThreadServersRow(views ?? [], ids),
    change: (update) => {
      if (isMutationRunning(queryClient, writeKey)) return;
      const held = queryClient.getQueryData(sessionQuery(client, sessionId).queryKey);
      const current = (held ?? session).mcpServers.map((server) => server.mcpServerId);
      write.mutate([...update(current)]);
    },
    busy,
    refusal: write.isError ? readErrorMessage(write.error) : null,
    clearRefusal: () => {
      if (write.isError) write.reset();
    },
  };
}
