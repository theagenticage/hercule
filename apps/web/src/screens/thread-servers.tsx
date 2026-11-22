/**
 * What an open thread reads and shares about its MCP servers. One provider
 * per open thread, the thread's page or the Draft Thread's composer, owns
 * the reads and the live topic, so the composer's `+` menu, its submenu and
 * picker, and the thread's lines about servers never read or subscribe on
 * their own.
 */
import { createContext, useContext, useMemo, useState, type JSX, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { readErrorMessage } from "@hercule/client-core";
import { buildMcpServerViews, type McpServerView } from "@hercule/client-core/mcp-servers";
import {
  decideThreadServersDemand,
  describeThreadServers,
  type StartProjectRecord,
  type StartRecord,
  type ThreadServersDescription,
  type ThreadServersRecords,
} from "@hercule/client-core/mcp-servers/first-screen";
import type { PluginDetail, Session } from "@hercule/contract";
import { useRouteContext } from "@tanstack/react-router";
import { useLiveInvalidation } from "../app/live-invalidation";
import { buildStartRecord, readListedProject } from "../app/start-record";
import {
  connectionsQuery,
  mcpServersQuery,
  pluginsQuery,
  projectQuery,
  projectsQuery,
  settingsQuery,
} from "../app/queries";

/** What an open thread shares with the components that draw its servers. */
export interface ThreadServers {
  /** The thread's list, where it started, and the words of the `+` menu's row. */
  readonly described: ThreadServersDescription;
  /**
   * The servers joined with their Connections, built once for the thread.
   * `undefined` until a line about servers or the open menu or picker asks
   * for them and they are read.
   */
  readonly views: readonly McpServerView[] | undefined;
  /**
   * The plugins the servers were joined with, for the marks of the menu and
   * the picker. `undefined` exactly when `views` is.
   */
  readonly plugins: readonly PluginDetail[] | undefined;
  /** Why the servers could not be read, such as a token without `mcp.read`, or `null`. */
  readonly readFailure: string | null;
  /**
   * Tells the provider whether the MCP row of the `+` menu or the picker is
   * open, which is when the servers, their join and the start of the list
   * are read. The `+` menu keeps it true across the submenu's handoff to the
   * picker.
   */
  readonly setEditing: (editing: boolean) => void;
}

const ThreadServersContext = createContext<ThreadServers | null>(null);

/** What the provider describes: a started thread, or a Draft Thread with the list its picks hold. */
export type OpenThread =
  | {
      readonly kind: "started";
      readonly session: Session;
      /** Whether the transcript holds a line about MCP servers. */
      readonly hasMcpLine: boolean;
    }
  | {
      readonly kind: "draft";
      readonly projectId: string | null;
      /** The list the user picked, as `resolveDraftMcpServerIds` returns it. */
      readonly pickedIds: readonly string[] | undefined;
    };

/**
 * Returns the records of the thread's list: its project's and the default
 * list. The project list stops at its first page, so a started thread's
 * project may be missing from it without being gone: it is then read by its
 * id, but only while the editor is open. A draft's loader has read its
 * project already. The settings are the ones the app holds.
 */
function useStartRecords(
  isStarted: boolean,
  projectId: string | null,
  editing: boolean,
): Pick<ThreadServersRecords, "project" | "defaultIds"> {
  const { client } = useRouteContext({ from: "/_shell" });
  const projects = useQuery({ ...projectsQuery(client), enabled: false });
  const settings = useQuery({ ...settingsQuery(client), enabled: false });
  // Each record is built from the query's fields and kept while they stay the
  // same, so a render that only the transcript caused shares the same records.
  const listed = useMemo(
    () =>
      projectId === null
        ? null
        : readListedProject({ data: projects.data, error: projects.error }, projectId),
    [projects.data, projects.error, projectId],
  );
  const addressed = useQuery({
    ...projectQuery(client, projectId ?? ""),
    enabled: editing && isStarted && projectId !== null && listed === null,
  });
  const project = useMemo<StartProjectRecord>(
    () =>
      listed ?? buildStartRecord({ data: addressed.data, error: addressed.error }, (data) => data),
    [listed, addressed.data, addressed.error],
  );
  const defaultIds = useMemo<StartRecord<readonly string[]>>(
    () =>
      buildStartRecord(
        { data: settings.data, error: settings.error },
        (data) => data.user["thread.mcpServerIds"] ?? [],
      ),
    [settings.data, settings.error],
  );
  return { project, defaultIds };
}

/**
 * Renders `children` inside the servers of the open `thread`, the one owner
 * of its reads (spec 14 and spec 17 §What MCP servers cost):
 *
 * - The list of servers is read, and the `mcpServer` topic held, while the
 *   thread's stored list is not empty, its transcript holds a line about
 *   servers, or the menu or picker is open.
 * - The servers are joined with their Connections once, only for a line or
 *   the open menu or picker.
 * - A thread with no server, no line and nothing open reads nothing.
 *
 * Mount it once per open thread, above the composer and the transcript.
 */
export function ThreadServersProvider({
  thread,
  children,
}: {
  readonly thread: OpenThread;
  readonly children: ReactNode;
}): JSX.Element {
  const { client, live } = useRouteContext({ from: "/_shell" });
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const projectId = thread.kind === "started" ? thread.session.projectId : thread.projectId;
  const session = thread.kind === "started" ? thread.session : null;
  const hasMcpLine = thread.kind === "started" && thread.hasMcpLine;
  const pickedIds = thread.kind === "draft" ? thread.pickedIds : undefined;
  const { project, defaultIds } = useStartRecords(session !== null, projectId, editing);
  // Kept as it is while the records it holds do not change, so a streamed row
  // does not describe the thread again.
  const records = useMemo<ThreadServersRecords>(
    () => ({
      thread:
        session === null ? { kind: "draft", projectId, pickedIds } : { kind: "started", session },
      project,
      defaultIds,
      hasMcpLine,
      editing,
    }),
    [session, projectId, pickedIds, project, defaultIds, hasMcpLine, editing],
  );
  const demand = decideThreadServersDemand(records);
  useLiveInvalidation(live, queryClient, "mcpServer", demand.catalogue);
  const servers = useQuery({ ...mcpServersQuery(client), enabled: demand.catalogue });
  const connections = useQuery({ ...connectionsQuery(client), enabled: demand.views });
  const plugins = useQuery({ ...pluginsQuery(client), enabled: demand.views });
  const serverRecords = servers.data?.items;
  const connectionRecords = connections.data?.items;
  const views = useMemo(
    () =>
      demand.views &&
      serverRecords !== undefined &&
      connectionRecords !== undefined &&
      plugins.data !== undefined
        ? buildMcpServerViews(serverRecords, connectionRecords, plugins.data)
        : undefined,
    [demand.views, serverRecords, connectionRecords, plugins.data],
  );
  const described = useMemo(
    () => describeThreadServers(records, serverRecords),
    [records, serverRecords],
  );
  const failure = servers.error ?? connections.error ?? plugins.error;
  const readFailure = failure === null ? null : readErrorMessage(failure);
  // The plugins are those the views were joined with, so they are `undefined` together.
  const joinedPlugins = views === undefined ? undefined : plugins.data;
  const shared = useMemo<ThreadServers>(
    () => ({ described, views, plugins: joinedPlugins, readFailure, setEditing }),
    [described, views, joinedPlugins, readFailure],
  );
  return <ThreadServersContext value={shared}>{children}</ThreadServersContext>;
}

/**
 * Returns what the open thread shares about its servers. Fails outside a
 * `ThreadServersProvider`.
 */
export function useThreadServers(): ThreadServers {
  const servers = useContext(ThreadServersContext);
  if (servers === null) {
    throw new Error("useThreadServers needs a ThreadServersProvider above it.");
  }
  return servers;
}

/**
 * Returns the servers joined with their Connections for a line about servers,
 * or `undefined` until they are read.
 */
export function useThreadViews(): readonly McpServerView[] | undefined {
  return useThreadServers().views;
}
