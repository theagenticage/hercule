/**
 * What an open thread reads and shares about its MCP servers. One provider
 * per open thread, the thread's page or the Draft Thread's page, owns the
 * reads and the live topic, so the composer's `+`, its submenu and picker,
 * and the thread's lines about servers never read or subscribe on their own.
 * This file is part of the first screen: it imports nothing that joins
 * servers with their Connections or edits a list. Those load when the thread
 * first needs them (see `thread-servers-join.tsx` and `use-thread-edits.ts`).
 */
import {
  createContext,
  Suspense,
  useContext,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage, type DraftView } from "@hercule/client-core";
import {
  decideThreadServersDemand,
  describeThreadServers,
  type StartProjectRecord,
  type StartRecord,
  type ThreadServersDescription,
  type ThreadServersRecords,
  type ThreadStartDecision,
} from "@hercule/client-core/mcp-servers/first-screen";
import type { McpServerView } from "@hercule/client-core/mcp-servers";
import type { MutableLiveTopic, PluginDetail, Session } from "@hercule/contract";
import { buildStartRecord } from "../../app/start-record";
import { MCP_SERVER_TOPICS, useScreenTopicsLive } from "../../app/live";
import { mcpServersQuery, projectsQuery, settingsQuery } from "../../app/queries";
import { LazyThreadServersJoin } from "./lazy-thread-servers";

const NO_TOPICS: readonly MutableLiveTopic[] = [];

/** What an open thread shares with the components that draw its servers. */
export interface ThreadServers {
  /** The thread's list and the words of the `+` menu's row. */
  readonly described: ThreadServersDescription;
  /**
   * Where the list started, or why that is not known. `undefined` until the
   * menu or picker is open and its code has joined the servers.
   */
  readonly start: ThreadStartDecision | undefined;
  /**
   * The plugins the servers were joined with, for the marks of the menu and
   * the picker. `undefined` exactly when `useThreadViews` returns
   * `undefined`: the provider reads both once, for the thread.
   */
  readonly plugins: readonly PluginDetail[] | undefined;
  /** Why the servers could not be read, such as a token without `mcp.read`, or `null`. */
  readonly readFailure: string | null;
  /**
   * Tells the provider whether the MCP row of the `+` menu or the picker is
   * open, which is when the servers, their join and the start of the list
   * are read. The `+` menu calls it, and keeps it true across the submenu's
   * handoff to the picker.
   */
  readonly setEditing: (editing: boolean) => void;
}

/**
 * The context `ThreadServersProvider` fills. It is exported so a test of one
 * component can supply the servers it needs without the reads.
 */
export const ThreadServersContext = createContext<ThreadServers | null>(null);

/**
 * The servers joined with their Connections, which a line about servers, the
 * open menu and the picker draw. Filled by `ThreadServersProvider`, and by
 * `CachedThreadViews` (in `thread-servers-join.tsx`) for a transcript that
 * has no provider.
 */
export const ThreadViewsContext = createContext<readonly McpServerView[] | undefined>(undefined);

/**
 * What the provider describes: a started thread, with whether its transcript
 * holds a line about servers (see `useHasMcpLine`), or a Draft Thread.
 */
export type OpenThread =
  | { readonly kind: "started"; readonly session: Session; readonly hasMcpLine: boolean }
  | { readonly kind: "draft"; readonly view: DraftView };

/**
 * Returns the records of the thread's list: its project's and the default
 * list. The projects are the shell's, so they are in the cache. The settings
 * are only observed here, from the cache: the editor's code reads them when
 * it opens for a thread in no project (see `ThreadServersJoin`), because
 * only then is the default list the start.
 */
function useStartRecords(
  projectId: string | null,
): Pick<ThreadServersRecords, "project" | "defaultIds"> {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const projects = useSuspenseQuery(projectsQuery(client));
  const settings = useQuery({ ...settingsQuery(client), enabled: false });
  // The same rule as the edits' dispatch: after a failed refresh of the
  // projects the cached ones may be obsolete, so the project is `failed`.
  const listed = buildStartRecord({ data: projects.data, error: projects.error }, (items) =>
    items.find((each) => each.id === projectId),
  );
  const project: StartProjectRecord =
    projectId === null
      ? { kind: "pending" }
      : listed.kind !== "read"
        ? listed
        : listed.value === undefined
          ? { kind: "missing" }
          : { kind: "read", value: listed.value };
  // The fields, not the query's result, which is a new object on every render.
  const defaultIds: StartRecord<readonly string[]> = buildStartRecord(
    { data: settings.data, error: settings.error },
    (data) => data.user["thread.mcpServerIds"] ?? [],
  );
  return { project, defaultIds };
}

