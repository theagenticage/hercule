import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  readErrorMessage,
  type HerculeClient,
  type Live,
  type Thread,
  type ThreadChoice,
  type ThreadPicks,
} from "@hercule/client-core";
import {
  decideMcpListChoice,
  decideThreadStartSource,
  describeThreadServersRow,
  resolveDraftMcpServerIds,
  type McpListChoice,
  type McpServerView,
  type StartProjectRecord,
  type ThreadServersRow,
  type ThreadStartDecision,
} from "@hercule/client-core/mcp-servers";
import type { Project } from "@hercule/contract";
import { useLiveInvalidation } from "../../app/live-invalidation";
import { buildMcpListCache, useMcpListEdit } from "../../app/mcp-list-edits";
import { projectQuery } from "../../app/queries";
import { useKnownMcpServerIds, useMcpServerViews } from "../use-mcp-server-views";

/** The thread's MCP Servers as the composer's menu, submenu and picker use them. */
export interface ThreadServers {
  /** Every MCP Server, or `undefined` while the servers are not read yet. A thread with no server reads them only when its MCP row or the picker opens. */
  readonly views: readonly McpServerView[] | undefined;
  /** Why the servers could not be read, or `null`. */
  readonly readFailure: string | null;
  /** The thread's list: a draft's pick or its start list, a started thread's `Session.mcpServers`. */
  readonly mcpServerIds: readonly string[];
  /** Where the list started, or why it is not known. `undefined` while the servers are not read yet. */
  readonly start: ThreadStartDecision | undefined;
  /** The words for the menu's "MCP servers" row. Until `views` is read they show the count alone. */
  readonly row: ThreadServersRow;
  /** Whether a write of the started thread's list is in flight, whichever control started it. The controls ignore clicks meanwhile. */
  readonly writing: boolean;
  /** Why the last write was refused, or `null`. It stays until the next write or `clearRefusal`. */
  readonly refusal: string | null;
  /** Applies the user's choice to the thread's list, resolved against the list as it is when the change is made. */
  readonly apply: (choice: McpListChoice) => void;
  readonly clearRefusal: () => void;
}

/**
 * Reads and writes the MCP Servers of the thread the composer belongs to.
 * This is the only place that knows the two kinds of thread apart:
 *
 * - A Draft Thread keeps its list as a pick, with the project the pick was
 *   made under (`recordThreadChoice`). It starts as its project's list, or
 *   the default list.
 * - A started thread edits its list at once (see `useMcpListEdit`). Each
 *   change is a choice, resolved against the session in the cache when the
 *   edit runs, so two quick changes never overwrite each other. One edit runs
 *   at a time for the session, whichever menu or picker started it, and the
 *   guard survives closing and opening them: `writing` stays true until the
 *   session has been read again, and, when that read fails, until a read
 *   succeeds. A refusal is `refusal`, and the list stays as the controller
 *   holds it.
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
  const found = projects.find((each) => each.id === projectId);
  const projectRecord: StartProjectRecord =
    found !== undefined
      ? { kind: "read", value: found }
      : addressed.error === null
        ? { kind: "pending" }
        : { kind: "failed", message: readErrorMessage(addressed.error) };

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

  const start: ThreadStartDecision | undefined =
    views === undefined
      ? undefined
      : decideThreadStartSource({
          projectId,
          project: projectRecord,
          defaultIds: { kind: "read", value: defaultIds },
          knownServerIds: new Set(views.map((view) => view.server.id)),
        });
  const mcpServerIds =
    session === null
      ? (resolveDraftMcpServerIds(picks, projectId, knownServerIds) ??
        (start?.kind === "start" ? start.start.mcpServerIds : undefined) ??
        storedIds)
      : storedIds;

  const edit = useMcpListEdit(client, {
    kind: "thread",
    sessionId: session?.id ?? "",
    projectId,
  });

  // A Draft Thread writes nothing: its choice is decided by the same rules and recorded with the
  // draft's other picks.
  const applyToDraft = (choice: McpListChoice): void => {
    const cache = buildMcpListCache(queryClient, client);
    const cachedViews = cache.readViews();
    if (cachedViews === undefined) return;
    // A reset resolves the start list when the user presses, not when the menu drew it.
    const source = decideThreadStartSource({
      projectId,
      ...cache.readStartRecords(projectId),
      knownServerIds: new Set(cachedViews.map((view) => view.server.id)),
    });
    const decided = decideMcpListChoice({
      ids: mcpServerIds,
      views: cachedViews,
      choice,
      start: source.kind === "start" ? source.start : undefined,
    });
    if (decided.kind === "write") {
      recordThreadChoice({ kind: "mcpServers", projectId, mcpServerIds: decided.mcpServerIds });
    }
  };

  return {
    views,
    readFailure: failure === null ? null : readErrorMessage(failure),
    mcpServerIds,
    start,
    row: describeThreadServersRow(views?.map((view) => view.server) ?? [], mcpServerIds),
    writing: edit.blocked,
    refusal: edit.problem(),
    apply: session === null ? applyToDraft : edit.apply,
    clearRefusal: edit.clearRefusal,
  };
};
