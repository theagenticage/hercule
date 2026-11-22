/**
 * What a composer's `+` menu knows of the MCP servers of its thread: the
 * thread's list, the words on the menu's "MCP servers" row, and how a change
 * to the list is written. A Draft Thread keeps its list with its other unsent
 * picks. A started thread writes `session.update` at once.
 */
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage, type DraftView, type ThreadChoice } from "@hercule/client-core";
import {
  decideMcpListChoice,
  decideThreadStartList,
  decideThreadStartSource,
  describeThreadServersRow,
  type McpListChoice,
  type McpServerView,
  type StartProjectRecord,
  type StartRecord,
  type ThreadServersRow,
  type ThreadStartDecision,
} from "@hercule/client-core/mcp-servers";
import type { Session } from "@hercule/contract";
import { buildMcpListCache, useMcpListEdit } from "../../app/mcp-list-edits";
import { useMcpServerViews } from "../../app/mcp-server-views";
import { projectsQuery, settingsQuery } from "../../app/queries";
import {
  useCachedMcpServers,
  useDraftListRecords,
  useStartedThreadIds,
} from "./thread-server-rows";

/**
 * What the `+` menu needs of the thread's servers. The row's words and the
 * red dot come from `row`. A change goes through `apply`, which hands the
 * user's choice to the rules that resolve it against the list as it is when
 * the change is made, so a switch is never applied to a list drawn earlier.
 */
export interface ThreadServers {
  /** The thread's list now. */
  readonly ids: readonly string[];
  /** The project the thread is in, which decides the list it started from. `null` for no project. */
  readonly projectId: string | null;
  readonly row: ThreadServersRow;
  /** Applies the user's choice to the thread's list. Does nothing while `busy`. */
  readonly apply: (choice: McpListChoice) => void;
  /** Whether a write runs or its list could not be read again, which draws the switches as off. */
  readonly busy: boolean;
  /** Why the last change was not made, such as a session without `mcp.manage`. `null` when it was. */
  readonly refusal: string | null;
  /** Forgets a settled refusal, when the user dismisses the menu or the picker that showed it. */
  readonly clearRefusal: () => void;
}

/**
 * Returns where the thread's list started, from the records the cache holds
 * and the project and settings reads the caller made. The submenu and the
 * picker word their foot and offer the way back to the start list from it.
 * A read that is pending or failed, or a project that no longer exists, only
 * takes the way back: the thread's own switches work.
 */
export function useThreadStartDecision(
  projectId: string | null,
  views: readonly McpServerView[],
): ThreadStartDecision {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const settings = useQuery(settingsQuery(client));
  const found = projects.find((each) => each.id === projectId);
  const project: StartProjectRecord =
    found === undefined ? { kind: "missing" } : { kind: "read", value: found };
  const defaultIds: StartRecord<readonly string[]> =
    settings.data !== undefined
      ? { kind: "read", value: settings.data.user["thread.mcpServerIds"] ?? [] }
      : settings.error === null
        ? { kind: "pending" }
        : { kind: "failed", message: readErrorMessage(settings.error) };
  return decideThreadStartSource({
    projectId,
    project,
    defaultIds,
    knownServerIds: new Set(views.map((view) => view.server.id)),
  });
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
  return {
    ids,
    projectId,
    row,
    // The picks are in a store that re-renders the draft before the next event, so `pick` is
    // current. Without one, the draft's list is the start list, which the cache holds now.
    apply: (choice) => {
      const cache = buildMcpListCache(queryClient, client);
      const cachedViews = cache.readViews();
      if (cachedViews === undefined) return;
      const source = decideThreadStartSource({
        projectId,
        ...cache.readStartRecords(projectId),
        knownServerIds: new Set(cachedViews.map((each) => each.server.id)),
      });
      const start = source.kind === "start" ? source.start : undefined;
      const decided = decideMcpListChoice({
        ids: pick ?? start?.mcpServerIds ?? ids,
        views: cachedViews,
        choice,
        start,
      });
      if (decided.kind === "write") {
        onChoose({ kind: "mcpServers", projectId, mcpServerIds: [...decided.mcpServerIds] });
      }
    },
    busy: false,
    refusal: null,
    clearRefusal: () => undefined,
  };
}

/**
 * Returns the servers of the started thread `session`. A change is an edit
 * of the thread's list (see `useMcpListEdit`): one runs at a time for the
 * thread, wherever its menu or picker was opened from, and it counts as
 * running until the session is read again, so a second switch never starts
 * from a list the first one replaced. Closing the menu or the picker keeps
 * the guard and the refusal.
 *
 * It reads no servers itself: the thread's page reads them (see
 * `useMcpServerViews`), and this only uses what the cache holds.
 */
export function useStartedThreadServers(session: Session): ThreadServers {
  const ids = useStartedThreadIds(session);
  const row = describeThreadServersRow(useCachedMcpServers() ?? [], ids);
  const edit = useMcpListEdit({
    kind: "thread",
    sessionId: session.id,
    projectId: session.projectId,
  });
  return {
    ids,
    projectId: session.projectId,
    row,
    apply: edit.apply,
    busy: edit.blocked,
    refusal: edit.problem(),
    clearRefusal: edit.clearRefusal,
  };
}
