/**
 * Sentry, as a connection type. The user signs in through Hercule's own
 * Sentry application with a device flow, or pastes an auth token and the slug
 * of the organization it belongs to. Either way the token is checked by asking
 * Sentry which organization and user it belongs to.
 *
 * A Connection's config holds the settings of its `issues` feed: which
 * assignees, projects and environments it watches, and how recent an issue
 * must be. The first three are chosen from lists read from Sentry, so the
 * config stores ids and a rename in Sentry changes nothing.
 */
import { Effect, Schema } from "effect";
import {
  ConnectionValidationFailed,
  PluginError,
  type ConfigChoice,
  type ConnectionTypeContribution,
} from "@hercule/plugin-host";
import { readToken, type SentryFailure } from "./api";
import {
  findOrganization,
  readCurrentUser,
  readOrganizationList,
  type OrganizationAccess,
} from "./organization";
import { ApiEnvironment, ApiMember, ApiProject, ApiTeam } from "./sentry-objects";

/**
 * The client id of Hercule's application on Sentry. A client id is public:
 * the device flow needs no client secret, so every Hercule install can share
 * one application without a relay.
 */
const OAUTH_APP_CLIENT_ID = "12818eb01f62888cbadc934d75abae8a8ee25c67398491a81aba0208d4a987f4";

/** What the Connection needs: to read the organization and its issues, and to resolve, archive and assign them. */
const SCOPES = [
  "org:read",
  "project:read",
  "team:read",
  "member:read",
  "event:read",
  "event:write",
];

/** How many days back the `issues` feed looks when a Connection does not set its own window. */
export const DEFAULT_LAST_SEEN_DAYS = 14;

/**
 * The values the `assignees` field offers before any team or member. Sentry's
 * search knows them by name.
 */
const FIXED_ASSIGNEE_CHOICES: ReadonlyArray<ConfigChoice> = [
  { value: "me", label: "Me" },
  { value: "my_teams", label: "My teams" },
  { value: "none", label: "Unassigned" },
  { value: "anyone", label: "Anyone" },
];

/**
 * A Sentry Connection's own settings, shown as a form on the Connection under
 * the schema's title. Every field is optional, so a Connection created before
 * a field existed, with an empty config, stays valid.
 *
 * The three lists are filled from Sentry by `listChoices`. Their values are
 * ids (`team:<id>`, `user:<id>`, `project:<id>`) and, for the environments,
 * names.
 */
export const SentryConnectionConfig = Schema.Struct({
  assignees: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      title: "Assignees",
      description:
        "Watches issues assigned to these. Leave empty for issues assigned to you or your teams.",
      choices: true,
    }),
  ),
  projects: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      title: "Projects",
      description: "Watches these projects, or every project of a team. Leave empty for all.",
      choices: true,
    }),
  ),
  environments: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      title: "Environments",
      description: "Watches issues seen in these environments. Leave empty for all.",
      choices: true,
    }),
  ),
  lastSeenDays: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 90 })).annotate({
      title: "Last seen (days)",
      description: `Watches issues with an event within this many days. ${String(DEFAULT_LAST_SEEN_DAYS)} by default, from 1 to 90.`,
      // Only describes the setting, so the form can show it as the field's
      // placeholder. Decoding leaves an unset window unset; the feed falls
      // back to the same constant.
      default: DEFAULT_LAST_SEEN_DAYS,
    }),
  ),
}).annotate({ title: "Watching" });

export type SentryConnectionConfig = Schema.Schema.Type<typeof SentryConnectionConfig>;

const failValidation = (message: string) =>
  Effect.fail(new ConnectionValidationFailed({ message }));

/** Converts any failure of a call to Sentry into the plain `PluginError` a form or a step shows. */
const toPluginError = (failure: SentryFailure): PluginError =>
  new PluginError({ message: failure.message });

/**
 * Asks Sentry whom the token belongs to. The account id is `<organization
 * id>:<user id>` and the display name is `<organization name> · <username>`.
 * Both ids stay the same when the organization or the user is renamed, and
 * the host compares the account id on a reconnect, so a reconnect cannot
 * switch the Connection to another organization or user.
 *
 * The host passes the pasted `token` and `organization` fields, or the
 * `accessToken` the device flow obtained.
 */
const validate: ConnectionTypeContribution["validate"] = (credentials) =>
  Effect.gen(function* () {
    const token = readToken(credentials);
    if (token === undefined) return yield* failValidation("No Sentry token was given.");
    const organization = yield* findOrganization(token, credentials);
    const user = yield* readCurrentUser({ token, organization });
    return {
      accountId: `${organization.id}:${user.id}`,
      displayName: `${organization.name} · ${user.username}`,
    };
  }).pipe(
    Effect.catchTags({
      AuthError: () => failValidation("Sentry rejected the token."),
      PluginError: (error) => failValidation(error.message),
      SentryRateLimited: (error) => failValidation(error.message),
    }),
  );

