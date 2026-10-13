/**
 * Linear, as a connection type. The user signs in through Hercule's own
 * public Linear application with a redirect flow, or pastes a personal API
 * key. Either way the credential is checked by asking Linear which workspace
 * and user it belongs to.
 *
 * A Connection's config holds the filters of its `issues` feed. Every field
 * but `states` is chosen from lists read from Linear, so the config stores
 * ids and a rename in Linear changes nothing.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {
  ConnectionValidationFailed,
  PluginError,
  type ConfigChoice,
  type ConnectionTypeContribution,
} from "@hercule/plugin-host";
import { buildAuthorization, callLinear, readPages, type LinearFailure } from "./api";

/**
 * The client id of Hercule's public application on Linear. A client id is
 * public: the redirect flow uses PKCE and no client secret, so every Hercule
 * install shares one application.
 */
const OAUTH_APP_CLIENT_ID = "900702e5f1522b44e9a312dfb21acc47";

/**
 * The redirect URIs Hercule's application registered: the controller's
 * default port on either loopback name. Linear matches a redirect URI
 * exactly, so the redirect flow works only at these addresses.
 */
const OAUTH_REDIRECT_URIS = [
  "http://127.0.0.1:4937/oauth/callback",
  "http://localhost:4937/oauth/callback",
];

/** The open workflow state types, which are all an issue in the watched set can be in. */
export const OPEN_STATE_TYPES = ["triage", "backlog", "unstarted", "started"] as const;

/** The labels the form shows for the open state types, as Linear's own screens name them. */
const STATE_CHOICES: ReadonlyArray<ConfigChoice> = [
  { value: "triage", label: "Triage" },
  { value: "backlog", label: "Backlog" },
  { value: "unstarted", label: "Todo" },
  { value: "started", label: "In progress" },
];

/** The values the `assignees` field offers before the workspace's members. */
const FIXED_ASSIGNEE_CHOICES: ReadonlyArray<ConfigChoice> = [
  { value: "me", label: "Me" },
  { value: "none", label: "Unassigned" },
  { value: "anyone", label: "Anyone" },
];

/** The value of the `projects` field that matches issues in no project. */
export const NO_PROJECT = "none";

/** The prefix of an `assignees` value that names one Linear user by id. */
export const USER_PREFIX = "user:";

/** A list field whose choices load from Linear. */
const declareChoicesField = (title: string, description: string) =>
  Schema.optionalKey(Schema.Array(Schema.String).annotate({ title, description, choices: true }));

/**
 * A Linear Connection's own settings, shown as a form on the Connection under
 * the schema's title. Every field is optional. Fields combine with AND; the
 * values within one field combine with OR.
 *
 * `states` is a fixed list, and is marked `choices` only so the form shows
 * Linear's names for the four state types: `listChoices` returns them without
 * reading Linear.
 */
export const LinearConnectionConfig = Schema.Struct({
  teams: declareChoicesField("Teams", "Watches issues of these teams. Leave empty for every team."),
  projects: declareChoicesField(
    "Projects",
    'Watches issues in these projects. "No project" picks issues in none. Leave empty for any.',
  ),
  projectMilestones: declareChoicesField(
    "Project milestones",
    "Watches issues in these milestones of the chosen projects. Leave empty for any.",
  ),
  labels: declareChoicesField(
    "Labels",
    "Watches issues with any of these labels. Leave empty for any labels.",
  ),
  assignees: declareChoicesField(
    "Assignees",
    'Watches issues assigned to these. Leave empty for issues assigned to you. "Anyone" drops the filter.',
  ),
  states: Schema.optionalKey(
    Schema.Array(Schema.Literals(OPEN_STATE_TYPES)).annotate({
      title: "States",
      description: "Watches issues in these states. Leave empty for all four.",
      choices: true,
    }),
  ),
}).annotate({ title: "Watching" });

export type LinearConnectionConfig = Schema.Schema.Type<typeof LinearConnectionConfig>;

const failValidation = (message: string) =>
  Effect.fail(new ConnectionValidationFailed({ message }));

/** The query `validate` sends: who the credential belongs to. */
const VIEWER_QUERY = {
  name: "LinearViewer",
  text: "query LinearViewer { viewer { id name displayName } organization { id name } }",
};

const ViewerAnswer = Schema.Struct({
  viewer: Schema.Struct({ id: Schema.String, name: Schema.String }),
  organization: Schema.Struct({ id: Schema.String, name: Schema.String }),
});

