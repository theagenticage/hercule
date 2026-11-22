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

/** Builds the start list of `ids`, the stored ids of a project's list or of the default list, against the servers the catalogue knows. */
const buildStartList = (
  source: ThreadStartSource,
  ids: readonly string[],
  knownServerIds: ReadonlySet<string>,
): ThreadStartList => {
  const known = ids.filter((id) => knownServerIds.has(id));
  return { mcpServerIds: known, source, complete: known.length === ids.length };
};

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
  const knownServerIds = new Set(views.map((view) => view.server.id));
  const project = projects.find((each) => each.id === projectId);
  if (project !== undefined) {
    return buildStartList(
      { kind: "project", projectName: project.name },
      project.mcpServerIds,
      knownServerIds,
    );
  }
  const list = buildStartList({ kind: "default" }, defaultIds, knownServerIds);
  return list.mcpServerIds.length === 0 ? { ...list, source: { kind: "none" } } : list;
};

/** What a record the start list needs is, as the app's cache holds it. */
export type StartRecord<Value> =
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "read"; readonly value: Value };

/** The addressed project's record: a `StartRecord`, or `missing` when the project is read and does not exist. */
export type StartProjectRecord = StartRecord<Project> | { readonly kind: "missing" };

/** What `decideThreadStartSource` decided. */
export type ThreadStartDecision =
  /** A record the start list needs has not answered yet. */
  | { readonly kind: "pending" }
  /** A record the start list needs could not be read. */
  | { readonly kind: "failed"; readonly message: string }
  /** The Thread's project does not exist. Only going back to the start list is lost: the Thread's own switches work. */
  | { readonly kind: "missing" }
  | { readonly kind: "start"; readonly start: ThreadStartList };

/**
 * Returns where a Thread's list started, from the records as the cache holds
 * them: the Thread's project (`project`, used when `projectId` is not
 * `null`) or the default list (`defaultIds`, used for a Thread in no
 * project), against the ids of the servers the catalogue knows.
 *
 * A record that is pending or failed, or a project that is missing, gives no
 * start list and says why, so a control words its foot from the reason and
 * disables only the way back to the start list. `complete` is false while the
 * source holds an id the catalogue does not know.
 */
export const decideThreadStartSource = ({
  projectId,
  project,
  defaultIds,
  knownServerIds,
}: {
  readonly projectId: string | null;
  readonly project: StartProjectRecord;
  readonly defaultIds: StartRecord<readonly string[]>;
  readonly knownServerIds: ReadonlySet<string>;
}): ThreadStartDecision => {
  if (projectId !== null) {
    if (project.kind !== "read") return project;
    return {
      kind: "start",
      start: buildStartList(
        { kind: "project", projectName: project.value.name },
        project.value.mcpServerIds,
        knownServerIds,
      ),
    };
  }
  if (defaultIds.kind !== "read") return defaultIds;
  const list = buildStartList({ kind: "default" }, defaultIds.value, knownServerIds);
  return {
    kind: "start",
    start: list.mcpServerIds.length === 0 ? { ...list, source: { kind: "none" } } : list,
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

/** Checks that two lists hold the same ids, whatever their order. */
const holdSameIds = (one: readonly string[], other: readonly string[]): boolean =>
  one.length === other.length && one.every((id) => other.includes(id));

/**
 * Returns the line at the foot of the submenu and the picker of a Thread
 * whose list is `mcpServerIds`, and the button that goes back to the start
 * list, which is `null` while the start list is not known, is not `complete`
 * or equals the list.
 */
export const describeThreadStartFoot = (
  decision: ThreadStartDecision,
  mcpServerIds: readonly string[],
): { readonly foot: string; readonly reset: { readonly label: string } | null } => {
  switch (decision.kind) {
    case "pending":
      return { foot: "Reading where this list started…", reset: null };
    case "failed":
      return {
        foot: `Where this list started could not be read (${decision.message}). Changes are for this thread only.`,
        reset: null,
      };
    case "missing":
      return {
        foot: "This thread's project no longer exists. Changes are for this thread only.",
        reset: null,
      };
    case "start": {
      const { line, resetLabel } = describeStartLine(decision.start);
      return {
        foot: line,
        reset:
          !decision.start.complete || holdSameIds(mcpServerIds, decision.start.mcpServerIds)
            ? null
            : { label: resetLabel },
      };
    }
  }
};
