/**
 * The servers joined with their Connections for a transcript outside any
 * thread's page, such as the first moments of a thread in the Inbox. It lives
 * apart from `thread-servers-join.tsx` because the Inbox loads it with the
 * transcript: the code that joins the servers (`useMcpServerViews`) loads
 * only when a line about servers is there, and the provider's join, with the
 * start decisions, never loads for a transcript.
 */
import type { JSX, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { useMcpServerViews } from "../../app/mcp-server-views";
import { connectionsQuery, mcpServersQuery, pluginsQuery } from "../../app/queries";
import { ThreadViewsContext } from "./thread-servers";

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
