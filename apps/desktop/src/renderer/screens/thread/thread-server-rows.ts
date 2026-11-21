/**
 * What the composer's `+` needs to draw itself from a thread's MCP servers:
 * the row that describes the thread's list (the words on the menu's "MCP
 * servers" row, and whether the `+` carries a red dot). The `+` menu
 * (`use-thread-servers.ts`) and the plain `+` that stands in for it until its
 * code has loaded (`plus-placeholder.tsx`) both use these hooks, so the two
 * draw the same `+` from the same records. They read nothing from the
 * controller. This file is part of the first screen, so it must not import
 * what joins servers with their Connections (`useMcpServerViews`).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import type { DraftView } from "@hercule/client-core";
import { describeThreadServersRow, type ThreadServersRow } from "@hercule/client-core/mcp-servers";
import type { McpServer, Project, Session } from "@hercule/contract";
import { mcpServersQuery, settingsQuery } from "../../app/queries";

/**
 * Returns the MCP servers the cache holds, or `undefined` until they are
 * read. Reads nothing itself, and draws again when the cache changes.
 */
export function useCachedMcpServers(): readonly McpServer[] | undefined {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  return useQuery({ ...mcpServersQuery(client), enabled: false }).data;
}

/** Returns the ids of the servers of the started thread `session`. */
export function useStartedThreadIds(session: Session): readonly string[] {
  return useMemo(
    () => session.mcpServers.map((server) => server.mcpServerId),
    [session.mcpServers],
  );
}

/** Returns the servers row of the started thread `session`. */
export function useStartedThreadRow(session: Session): ThreadServersRow {
  return describeThreadServersRow(useCachedMcpServers() ?? [], useStartedThreadIds(session));
}

/** What a Draft Thread's list of servers is made from. */
export interface DraftListRecords {
  /** The project the draft is in. `null` for no project. */
  readonly projectId: string | null;
  readonly projects: readonly Project[];
  /** The default list of servers, from the user's settings. */
  readonly defaultIds: readonly string[];
  /** The draft's own pick for this project, or `undefined` while it holds none. */
  readonly pick: readonly string[] | undefined;
  /**
   * The draft's list as the records hold it: its pick, else the list of its
   * project, else the default list. Until the servers are read, it may still
   * name a server deleted since, which only the count shows.
   */
  readonly recordedIds: readonly string[];
}

/** Returns the records the list of the Draft Thread `view` is made from. */
export function useDraftListRecords(view: DraftView): DraftListRecords {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const projectId = view.resolved.config.projectId ?? null;
  const { projects } = view.catalogs;
  // The new-thread route's loader caches the settings, and a draft never reads them itself.
  const settings = useQuery({ ...settingsQuery(client), enabled: false }).data;
  const defaultIds = settings?.user["thread.mcpServerIds"] ?? [];
  const pick = view.resolved.mcpServerIds;
  const recordedIds =
    pick ?? projects.find((each) => each.id === projectId)?.mcpServerIds ?? defaultIds;
  return { projectId, projects, defaultIds, pick, recordedIds };
}

/** Returns the servers row of the Draft Thread `view`. */
export function useDraftRow(view: DraftView): ThreadServersRow {
  const { recordedIds } = useDraftListRecords(view);
  return describeThreadServersRow(useCachedMcpServers() ?? [], recordedIds);
}
