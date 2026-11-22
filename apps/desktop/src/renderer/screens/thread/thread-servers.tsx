/**
 * What an open thread reads and shares about its MCP servers. One provider
 * per open thread, the thread's page or the Draft Thread's page, owns the
 * reads and the live topic, so the composer's `+`, its submenu and picker,
 * and the thread's lines about servers never read or subscribe on their own.
 * This file is part of the first screen: it imports nothing that joins
 * servers with their Connections or edits a list. Those load when the thread
 * first needs them (see `useMcpServerViews` and `use-thread-edits.ts`).
 */
import { createContext, useContext, useMemo, useState, type JSX, type ReactNode } from "react";
import { useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage, type DraftView, type ThreadBlock } from "@hercule/client-core";
import {
  decideThreadServersDemand,
  describeThreadServers,
  hasMcpServerBlock,
  type McpServerView,
  type StartProjectRecord,
  type StartRecord,
  type ThreadServersDescription,
  type ThreadServersRecords,
} from "@hercule/client-core/mcp-servers";
import type { MutableLiveTopic, Session } from "@hercule/contract";
import { useMcpServerViews } from "../../app/mcp-server-views";
import { MCP_SERVER_TOPICS, useScreenTopicsLive } from "../../app/live";
import {
  connectionsQuery,
  mcpServersQuery,
  pluginsQuery,
  projectsQuery,
  settingsQuery,
} from "../../app/queries";

const NO_TOPICS: readonly MutableLiveTopic[] = [];

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
  /** Why the list of servers could not be read, such as a token without `mcp.read`, or `null`. */
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

/** What the provider describes: a started thread, with its transcript's blocks, or a Draft Thread. */
export type OpenThread =
  | { readonly kind: "started"; readonly session: Session; readonly blocks: readonly ThreadBlock[] }
  | { readonly kind: "draft"; readonly view: DraftView };

/**
 * Returns whether the thread `sessionId` has shown a line about MCP servers.
 *
 * The answer only goes from false to true, because a transcript only grows.
 * So the blocks are scanned until a line is found, and never again after
 * that: a thread that streams a long answer does not pay a scan for every row
 * the stream delivers, and what the provider shares does not change per
 * token. The latch names its thread, since the page that holds it is drawn
 * again with the next thread's blocks.
 */
function useHasMcpLine(sessionId: string | null, blocks: readonly ThreadBlock[]): boolean {
  const [foundIn, setFoundIn] = useState<string | null>(null);
  if (sessionId === null) return false;
  if (foundIn === sessionId) return true;
  const found = hasMcpServerBlock(blocks);
  // Written during the render, so the latch holds from the next one.
  if (found) setFoundIn(sessionId);
  return found;
}

/**
 * Returns the records of the thread's list: its project's and the default
 * list. The projects are the shell's, so they are in the cache. The settings
 * are read only while the editor is open for a thread in no project, from
 * the cache first, because only then is the default list the start.
 */
function useStartRecords(
  projectId: string | null,
  editing: boolean,
): Pick<ThreadServersRecords, "project" | "defaultIds"> {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const projects = useSuspenseQuery(projectsQuery(client)).data;
  const settings = useQuery({ ...settingsQuery(client), enabled: editing && projectId === null });
  const found = projects.find((each) => each.id === projectId);
  const project: StartProjectRecord =
    projectId === null
      ? { kind: "pending" }
      : found === undefined
        ? { kind: "missing" }
        : { kind: "read", value: found };
  const defaultIds: StartRecord<readonly string[]> =
    settings.data !== undefined
      ? { kind: "read", value: settings.data.user["thread.mcpServerIds"] ?? [] }
      : settings.error === null
        ? { kind: "pending" }
        : { kind: "failed", message: readErrorMessage(settings.error) };
  return { project, defaultIds };
}

/**
 * Renders `children` inside the servers of the open `thread`, the one owner
 * of its reads (spec 17 §What MCP servers cost):
 *
 * - The list of servers is read, and the `mcpServer` topic held, while the
 *   thread's stored list is not empty, its transcript holds a line about
 *   servers, or the menu or picker is open.
 * - The servers are joined with their Connections only for a line or the
 *   open menu or picker.
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
  const hasMcpLine = useHasMcpLine(
    thread.kind === "started" ? thread.session.id : null,
    thread.kind === "started" ? thread.blocks : [],
  );
  const projectId =
    thread.kind === "started"
      ? thread.session.projectId
      : (thread.view.resolved.config.projectId ?? null);
  const startRecords = useStartRecords(projectId, editing);
  const records: ThreadServersRecords = {
    thread:
      thread.kind === "started"
        ? { kind: "started", session: thread.session }
        : { kind: "draft", projectId, pickedIds: thread.view.resolved.mcpServerIds },
    ...startRecords,
    hasMcpLine,
    editing,
  };
  const demand = decideThreadServersDemand(records);
  useScreenTopicsLive(live, queryClient, demand.catalogue ? MCP_SERVER_TOPICS : NO_TOPICS);
  const servers = useQuery({ ...mcpServersQuery(client), enabled: demand.catalogue });
  const connections = useQuery({ ...connectionsQuery(client), enabled: demand.views });
  const plugins = useQuery({ ...pluginsQuery(client), enabled: demand.views });
  const views = useMcpServerViews(demand.views, servers.data, connections.data, plugins.data);
  const described = describeThreadServers(records, servers.data);
  const readFailure = servers.error === null ? null : readErrorMessage(servers.error);
  const shared = useMemo(
    () => ({ described, views, readFailure, setEditing }),
    [described, views, readFailure],
  );
  return <ThreadServersContext value={shared}>{children}</ThreadServersContext>;
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
 * Returns the servers joined with their Connections for a line about servers,
 * or `undefined` until they are read, and on a page with no provider, such as
 * a subagent's, which reads no servers.
 */
export function useThreadViews(): readonly McpServerView[] | undefined {
  return useContext(ThreadServersContext)?.views;
}