/**
 * What the code that opens with a line, the menu or the picker reports back
 * to the provider: the servers joined with their Connections and plugins,
 * where the list started, and why a read failed.
 */
export interface ThreadServersJoined {
  readonly views: readonly McpServerView[] | undefined;
  /** The plugins the views were joined with, so `undefined` exactly when `views` is. */
  readonly plugins: readonly PluginDetail[] | undefined;
  readonly start: ThreadStartDecision | undefined;
  /** The error of the Connections or plugins read, or `null`. */
  readonly failure: Error | null;
}

/**
 * Renders `children` inside the servers of the open `thread`, the one owner
 * of its reads (spec 17 §What MCP servers cost):
 *
 * - The list of servers is read, and the `mcpServer` topic held, while the
 *   thread's stored list is not empty, its transcript holds a line about
 *   servers, or the menu or picker is open.
 * - The servers are joined with their Connections only for a line or the
 *   open menu or picker. The code that reads and joins them loads then (see
 *   `ThreadServersJoin`) and reports back what it built.
 * - The settings are read only for the open menu or picker of a thread in no
 *   project.
 * - A thread with no server, no line and nothing open reads nothing.
 *
 * Mount it once per open thread, above the composer and the transcript. What
 * it shares changes when the records do, never per streamed token.
 */
export function ThreadServersProvider({
  thread,
  children,
}: {
  readonly thread: OpenThread;
  readonly children: ReactNode;
}): JSX.Element {
  const { client, live } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [joined, setJoined] = useState<ThreadServersJoined | undefined>(undefined);
  const projectId =
    thread.kind === "started"
      ? thread.session.projectId
      : (thread.view.resolved.config.projectId ?? null);
  const { project, defaultIds } = useStartRecords(projectId);
  // Kept as it is while the records it holds do not change, so a streamed row
  // does not describe the thread again.
  const records = useMemo<ThreadServersRecords>(
    () => ({
      thread:
        thread.kind === "started"
          ? { kind: "started", session: thread.session }
          : { kind: "draft", projectId, pickedIds: thread.view.resolved.mcpServerIds },
      project,
      defaultIds,
      hasMcpLine: thread.kind === "started" && thread.hasMcpLine,
      editing,
    }),
    [thread, projectId, project, defaultIds, editing],
  );
  const demand = decideThreadServersDemand(records);
  useScreenTopicsLive(live, queryClient, demand.catalogue ? MCP_SERVER_TOPICS : NO_TOPICS);
  const servers = useQuery({ ...mcpServersQuery(client), enabled: demand.catalogue });
  const described = useMemo(
    () => describeThreadServers(records, servers.data),
    [records, servers.data],
  );
  // What was joined for an earlier line or menu is dropped once none is wanted.
  const join = demand.views ? joined : undefined;
  const failure = servers.error ?? join?.failure ?? null;
  const readFailure = failure === null ? null : readErrorMessage(failure);
  const shared = useMemo(
    () => ({
      described,
      start: join?.start,
      plugins: join?.plugins,
      readFailure,
      setEditing,
    }),
    [described, join, readFailure],
  );
  return (
    <>
      <ThreadServersContext value={shared}>
        <ThreadViewsContext value={join?.views}>{children}</ThreadViewsContext>
      </ThreadServersContext>
      <Suspense fallback={null}>
        {demand.views ? (
          <LazyThreadServersJoin
            records={records}
            projectId={projectId}
            servers={servers.data}
            onJoined={setJoined}
          />
        ) : null}
      </Suspense>
    </>
  );
}

/**
 * Returns what the open thread shares about its servers. Fails outside a
 * `ThreadServersProvider`: the `+` menu and its submenu and picker are drawn
 * only for a thread that mounts one.
 */
export function useThreadServers(): ThreadServers {
  const servers = useContext(ThreadServersContext);
  if (servers === null) {
    throw new Error("useThreadServers needs a ThreadServersProvider above it.");
  }
  return servers;
}

/**
 * Returns the servers joined with their Connections, or `undefined` until
 * they are read, and where no provider reads them, such as a subagent's page.
 */
export function useThreadViews(): readonly McpServerView[] | undefined {
  return useContext(ThreadViewsContext);
}