/** Returns the name to show for a member: the name, else the email, else the username. */
const buildMemberLabel = (member: Schema.Schema.Type<typeof ApiMember>): string => {
  const name = member.name?.trim() ?? "";
  if (name !== "") return name;
  const email = member.email?.trim() ?? "";
  return email === "" ? (member.user?.username ?? "") : email;
};

/** Lists the teams as `team:<id>` choices, with `label` building each label from the team's slug. */
const listTeamChoices = (access: OrganizationAccess, buildLabel: (slug: string) => string) =>
  Effect.map(readOrganizationList(access, "/teams/", ApiTeam), (teams) =>
    teams.map((team) => ({ value: `team:${team.id}`, label: buildLabel(team.slug) })),
  );

/**
 * Returns the choices of one config field, read from Sentry with the
 * Connection's token.
 *
 * - `assignees`: the four fixed values, then the teams (`#slug`), then the
 *   members that have a Sentry user (by name). A member is chosen by the
 *   user's id, because that is the id an issue is assigned to.
 * - `projects`: the teams ("All projects of #slug"), then the projects.
 * - `environments`: the environment names.
 *
 * Returns the whole list. The host refuses a list of more than 1,000 choices
 * with its own error, so this function never cuts one. Fails with a
 * `PluginError` for another field, for credentials without a token, when an
 * organization list is too long to read, and when Sentry cannot be read.
 */
const listChoices: NonNullable<ConnectionTypeContribution["listChoices"]> = (field, connection) =>
  Effect.gen(function* () {
    const token = readToken(connection.credentials);
    if (token === undefined) {
      return yield* new PluginError({ message: "The Connection has no Sentry token." });
    }
    const organization = yield* findOrganization(token, connection.credentials);
    const access = { token, organization };
    switch (field) {
      case "assignees": {
        const teams = yield* listTeamChoices(access, (slug) => `#${slug}`);
        const members = yield* readOrganizationList(access, "/members/", ApiMember);
        return [
          ...FIXED_ASSIGNEE_CHOICES,
          ...teams,
          ...members.flatMap((member) =>
            member.user == null
              ? []
              : [{ value: `user:${member.user.id}`, label: buildMemberLabel(member) }],
          ),
        ];
      }
      case "projects": {
        const teams = yield* listTeamChoices(access, (slug) => `All projects of #${slug}`);
        const projects = yield* readOrganizationList(access, "/projects/", ApiProject);
        return [
          ...teams,
          ...projects.map((project) => ({
            value: `project:${project.id}`,
            label: project.slug,
          })),
        ];
      }
      case "environments": {
        const environments = yield* readOrganizationList(access, "/environments/", ApiEnvironment);
        return environments.map((environment) => ({
          value: environment.name,
          label: environment.name,
        }));
      }
      default:
        return yield* new PluginError({
          message: `The Sentry Connection has no list of choices for the field "${field}".`,
        });
    }
  }).pipe(
    Effect.catchTags({
      AuthError: (error) => Effect.fail(toPluginError(error)),
      SentryRateLimited: (error) => Effect.fail(toPluginError(error)),
    }),
  );

/**
 * The qualified id of the connection type below. The host qualifies the
 * declared `type`, "sentry", with the plugin's id, so the event source and
 * every workflow action name the type this way.
 */
export const SENTRY_CONNECTION_TYPE = "sentry/sentry";

export const connectionType: ConnectionTypeContribution = {
  type: "sentry",
  displayName: "Sentry",
  // The device flow comes first because it is the one the setup screen
  // offers by default; pasting a token is the fallback.
  setup: [
    { kind: "device" },
    {
      kind: "credentials",
      fields: [
        {
          name: "token",
          label: "Auth token",
          help: "A personal or organization token with the scopes org:read, project:read, team:read, member:read, event:read and event:write.",
        },
        {
          name: "organization",
          label: "Organization slug",
          help: "The slug of the organization the token belongs to, as it appears in your Sentry address.",
        },
      ],
    },
  ],
  device: {
    clientId: OAUTH_APP_CLIENT_ID,
    deviceCodeUrl: "https://sentry.io/oauth/device/code/",
    tokenUrl: "https://sentry.io/oauth/token/",
    scopes: SCOPES,
  },
  configSchema: SentryConnectionConfig,
  validate,
  listChoices,
};
