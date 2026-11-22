/**
 * The desktop app's side of the edits of MCP lists (see `list-edits.ts` in
 * client-core): how this app's query cache holds the lists, and the hook every
 * control that edits one uses.
 */
import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient, type DataTag, type QueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import type { Project } from "@hercule/contract";
import {
  buildMcpServerViews,
  describeMcpListProblem,
  buildMcpListQuery,
  findOrCreateMcpListEdits,
  type McpListCache,
  type McpListChoice,
  type McpListEditState,
  type McpListEdits,
  type McpListRefusal,
  type McpListTarget,
  type StartProjectRecord,
  type StartRecord,
} from "@hercule/client-core/mcp-servers";
import {
  connectionsQuery,
  mcpServersQuery,
  pluginsQuery,
  projectsQuery,
  sessionQuery,
  settingsQuery,
} from "./queries";

/**
 * Returns what the cache holds of the query `options`, as a start record:
 * the value `pick` makes of its data, the reason it failed, or pending.
 */
const readStartRecord = <Data, Value>(
  queryClient: QueryClient,
  options: { readonly queryKey: DataTag<readonly unknown[], Data, Error> },
  pick: (data: Data) => Value,
): StartRecord<Value> => {
  const state = queryClient.getQueryState(options.queryKey);
  if (state?.data !== undefined) return { kind: "read", value: pick(state.data) };
  return state?.status === "error"
    ? { kind: "failed", message: readErrorMessage(state.error) }
    : { kind: "pending" };
};

/** Returns the record of the project `projectId` among `projects`, which is every project, or `missing`. */
const readProject = (projects: readonly Project[], projectId: string): StartProjectRecord => {
  const project = projects.find((each) => each.id === projectId);
  return project === undefined ? { kind: "missing" } : { kind: "read", value: project };
};

/** Returns the views of every server as the cache holds them, or `undefined` while a read they need is missing. */
export const readCachedMcpServerViews = (
  queryClient: QueryClient,
  client: HerculeClient,
): ReturnType<McpListCache["readViews"]> => {
  const servers = queryClient.getQueryData(mcpServersQuery(client).queryKey);
  const connections = queryClient.getQueryData(connectionsQuery(client).queryKey);
  const plugins = queryClient.getQueryData(pluginsQuery(client).queryKey);
  return servers === undefined || connections === undefined || plugins === undefined
    ? undefined
    : buildMcpServerViews(servers, connections, plugins);
};

/** Returns how this app's query cache holds the lists of MCP servers. */
export const buildMcpListCache = (
  queryClient: QueryClient,
  client: HerculeClient,
): McpListCache => ({
  readList: (target) => {
    switch (target.kind) {
      case "thread":
        return queryClient
          .getQueryData(sessionQuery(client, target.sessionId).queryKey)
          ?.mcpServers.map((server) => server.mcpServerId);
      case "project":
        return queryClient
          .getQueryData(projectsQuery(client).queryKey)
          ?.find((project) => project.id === target.projectId)?.mcpServerIds;
      case "default": {
        const settings = queryClient.getQueryData(settingsQuery(client).queryKey);
        return settings === undefined ? undefined : (settings.user["thread.mcpServerIds"] ?? []);
      }
    }
  },
  readBase: (target) => {
    switch (target.kind) {
      case "thread":
        return buildMcpListQuery(queryClient, sessionQuery(client, target.sessionId));
      case "project":
        return buildMcpListQuery(queryClient, projectsQuery(client));
      case "default":
        return buildMcpListQuery(queryClient, settingsQuery(client));
    }
  },
  readOtherKeys: () => [],
  readViews: () => readCachedMcpServerViews(queryClient, client),
  readCatalogue: () => buildMcpListQuery(queryClient, mcpServersQuery(client)),
  readStartRecords: (projectId) => {
    const projects = readStartRecord(queryClient, projectsQuery(client), (data) => data);
    // A thread in no project has no project record, and the decision never reads it.
    const project: StartProjectRecord =
      projects.kind !== "read"
        ? projects
        : projectId === null
          ? { kind: "pending" }
          : readProject(projects.value, projectId);
    return {
      project,
      defaultIds: readStartRecord(
        queryClient,
        settingsQuery(client),
        (settings) => settings.user["thread.mcpServerIds"] ?? [],
      ),
    };
  },
});

/** What a control that edits a list gets from `useMcpListEdit`. */
export interface McpListEdit {
  /** Applies the user's choice to the list as it is now. Does nothing while `blocked`. */
  readonly apply: (choice: McpListChoice) => void;
  /** Whether an edit of the list runs, started by any control, or the list could not be read again after one. */
  readonly blocked: boolean;
  /** Why the last edit was not made, such as a refusal of the controller, or `null`. */
  readonly refusal: McpListRefusal | null;
  /**
   * Returns what to show for the list, or `null`: why the last edit was not
   * made, with `prefix` before the controller's reason, or that a saved
   * change could not be read again.
   */
  readonly problem: (prefix?: string) => string | null;
  /** Forgets the refusal, when the user dismisses it. */
  readonly clearRefusal: () => void;
}

/** Returns the edits of this app's query cache: one instance for each query client. */
export function useMcpListEdits(): McpListEdits {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  return findOrCreateMcpListEdits({
    queryClient,
    client,
    cache: buildMcpListCache(queryClient, client),
  });
}

/**
 * Returns the edits of the list `target`, shared by every control of the app
 * that edits it. The guard and the refusal belong to the list, not to the
 * control, so closing and opening a menu or dialog keeps them. The refusal
 * is dropped when the component that calls this hook unmounts, which is the
 * screen or the composer, never the menu or dialog opened from it.
 */
export function useMcpListEdit(target: McpListTarget): McpListEdit {
  const edits = useMcpListEdits();
  const state: McpListEditState = useSyncExternalStore(edits.subscribe, () =>
    edits.readState(target),
  );
  const key = JSON.stringify(target);
  useEffect(() => {
    const mine = JSON.parse(key) as McpListTarget;
    return () => {
      edits.clearRefusal(mine);
    };
  }, [edits, key]);
  return {
    apply: (choice) => {
      edits.apply(target, choice);
    },
    blocked: state.blocked,
    refusal: state.refusal,
    problem: (prefix) => describeMcpListProblem(state, prefix),
    clearRefusal: () => {
      edits.clearRefusal(target);
    },
  };
}