/**
 * Asks Linear whom the credential belongs to. The account id is
 * `<organization id>:<user id>` and the display name is `<workspace name> ·
 * <user name>`. A Linear user belongs to one workspace, so the pair names one
 * account, and both ids stay the same when the workspace or the user is
 * renamed. The host compares the account id on a reconnect, so a reconnect
 * cannot switch the Connection to another workspace or user.
 *
 * The host passes the pasted `apiKey` field, or the `accessToken` the
 * redirect flow obtained.
 */
const validate: ConnectionTypeContribution["validate"] = (credentials) =>
  Effect.gen(function* () {
    const authorization = buildAuthorization(credentials);
    if (authorization === undefined)
      return yield* failValidation("No Linear credential was given.");
    const { viewer, organization } = yield* callLinear(authorization, VIEWER_QUERY, ViewerAnswer);
    return {
      accountId: `${organization.id}:${viewer.id}`,
      displayName: `${organization.name} · ${viewer.name}`,
    };
  }).pipe(
    Effect.catchTags({
      AuthError: () => failValidation("Linear rejected the credential."),
      PluginError: (error) => failValidation(error.message),
      LinearRateLimited: (error) => failValidation(error.message),
    }),
  );

/** The most pages of one list the form reads: 1,000 items, the most choices the host accepts. */
const MAX_CHOICE_PAGES = 4;

/** Returns the ids in a config list, or an empty list when the field is unset. */
const readIds = (ids: ReadonlyArray<string> | undefined): ReadonlyArray<string> => ids ?? [];

const TeamItem = Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String });
const ProjectItem = Schema.Struct({ id: Schema.String, name: Schema.String });
const MilestoneItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  project: Schema.Struct({ name: Schema.String }),
});
const LabelItem = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  isGroup: Schema.Boolean,
  parent: Schema.NullOr(Schema.Struct({ name: Schema.String })),
  team: Schema.NullOr(Schema.Struct({ id: Schema.String })),
});
const UserItem = Schema.Struct({ id: Schema.String, name: Schema.String });

/**
 * Reads the choices of one field from Linear. Fails with a `PluginError` for
 * a field with no choices and when a list is longer than 1,000 items, and as
 * `callLinear` does otherwise.
 */
const readChoices = (
  authorization: string,
  field: string,
  config: LinearConnectionConfig,
): Effect.Effect<ReadonlyArray<ConfigChoice>, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    /** Reads a whole list, failing when it does not fit in the pages the form reads. */
    const readList = <S extends Schema.Decoder<unknown>>(
      name: string,
      text: string,
      listField: string,
      item: S,
      variables: Record<string, unknown> = {},
    ) =>
      Effect.flatMap(
        readPages(authorization, { name, text, variables }, listField, item, MAX_CHOICE_PAGES),
        (paged) =>
          paged.hasMore
            ? Effect.fail(
                new PluginError({
                  message: `The Linear workspace has more than 1,000 ${listField} to choose from.`,
                }),
              )
            : Effect.succeed(paged.items),
      );
    const teamIds = readIds(config.teams);
    switch (field) {
      case "teams": {
        const teams = yield* readList(
          "LinearTeamChoices",
          "query LinearTeamChoices($first: Int, $after: String) { teams(first: $first, after: $after) { nodes { id key name } pageInfo { hasNextPage endCursor } } }",
          "teams",
          TeamItem,
        );
        return teams.map((team) => ({ value: team.id, label: `${team.key} · ${team.name}` }));
      }
      case "projects": {
        const projects = yield* readList(
          "LinearProjectChoices",
          "query LinearProjectChoices($filter: ProjectFilter, $first: Int, $after: String) { projects(filter: $filter, first: $first, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } } }",
          "projects",
          ProjectItem,
          {
            filter:
              teamIds.length === 0 ? null : { accessibleTeams: { some: { id: { in: teamIds } } } },
          },
        );
        return [
          { value: NO_PROJECT, label: "No project" },
          ...projects.map((project) => ({ value: project.id, label: project.name })),
        ];
      }
      case "projectMilestones": {
        const projectIds = readIds(config.projects).filter((id) => id !== NO_PROJECT);
        if (projectIds.length === 0) return [];
        const milestones = yield* readList(
          "LinearMilestoneChoices",
          "query LinearMilestoneChoices($filter: ProjectMilestoneFilter, $first: Int, $after: String) { projectMilestones(filter: $filter, first: $first, after: $after) { nodes { id name project { name } } pageInfo { hasNextPage endCursor } } }",
          "projectMilestones",
          MilestoneItem,
          { filter: { project: { id: { in: projectIds } } } },
        );
        return milestones.map((milestone) => ({
          value: milestone.id,
          label: `${milestone.project.name} › ${milestone.name}`,
        }));
      }
      case "labels": {
        const labels = yield* readList(
          "LinearLabelChoices",
          "query LinearLabelChoices($first: Int, $after: String) { issueLabels(first: $first, after: $after) { nodes { id name isGroup parent { name } team { id } } pageInfo { hasNextPage endCursor } } }",
          "issueLabels",
          LabelItem,
        );
        // A group label is never on an issue. A label with no team is the
        // workspace's, offered whichever teams are chosen.
        return labels
          .filter(
            (label) =>
              !label.isGroup &&
              (label.team === null || teamIds.length === 0 || teamIds.includes(label.team.id)),
          )
          .map((label) => ({
            value: label.id,
            label: label.parent === null ? label.name : `${label.parent.name} › ${label.name}`,
          }));
      }
      case "assignees": {
        // Linear lists only active members unless asked for the others.
        const users = yield* readList(
          "LinearUserChoices",
          "query LinearUserChoices($first: Int, $after: String) { users(first: $first, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } } }",
          "users",
          UserItem,
        );
        return [
          ...FIXED_ASSIGNEE_CHOICES,
          ...users.map((user) => ({ value: `${USER_PREFIX}${user.id}`, label: user.name })),
        ];
      }
      case "states":
        return STATE_CHOICES;
      default:
        return yield* new PluginError({
          message: `The Linear Connection has no list of choices for the field "${field}".`,
        });
    }
  });

