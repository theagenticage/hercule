/**
 * Where a Thread's list of MCP Servers starts, and the words that say so in
 * the composer's menu and picker (spec 17, the composer's `+` menu).
 */
import type { Project } from "@hercule/contract";
import type { ThreadPicks } from "../threads/config";
import type { McpServerView } from "./views";

/** Where a Thread's list started. */
export type ThreadStartSource =
  | { readonly kind: "project"; readonly projectName: string }
  | { readonly kind: "default" }
  | { readonly kind: "none" };

/** The list a new Thread starts with, and where it comes from. */
export interface ThreadStartList {
  readonly mcpServerIds: readonly string[];
  readonly source: ThreadStartSource;
}

/**
 * Returns the list a Thread starts with: its project's list, even when that
 * list is empty, and for a Thread in no project the default list. The default
 * list is not rewritten when a server is deleted, so ids no view knows are
 * dropped from it. The source is `none` when a Thread in no project starts
 * with an empty list.
 *
 * A `projectId` that is not in `projects` is read as no project.
 */
export const decideThreadStartList = (
  projectId: string | null,
  projects: readonly Project[],
  defaultIds: readonly string[],
  views: readonly McpServerView[],
): ThreadStartList => {
  const project = projects.find((each) => each.id === projectId);
  if (project !== undefined) {
    return {
      mcpServerIds: project.mcpServerIds,
      source: { kind: "project", projectName: project.name },
    };
  }
  const known = defaultIds.filter((id) => views.some((view) => view.server.id === id));
  return {
    mcpServerIds: known,
    source: known.length === 0 ? { kind: "none" } : { kind: "default" },
  };
};

/**
 * Returns the line under the menu or the picker that says where the list
 * started, and the label of the button that goes back to it.
 */
export const describeStartLine = (
  start: ThreadStartList,
): { readonly line: string; readonly resetLabel: string } => {
  const { source } = start;
  switch (source.kind) {
    case "project":
      return {
        line: `Starts from ${source.projectName}'s list. Changes are for this thread only.`,
        resetLabel: `Back to ${source.projectName}'s list`,
      };
    case "default":
      return {
        line: "Starts from the default list. Changes are for this thread only.",
        resetLabel: "Back to the default list",
      };
    case "none":
      return {
        line: "A thread in no project starts with no servers. Switch on what this one needs.",
        resetLabel: "Switch all off",
      };
  }
};

/**
 * Returns the list a Draft Thread sends as `mcpServerIds`, or `undefined`
 * when the user has not changed the list, so the draft sends none and a
 * default changed meanwhile still applies.
 *
 * The pick holds the project it was made under, and applies only while the
 * draft is in that project. A list chosen for one project must not decide the
 * servers of a thread started in another. An explicit empty list stays
 * empty: it is the user's choice of no servers.
 *
 * Ids no view knows (a server deleted since the pick) are dropped, as the
 * controller drops them from every list it stores. `views` is `undefined`
 * while the catalogue has not been read, and then nothing is dropped.
 */
export const resolveDraftMcpServerIds = (
  picks: ThreadPicks,
  projectId: string | null,
  views: readonly McpServerView[] | undefined,
): readonly string[] | undefined => {
  const pick = picks.mcpServers;
  if (pick === undefined || pick.projectId !== projectId) return undefined;
  return views === undefined
    ? pick.mcpServerIds
    : pick.mcpServerIds.filter((id) => views.some((view) => view.server.id === id));
};
