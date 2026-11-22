/**
 * What an open thread needs once a line about its MCP servers, the open menu
 * or the picker asks for them: the Connections and plugins the servers are
 * joined with, the code that joins them and decides where the thread's list
 * started, and the settings it may start from. This code is not part of the
 * first screen: the provider loads it the first time it is wanted (see
 * `ThreadServersProvider`).
 */
import { useLayoutEffect, useMemo, type JSX, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import {
  buildMcpServerViews,
  decideThreadStart,
  type ThreadServersRecords,
} from "@hercule/client-core/mcp-servers";
import type { McpServer } from "@hercule/contract";
import { useMcpServerViews } from "../../app/mcp-server-views";
import { connectionsQuery, mcpServersQuery, pluginsQuery, settingsQuery } from "../../app/queries";
import {
  ThreadViewsContext,
  type ThreadServersJoin,
  type ThreadServersJoined,
} from "./thread-servers";

/**
 * Reads the Connections and plugins and hands `onJoined` the function that
 * joins the servers with them and decides where the list started. Renders
 * nothing. It also reads the settings while the menu or picker is `editing`
 * for a thread in no project (`projectId` is `null`), because only then is the
 * default list the start.
 *
 * The provider calls that function itself, in its own render, so nothing it
 * returns can belong to older records than the ones the provider holds.
 * `onJoined` receives `undefined` when this unmounts, so the provider never
 * keeps a join that nothing wants.
 */
export function ThreadServersJoin({
  editing,
  projectId,
  onJoined,
}: {
  readonly editing: boolean;
  readonly projectId: string | null;
  readonly onJoined: (joined: ThreadServersJoined | undefined) => void;
}): null {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  useQuery({ ...settingsQuery(client), enabled: editing && projectId === null });
  const connections = useQuery(connectionsQuery(client));
  const plugins = useQuery(pluginsQuery(client));
  const joined = useMemo<ThreadServersJoined>(
    () => ({
      joinServers: (
        records: ThreadServersRecords,
        servers: readonly McpServer[] | undefined,
      ): ThreadServersJoin => {
        const views =
          servers === undefined || connections.data === undefined || plugins.data === undefined
            ? undefined
            : buildMcpServerViews(servers, connections.data, plugins.data);
        return {
          views,
          // The plugins are those the views were joined with, so they are `undefined` together.
          plugins: views === undefined ? undefined : plugins.data,
          start: records.editing ? decideThreadStart(records, servers) : undefined,
        };
      },
      failure: connections.error ?? plugins.error,
    }),
    [connections.data, connections.error, plugins.data, plugins.error],
  );
  // A layout effect, so that with the module loaded and the records cached, the provider has the
  // join before the menu's first paint and the menu does not flash its loading note.
  useLayoutEffect(() => {
    onJoined(joined);
    return () => {
      onJoined(undefined);
    };
  }, [joined, onJoined]);
  return null;
}

/**
 * Renders `children` with the servers joined from what the cache holds, for a
 * transcript outside any thread's page, such as the first moments of a thread
 * in the Inbox. It reads and subscribes to nothing, so its lines draw their
 * fix buttons only when the servers are cached already. `hasMcpLine` is
 * whether the transcript holds a line about servers (see `useHasMcpLine`):
 * the code that joins them loads only then.
 */
export function CachedThreadViews({
  hasMcpLine,
  children,
}: {
  readonly hasMcpLine: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const servers = useQuery({ ...mcpServersQuery(client), enabled: false });
  const connections = useQuery({ ...connectionsQuery(client), enabled: false });
  const plugins = useQuery({ ...pluginsQuery(client), enabled: false });
  const views = useMcpServerViews(hasMcpLine, servers.data, connections.data, plugins.data);
  return <ThreadViewsContext value={views}>{children}</ThreadViewsContext>;
}
