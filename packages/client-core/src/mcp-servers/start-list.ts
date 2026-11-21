/**
 * Where a Thread's list of MCP Servers starts, and the words that say so in
 * the composer's menu and picker (spec 17, the composer's `+` menu).
 */
import type { Project } from "@hercule/contract";
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
  /**
   * False while the source list holds an id that no view knows. Either the
   * server was deleted, or the list of servers has not caught up with a server
   * just added. The unknown ids are left out of `mcpServerIds` either way.
   */
  readonly complete: boolean;
}

/**
 * Returns the list a Thread starts with: its project's list, even when that
 * list is empty, and for a Thread in no project the default list. A list is
 * not always rewritten when a server is deleted, so ids no view knows are
 * dropped from either list, and `complete` is then false. The source is `none` when a Thread in no project
 * starts with an empty list.
 *
 * A `projectId` that is not in `projects` is read as no project.
 */
export const decideThreadStartList = (
  projectId: string | null,
  projects: readonly Project[],
  defaultIds: readonly string[],
  views: readonly McpServerView[],
): ThreadStartList => {
  const isKnown = (id: string): boolean => views.some((view) => view.server.id === id);
  const project = projects.find((each) => each.id === projectId);
  if (project !== undefined) {
    const known = project.mcpServerIds.filter(isKnown);
    return {
      mcpServerIds: known,
      source: { kind: "project", projectName: project.name },
      complete: known.length === project.mcpServerIds.length,
    };
  }
  const known = defaultIds.filter(isKnown);
  return {
    mcpServerIds: known,
    source: known.length === 0 ? { kind: "none" } : { kind: "default" },
    complete: known.length === defaultIds.length,
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
