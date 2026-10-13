/**
 * Turns a Connection's config into the filter the `issues` feed lists the
 * watched set with, and checks that every id in the config still exists.
 * Linear does not report an unknown id in a filter, so a deleted label would
 * otherwise silently match nothing, and every issue would look as if it left.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { PluginError } from "@hercule/plugin-host";
import { callLinear, type LinearFailure } from "../api";
import {
  NO_PROJECT,
  OPEN_STATE_TYPES,
  USER_PREFIX,
  type LinearConnectionConfig,
} from "../connection-type";
import { VIEWER_FIELDS, ViewerFields } from "../linear-objects";

/** The `IssueFilter` the watched set is listed with, and a fingerprint that tells two filters apart. */
export interface WatchFilter {
  readonly filter: Readonly<Record<string, unknown>>;
  /** The filter as JSON. It holds only ids and settings, sorted, so a rename in Linear never changes it. */
  readonly fingerprint: string;
}

/** Returns the distinct values of a config list, sorted, or an empty list when it is unset. */
const sortValues = (values: ReadonlyArray<string> | undefined): Array<string> =>
  [...new Set(values ?? [])].sort();

/**
 * Builds the condition on the assignee, or undefined when the config watches
 * anyone's issues. An unset or empty field means `me`.
 */
const buildAssigneeCondition = (assignees: ReadonlyArray<string>) => {
  const chosen = assignees.length === 0 ? ["me"] : assignees;
  if (chosen.includes("anyone")) return undefined;
  const userIds = chosen
    .filter((value) => value.startsWith(USER_PREFIX))
    .map((value) => value.slice(USER_PREFIX.length));
  const conditions = [
    ...(chosen.includes("me") ? [{ assignee: { isMe: { eq: true } } }] : []),
    ...(chosen.includes("none") ? [{ assignee: { null: true } }] : []),
    ...(userIds.length === 0 ? [] : [{ assignee: { id: { in: userIds } } }]),
  ];
  return { or: conditions };
};

/**
 * Builds the filter of the watched set from a Connection's config. Every
 * field is one condition of an `and`, and the values within a field are an
 * `or`, as Linear's filters combine them. The states default to the four open
 * types, so a closed issue always leaves the set.
 */
export const buildWatchFilter = (config: LinearConnectionConfig): WatchFilter => {
  const teams = sortValues(config.teams);
  const projects = sortValues(config.projects);
  const projectIds = projects.filter((id) => id !== NO_PROJECT);
  const milestones = sortValues(config.projectMilestones);
  const labels = sortValues(config.labels);
  const states = sortValues(config.states);
  const assignee = buildAssigneeCondition(sortValues(config.assignees));
  const conditions = [
    ...(teams.length === 0 ? [] : [{ team: { id: { in: teams } } }]),
    ...(projects.length === 0
      ? []
      : [
          {
            or: [
              ...(projectIds.length === 0 ? [] : [{ project: { id: { in: projectIds } } }]),
              ...(projects.includes(NO_PROJECT) ? [{ project: { null: true } }] : []),
            ],
          },
        ]),
    ...(milestones.length === 0 ? [] : [{ projectMilestone: { id: { in: milestones } } }]),
    ...(labels.length === 0 ? [] : [{ labels: { some: { id: { in: labels } } } }]),
    ...(assignee === undefined ? [] : [assignee]),
    { state: { type: { in: states.length === 0 ? [...OPEN_STATE_TYPES] : states } } },
  ];
  const filter = { and: conditions };
  return { filter, fingerprint: JSON.stringify(filter) };
};

/** The query that checks the configured ids and reads the workspace and the user. */
const CONFIG_CHECK_QUERY = `query LinearConfigCheck($teams: [ID!]!, $projects: [ID!]!, $milestones: [ID!]!, $labels: [ID!]!, $users: [ID!]!) {
  ${VIEWER_FIELDS}
  teams(filter: { id: { in: $teams } }, first: 250) { nodes { id } }
  projects(filter: { id: { in: $projects } }, first: 250) { nodes { id } }
  projectMilestones(filter: { id: { in: $milestones } }, first: 250) { nodes { id } }
  issueLabels(filter: { id: { in: $labels } }, first: 250) { nodes { id } }
  users(filter: { id: { in: $users } }, first: 250) { nodes { id } }
}`;

const IdList = Schema.Struct({ nodes: Schema.Array(Schema.Struct({ id: Schema.String })) });

const ConfigCheckAnswer = Schema.Struct({
  ...ViewerFields,
  teams: IdList,
  projects: IdList,
  projectMilestones: IdList,
  issueLabels: IdList,
  users: IdList,
});

/** The workspace and the user a poll reads beside its list. */
export interface PollIdentity {
  readonly workspace: { readonly id: string; readonly urlKey: string };
  readonly userId: string;
}

/**
 * Checks that every team, project, milestone, label and user in the config
 * still exists and is not archived, in one query, and returns the workspace
 * and the signed-in user. Linear leaves archived items and deactivated users
 * out of its lists, so either counts as gone. Fails with a `PluginError`
 * naming the first missing value and saying to remove it in the Connection's
 * settings, and as `callLinear` does otherwise.
 */
export const checkConfiguredValues = (
  authorization: string,
  config: LinearConnectionConfig,
): Effect.Effect<PollIdentity, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const configured = {
      teams: sortValues(config.teams),
      projects: sortValues(config.projects).filter((id) => id !== NO_PROJECT),
      milestones: sortValues(config.projectMilestones),
      labels: sortValues(config.labels),
      users: sortValues(config.assignees)
        .filter((value) => value.startsWith(USER_PREFIX))
        .map((value) => value.slice(USER_PREFIX.length)),
    };
    const answer = yield* callLinear(
      authorization,
      { name: "LinearConfigCheck", text: CONFIG_CHECK_QUERY, variables: configured },
      ConfigCheckAnswer,
    );
    const checks = [
      { what: "team", ids: configured.teams, found: answer.teams },
      { what: "project", ids: configured.projects, found: answer.projects },
      { what: "project milestone", ids: configured.milestones, found: answer.projectMilestones },
      { what: "label", ids: configured.labels, found: answer.issueLabels },
      { what: "user", ids: configured.users, found: answer.users },
    ];
    for (const { what, ids, found } of checks) {
      const foundIds = new Set(found.nodes.map((node) => node.id));
      const missing = ids.find((id) => !foundIds.has(id));
      if (missing !== undefined) {
        return yield* new PluginError({
          message: `The ${what} ${missing} in the Connection's settings no longer exists in Linear, or is archived. Remove it in the Connection's settings.`,
        });
      }
    }
    return { workspace: answer.organization, userId: answer.viewer.id };
  });
