/**
 * Reads Sentry issues into the observations the core stores as External
 * Entities. The feed, the refresh of wanted refs, the search and the
 * resolve of a lookup all build their observations here, so a card looks the
 * same whichever way the issue arrived.
 */
import { Effect } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import {
  isHttpUrl,
  MAX_ENTITY_FIELD_TEXT_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  type EntityObservation,
} from "@hercule/plugin-host";
import { readPages, type SentryFailure } from "./api";
import { ISSUE_KIND, SEVERITY_VALUES } from "./entity-kinds";
import { MAX_LIST_PAGES, type OrganizationAccess } from "./organization";
import { buildIssueRef } from "./refs";
import { ApiProject, type ApiIssue } from "./sentry-objects";
import { cutText } from "./text";

/**
 * The longest `shortId` an observation reports. The core refuses an
 * identifier over 64 characters, and a refused observation refuses the whole
 * inventory it is in.
 */
const MAX_IDENTIFIER_LENGTH = 64;

/**
 * The longest `assignee` an observation reports. The core refuses a person or
 * owner name over 120 characters, and a refused observation refuses the whole
 * inventory it is in.
 */
const MAX_PERSON_NAME_LENGTH = 120;

/** Cuts a team or project name to the longest text an observation's field holds. */
const cutFieldText = (text: string): string => cutText(text, MAX_ENTITY_FIELD_TEXT_LENGTH);

/**
 * The teams of an organization, as its projects list them.
 */
interface OrganizationTeams {
  /** The ids of each project's teams, by project id. */
  readonly teamIdsByProject: ReadonlyMap<string, ReadonlyArray<string>>;
  /** The name of each team, by team id, for every team some project lists. */
  readonly names: ReadonlyMap<string, string>;
}

/**
 * Reads the organization's projects and returns each project's team ids and
 * every team's name. Both come from the one projects list, so a team has one
 * name wherever it appears. Reads at most `MAX_LIST_PAGES` pages and accepts a
 * partial list: a project that is not in the list has no known team, so the
 * team rule gives it none and never guesses. Fails as `readPages` does.
 */
const readOrganizationTeams = (
  access: OrganizationAccess,
): Effect.Effect<OrganizationTeams, SentryFailure, HttpClient.HttpClient> =>
  Effect.map(
    readPages(
      {
        method: "GET",
        baseUrl: access.organization.regionUrl,
        path: `/api/0/organizations/${access.organization.slug}/projects/`,
        token: access.token,
      },
      ApiProject,
      MAX_LIST_PAGES,
    ),
    ({ items: projects }) => ({
      teamIdsByProject: new Map(
        projects.map((project) => [project.id, (project.teams ?? []).map((team) => team.id)]),
      ),
      names: new Map(
        projects.flatMap((project) => (project.teams ?? []).map((team) => [team.id, team.name])),
      ),
    }),
  );

/** What an issue's observation needs to know besides the issue. */
export interface IssueObservationContext {
  readonly organizationId: string;
  /** The slug of the organization, for the link of an issue whose permalink is unusable. */
  readonly organizationSlug: string;
  /** The id of the Sentry user the Connection belongs to. */
  readonly userId: string;
  readonly teams: OrganizationTeams;
}

/**
 * Reads the organization's teams (one request per page of projects, up to
 * `MAX_LIST_PAGES`) and returns what an issue's observation needs besides the
 * issue. Call it once per poll or lookup, then pass the result to every
 * `buildIssueObservation`. Fails as `readPages` does.
 */
export const readIssueObservationContext = (
  access: OrganizationAccess,
  userId: string,
): Effect.Effect<IssueObservationContext, SentryFailure, HttpClient.HttpClient> =>
  Effect.map(readOrganizationTeams(access), (teams) => ({
    organizationId: access.organization.id,
    organizationSlug: access.organization.slug,
    userId,
    teams,
  }));

/**
 * The statuses Sentry gives an issue that is being deleted or merged into
 * another issue. Sentry states this outright, so it is the one evidence that
 * an issue is deleted.
 */
const DELETED_STATUSES: ReadonlySet<string> = new Set([
  "pending_deletion",
  "deletion_in_progress",
  "pending_merge",
]);

