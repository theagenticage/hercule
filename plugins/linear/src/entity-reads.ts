/**
 * Turns what Linear returns into External Entity observations. The `entities`
 * feed (`ingest/entities.ts`) and the Add button's lookup (`entity-lookup.ts`)
 * share it, so a thing reads the same whichever way it was found.
 *
 * The plugin reports raw `fields` and a status key. The tables in
 * `entity-kinds.ts` say how a card shows them.
 */
import { MAX_EVENT_TITLE_LENGTH, type EntityObservation } from "@hercule/plugin-host";
import type { WorkspaceBlock } from "./kinds";
import type { ApiIssue } from "./linear-objects";
import { buildIssueRef } from "./ingest/events";
import { ISSUE_KIND } from "./entity-kinds";
import { cutName, cutText } from "./text";

/** The concerns the `entities` feed reports for an issue. The host sets the others. */
export type EntityConcern = "assigned";

/** The longest `word` fact the public API takes. */
const MAX_WORD_FACT_LENGTH = 80;

/** What a `linear:<kind>:<workspace id>/<id>` ref is made of. */
export interface ParsedRef {
  /** The kind in the ref, such as `issue` or `project`. */
  readonly kind: string;
  readonly workspaceId: string;
  /** The id Linear gives the thing, not its identifier (`SHOP-123`). */
  readonly id: string;
}

const REF_PATTERN = /^linear:([a-z]+):([^/]+)\/(.+)$/;

/** Splits a Linear External Ref into its kind, workspace id and id. Returns undefined for any other ref. */
export const parseRef = (ref: string): ParsedRef | undefined => {
  const match = REF_PATTERN.exec(ref);
  return match === null ? undefined : { kind: match[1]!, workspaceId: match[2]!, id: match[3]! };
};

type Lifecycle = "open" | "completed" | "abandoned";

/**
 * The lifecycle of an issue by its workflow state type, and nothing else.
 * Archived and trashed issues are not gone: they keep the lifecycle of their
 * state. A state type this table lacks counts as open.
 */
const LIFECYCLE_BY_STATE_TYPE: Readonly<Record<string, Lifecycle>> = {
  triage: "open",
  backlog: "open",
  unstarted: "open",
  started: "open",
  completed: "completed",
  canceled: "abandoned",
  duplicate: "abandoned",
};

/** Returns an issue's lifecycle, from its state type alone. */
export const decideLifecycle = (issue: ApiIssue): Lifecycle =>
  LIFECYCLE_BY_STATE_TYPE[issue.state.type] ?? "open";

const STATUS_BY_STATE_TYPE: Readonly<Record<string, string>> = {
  triage: "triage",
  backlog: "backlog",
  unstarted: "todo",
  started: "started",
  completed: "done",
  canceled: "canceled",
  duplicate: "duplicate",
};

/**
 * Returns the key of an issue's status in the kind table, or undefined for a
 * state type the table lacks. A `started` state named "In Review" is the
 * `review` status, because Linear has no state type for review.
 */
export const decideIssueStatus = (issue: ApiIssue): string | undefined => {
  if (issue.state.type === "started" && issue.state.name.trim().toLowerCase() === "in review") {
    return "review";
  }
  return STATUS_BY_STATE_TYPE[issue.state.type];
};

/**
 * Returns the level of the `bars` fact for Linear's priority, or null for an
 * issue with no priority. Linear has four priorities (1 urgent, 2 high,
 * 3 medium, 4 low) and the fact has three levels, so urgent and high share
 * the top one.
 */
const decidePriorityLevel = (priority: number): number | null => {
  switch (priority) {
    case 1:
    case 2:
      return 3;
    case 3:
      return 2;
    case 4:
      return 1;
    default:
      return null;
  }
};

/**
 * Builds the observation of an issue. `viewerId` decides `ownedByYou`;
 * `concerns` says why the issue concerns the user, and is empty for an issue
 * read only to refresh it or to find it.
 *
 * An archived or trashed issue stays readable: it keeps its lifecycle and
 * shows an "Archived" fact.
 */
export const buildIssueObservation = (
  issue: ApiIssue,
  workspace: WorkspaceBlock,
  viewerId: string,
  concerns: ReadonlyArray<EntityConcern>,
): EntityObservation => {
  const status = decideIssueStatus(issue);
  const isArchived = issue.archivedAt !== null || issue.trashed === true;
  return {
    kind: ISSUE_KIND,
    ref: buildIssueRef(workspace, issue.id),
    title: cutText(issue.title, MAX_EVENT_TITLE_LENGTH),
    url: issue.url,
    lifecycle: decideLifecycle(issue),
    ...(status === undefined ? {} : { status }),
    fields: {
      key: cutName(issue.identifier),
      assignee: issue.assignee === null ? null : cutName(issue.assignee.name),
      priority: decidePriorityLevel(issue.priority),
      milestone:
        issue.projectMilestone === null
          ? null
          : cutText(issue.projectMilestone.name, MAX_WORD_FACT_LENGTH),
      archived: isArchived ? "Archived" : null,
    },
    concerns,
    ownedByYou: issue.assignee?.id === viewerId,
    sourceUpdatedAt: issue.updatedAt,
  };
};
