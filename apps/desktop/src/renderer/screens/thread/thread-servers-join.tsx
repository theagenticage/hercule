/**
 * What an open thread needs once a line about its MCP servers, the open menu
 * or the picker asks for them: the Connections and plugins the servers are
 * joined with, where the thread's list started, and the settings it may
 * start from. This code is not part of the first screen: the provider loads
 * it the first time it is wanted (see `ThreadServersProvider`).
 */
import { useEffect, useMemo, type JSX, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { decideThreadStart, type ThreadServersRecords } from "@hercule/client-core/mcp-servers";
import type { McpServer } from "@hercule/contract";
import { useMcpServerViews } from "../../app/mcp-server-views";
import { connectionsQuery, mcpServersQuery, pluginsQuery, settingsQuery } from "../../app/queries";
import { ThreadViewsContext, type ThreadServersJoined } from "./thread-servers";

/**
 * Reads the Connections and plugins, joins them with `servers`, decides where
 * the list of `records` started, and hands the result to `onJoined`. Renders
 * nothing. It also reads the settings while the editor is open for a thread
 * in no project (`projectId` is `null`), because only then is the default
 * list the start.
 *
 * `onJoined` receives `undefined` when this unmounts, so the provider never
 * keeps a join that nothing wants.
 */
export function ThreadServersJoin({
  records,
  projectId,
  servers,
  onJoined,
}: {
  readonly records: ThreadServersRecords;
  readonly projectId: string | null;
  readonly servers: readonly McpServer[] | undefined;
  readonly onJoined: (joined: ThreadServersJoined | undefined) => void;
}): null {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  useQuery({ ...settingsQuery(client), enabled: records.editing && projectId === null });
  const connections = useQuery(connectionsQuery(client));
  const plugins = useQuery(pluginsQuery(client));
  const views = useMcpServerViews(true, servers, connections.data, plugins.data);
  const joined = useMemo<ThreadServersJoined>(
    () => ({
      views,
      // The plugins are those the views were joined with, so they are `undefined` together.
      plugins: views === undefined ? undefined : plugins.data,
      start: records.editing ? decideThreadStart(records, servers) : undefined,
      failure: connections.error ?? plugins.error,
    }),
    [views, plugins.data, plugins.error, connections.error, records, servers],
  );
  useEffect(() => {
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