/** Returns true when Sentry says the issue is being deleted or merged away. */
export const isDeletedInSentry = (issue: ApiIssue): boolean => DELETED_STATUSES.has(issue.status);

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
const decideLifecycleAndStatus = (
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
 * and an issue no team holds has no team: the plugin never guesses one. A
 * project missing from the (possibly partial) projects list has no known
 * team either.
 *
 * Both cases take the name from the projects list, so a team has one name.
 * An assigned team that no project lists falls back to the name on the
 * assignment, which Sentry may spell as the team's slug.
 */
const decideTeamName = (issue: ApiIssue, teams: OrganizationTeams): string | null => {
  if (issue.assignedTo?.type === "team") {
    return cutFieldText(teams.names.get(issue.assignedTo.id) ?? issue.assignedTo.name);
  }
  const projectTeamIds = teams.teamIdsByProject.get(issue.project.id) ?? [];
  const onlyTeamName =
    projectTeamIds.length === 1 ? teams.names.get(projectTeamIds[0]!) : undefined;
  return onlyTeamName === undefined ? null : cutFieldText(onlyTeamName);
};

/** Returns `value` when it is a finite number that is not negative, and null otherwise. */
const readCount = (value: number): number | null =>
  Number.isFinite(value) && value >= 0 ? value : null;

/** Returns `count` as a number, or null when Sentry sent something that is not a count. */
const parseEventCount = (count: string): number | null =>
  count.trim() === "" ? null : readCount(Number(count));

/**
 * Builds the observation of one issue. Returns undefined when Sentry is
 * deleting or merging the issue (`isDeletedInSentry`) or reprocessing it: it
 * is not a thing to show, and the caller decides what to report.
 *
 * - `concerns` is passed through.
 * - `reason` comes from the assignment alone, whatever `concerns` holds, so a
 *   refresh with no concerns never clears it: `team-assigned` when a team
 *   holds the issue, `assigned` when the Connection's user does, none
 *   otherwise.
 * - `ownedByYou` is true only for an issue assigned to the user directly.
 * - `url` is the issue's permalink, or `https://<org slug>.sentry.io/issues/<id>/`
 *   when the permalink is not an http(s) link or is too long: the core
 *   refuses a kind with cards and no link, and with it the whole inventory.
 * - `sourceUpdatedAt` is the last time an event was seen, because Sentry keeps
 *   no time for a change of status or assignee. The core accepts an equal
 *   time from the same source, so such a change is still written.
 * - `severity` is null for a level that is not one of `SEVERITY_VALUES`,
 *   `users` and `events` are null when not a finite non-negative number, and
 *   the title, the short id, the names and the assignee are cut to the core's
 *   bounds, because the core refuses a whole inventory that holds an unknown
 *   or oversized value.
 */
export const buildIssueObservation = (
  issue: ApiIssue,
  context: IssueObservationContext,
  concerns: ReadonlyArray<"assigned">,
): EntityObservation | undefined => {
  if (isDeletedInSentry(issue) || issue.status === "reprocessing") return undefined;
  const assignedToUser =
    issue.assignedTo?.type === "user" && issue.assignedTo.id === context.userId;
  const reason = assignedToUser
    ? "assigned"
    : issue.assignedTo?.type === "team"
      ? "team-assigned"
      : undefined;
  const firstSeen = new Date(issue.firstSeen).toISOString();
  const lastSeen = new Date(issue.lastSeen).toISOString();
  return {
    kind: ISSUE_KIND,
    ref: buildIssueRef(context.organizationId, issue.id),
    // An issue with no title is named by its short id, as the event payload does.
    title: cutText(issue.title.trim() === "" ? issue.shortId : issue.title, MAX_EVENT_TITLE_LENGTH),
    url: isHttpUrl(issue.permalink)
      ? issue.permalink
      : `https://${context.organizationSlug}.sentry.io/issues/${issue.id}/`,
    ...decideLifecycleAndStatus(issue),
    fields: {
      shortId: cutText(issue.shortId, MAX_IDENTIFIER_LENGTH),
      team: decideTeamName(issue, context.teams),
      project: cutFieldText(issue.project.slug),
      severity: SEVERITY_WORDS.has(issue.level) ? issue.level : null,
      events: parseEventCount(issue.count),
      users: readCount(issue.userCount),
      firstSeen,
      lastSeen,
      assignee:
        issue.assignedTo?.type === "user"
          ? cutText(issue.assignedTo.name, MAX_PERSON_NAME_LENGTH)
          : null,
    },
    concerns,
    ownedByYou: assignedToUser,
    ...(reason === undefined ? {} : { reason }),
    sourceCreatedAt: firstSeen,
    sourceUpdatedAt: lastSeen,
  };
};