/**
 * Returns the choices of one config field, read from Linear with the
 * Connection's credentials (spec 08 section 5.7):
 *
 * - `teams`: every team, as `<key> · <name>`;
 * - `projects`: "No project", then the projects of the chosen teams, or every
 *   project when no team is chosen;
 * - `projectMilestones`: the milestones of the chosen projects, as
 *   `<project> › <milestone>`, and none when no project is chosen;
 * - `labels`: the workspace's labels and those of the chosen teams, a child
 *   label as `<group> › <label>`, group labels left out;
 * - `assignees`: "Me", "Unassigned" and "Anyone", then each active member;
 * - `states`: the four open state types, without reading Linear.
 *
 * Fails with a `PluginError`, whose message the form shows, for another
 * field, for an invalid config, for credentials without a token or key, and
 * when Linear cannot be read. A refused credential is a plain failure here:
 * only ingest moves a Connection to needs-reauth.
 */
const listChoices: NonNullable<ConnectionTypeContribution["listChoices"]> = (field, connection) =>
  Effect.gen(function* () {
    if (field === "states") return STATE_CHOICES;
    const authorization = buildAuthorization(connection.credentials);
    if (authorization === undefined) {
      return yield* new PluginError({ message: "The Connection has no Linear credential." });
    }
    const config = yield* Schema.decodeUnknownEffect(LinearConnectionConfig)(
      connection.config ?? {},
    ).pipe(
      Effect.mapError(
        (error) =>
          new PluginError({
            message: `The Linear Connection's config is invalid: ${error.message}`,
          }),
      ),
    );
    return yield* readChoices(authorization, field, config);
  }).pipe(
    Effect.catchTags({
      AuthError: (error) => Effect.fail(new PluginError({ message: error.message })),
      LinearRateLimited: (error) => Effect.fail(new PluginError({ message: error.message })),
    }),
  );

/**
 * The qualified id of the connection type below. The host qualifies the
 * declared `type`, "linear", with the plugin's id, so the event source names
 * the type this way.
 */
export const LINEAR_CONNECTION_TYPE = "linear/linear";

export const connectionType: ConnectionTypeContribution = {
  type: "linear",
  displayName: "Linear",
  // The redirect flow comes first because it is the one the setup screen
  // offers by default; pasting a personal API key is the fallback.
  setup: [
    { kind: "oauth" },
    {
      kind: "credentials",
      fields: [
        {
          name: "apiKey",
          label: "Personal API key",
          help: "A personal API key from Linear's account settings, under Security & access. It works at any controller address.",
        },
      ],
    },
  ],
  oauth: {
    authorizationUrl: "https://linear.app/oauth/authorize",
    tokenUrl: "https://api.linear.app/oauth/token",
    // `write` is unused until the plugin has actions; asking for it now
    // spares every user a reconnect then.
    scopes: ["read", "write"],
    // Shows the approval page every time, so a second Connection can pick
    // another workspace.
    extraParams: { prompt: "consent" },
    publicClient: { clientId: OAUTH_APP_CLIENT_ID, redirectUris: OAUTH_REDIRECT_URIS },
  },
  configSchema: LinearConnectionConfig,
  validate,
  listChoices,
};
