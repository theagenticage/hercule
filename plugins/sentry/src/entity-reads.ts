/**
 * Reads Sentry issues into the observations the core stores as External
 * Entities. The feed, the refresh of wanted refs, the search and the
 * resolve of a lookup all build their observations here, so a card looks the
 * same whichever way the issue arrived.
 */
import { Effect } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import { isHttpUrl, type EntityObservation } from "@hercule/plugin-host";
import { ISSUE_KIND, SEVERITY_VALUES } from "./entity-kinds";
import { readOrganizationList, type OrganizationAccess } from "./organization";
import { buildIssueRef } from "./refs";
import { ApiProject, buildIssueBlock, isAssignedToUser, type ApiIssue } from "./sentry-objects";
import type { SentryFailure } from "./api";
import { cutName } from "./text";

/** The teams of an organization, as its projects list them. */
export interface OrganizationTeams {
  /** The ids of each project's teams, by project id. */
  readonly ofProject: ReadonlyMap<string, ReadonlyArray<string>>;
  /** The name of each team, by team id, for every team some project lists. */
  readonly names: ReadonlyMap<string, string>;
}

/**
 * Reads the organization's projects and returns each project's team ids and
 * every team's name. Both come from the one projects list, so a team has one
 * name wherever it appears. Fails as `readOrganizationList` does. Call it once
 * per poll or lookup, then pass the result to every `buildIssueObservation`.
 */
export const readOrganizationTeams = (
  access: OrganizationAccess,
): Effect.Effect<OrganizationTeams, SentryFailure, HttpClient.HttpClient> =>
  Effect.map(readOrganizationList(access, "/projects/", ApiProject), (projects) => ({
    ofProject: new Map(
      projects.map((project) => [project.id, (project.teams ?? []).map((team) => team.id)]),
    ),
    names: new Map(
      projects.flatMap((project) => (project.teams ?? []).map((team) => [team.id, team.name])),
    ),
  }));

/** What an issue's observation needs to know besides the issue. */
export interface IssueObservationContext {
  readonly organizationId: string;
  /** The id of the Sentry user the Connection belongs to. */
  readonly userId: string;
  readonly teams: OrganizationTeams;
}

/**
 * The statuses Sentry gives an issue that is on its way out: it is being
 * deleted, merged into another issue, or reprocessed. Such an issue is not a
 * thing to show.
 */
const GONE_STATUSES: ReadonlySet<string> = new Set([
  "pending_deletion",
  "deletion_in_progress",
  "pending_merge",
  "reprocessing",
]);

const OPEN_STATUS_KEYS: ReadonlySet<string> = new Set([
  "new",
  "escalating",
  "ongoing",
  "regressed",
]);

const SEVERITY_WORDS: ReadonlySet<string> = new Set(
  SEVERITY_VALUES.map((severity) => severity.value),
);

/**
 * Returns the lifecycle and the status key of an issue.
 *
 * - `unresolved` is open. Its key is its substatus when that is one of
 *   `new`, `escalating`, `ongoing` and `regressed`, and `ongoing` otherwise.
 * - `resolved` is completed, with the key `resolved`.
 * - `ignored` (what Sentry's interface calls archived) is abandoned, with the
 *   key `archived`.
 * - A status this plugin does not know is open with no status key, so the
 *   card shows the thing without claiming a state it cannot vouch for.
 */
const decideLifecycle = (
  issue: ApiIssue,
): Pick<Extract<EntityObservation, { partial?: false }>, "lifecycle" | "status"> => {
  switch (issue.status) {
    case "unresolved":
      return {
        lifecycle: "open",
        status: OPEN_STATUS_KEYS.has(issue.substatus ?? "") ? issue.substatus! : "ongoing",
      };
    case "resolved":
      return { lifecycle: "completed", status: "resolved" };
    case "ignored":
      return { lifecycle: "abandoned", status: "archived" };
    default:
      return { lifecycle: "open" };
  }
};

/**
 * Returns the name of the team an issue belongs to: the team it is assigned
 * to, else the project's only team, else null. A project with several teams
 * and an issue no team holds has no team: the plugin never guesses one.
 *
 * Both cases take the name from the projects list, so a team has one name.
 * An assigned team that no project lists falls back to the name on the
 * assignment, which Sentry may spell as the team's slug.
 */
const decideTeamName = (issue: ApiIssue, teams: OrganizationTeams): string | null => {
  if (issue.assignedTo?.type === "team") {
    return cutName(teams.names.get(issue.assignedTo.id) ?? issue.assignedTo.name);
  }
  const projectTeamIds = teams.ofProject.get(issue.project.id) ?? [];
  const onlyTeamName =
    projectTeamIds.length === 1 ? teams.names.get(projectTeamIds[0]!) : undefined;
  return onlyTeamName === undefined ? null : cutName(onlyTeamName);
};

/** Returns `count` as a number, or null when Sentry sent something that is not one. */
const parseEventCount = (count: string): number | null => {
  const events = Number(count);
  return count.trim() !== "" && Number.isFinite(events) ? events : null;
};

/**
 * Builds the observation of one issue. Returns undefined when Sentry is
 * deleting, merging or reprocessing the issue: the caller reports the ref as
 * missing with the reason `deleted`.
 *
 * - `concerns` is passed through. When it holds `assigned`, the reason is
 *   `assigned` for an issue assigned to the user and `team-assigned` for one a
 *   team holds. With no concerns there is no reason.
 * - `ownedByYou` is true only for an issue assigned to the user directly.
 * - `sourceUpdatedAt` is the last time an event was seen, because Sentry keeps
 *   no time for a change of status or assignee. The core accepts an equal
 *   time from the same source, so such a change is still written.
 * - `severity` is null for a level that is not one of `SEVERITY_VALUES`,
 *   because the core refuses a whole inventory that holds an unknown value.
 */
export const buildIssueObservation = (
  issue: ApiIssue,
  context: IssueObservationContext,
  concerns: ReadonlyArray<"assigned">,
): EntityObservation | undefined => {
  if (GONE_STATUSES.has(issue.status)) return undefined;
  const block = buildIssueBlock(issue);
  const assignedToUser = isAssignedToUser(block, context.userId);
  const reason = concerns.includes("assigned")
    ? assignedToUser
      ? "assigned"
      : block.assignedTo?.type === "team"
        ? "team-assigned"
        : undefined
    : undefined;
  const firstSeen = new Date(issue.firstSeen).toISOString();
  const lastSeen = new Date(issue.lastSeen).toISOString();
  return {
    kind: ISSUE_KIND,
    ref: buildIssueRef(context.organizationId, issue.id),
    title: block.title,
    ...(isHttpUrl(block.permalink) ? { url: block.permalink } : {}),
    ...decideLifecycle(issue),
    fields: {
      shortId: block.shortId,
      team: decideTeamName(issue, context.teams),
      project: block.project.slug,
      severity: SEVERITY_WORDS.has(issue.level) ? issue.level : null,
      events: parseEventCount(issue.count),
      users: issue.userCount,
      firstSeen,
      lastSeen,
      assignee: block.assignedTo?.type === "user" ? block.assignedTo.name : null,
    },
    concerns,
    ownedByYou: assignedToUser,
    ...(reason === undefined ? {} : { reason }),
    sourceCreatedAt: firstSeen,
    sourceUpdatedAt: lastSeen,
  };
};
