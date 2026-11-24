/**
 * Slack, as a connection type. The user signs in through a redirect flow with
 * a public Slack app that Hercule creates for each Connection.
 *
 * Slack has no app that every Hercule install can share: Slack's MCP server
 * accepts only apps listed in Slack's Marketplace and internal apps, which are
 * used only in the workspace that owns them. So when the user sets up a
 * Connection, `createOAuthClient` makes a new internal Slack app in their
 * workspace from a configuration token they paste once. Hercule does not store that token: it uses it to create the app, and
 * holds it in memory only to delete the app again if the sign-in fails.
 */
import { Duration, Effect, Schema } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import {
  ConnectionValidationFailed,
  type ConnectionTypeContribution,
  type CreatedOAuthClient,
} from "@hercule/plugin-host";

/** The qualified id of this type: the plugin's id, a slash, and the type's own word. */
export const SLACK_CONNECTION_TYPE = "slack/slack";

/** The Web API method that creates a Slack app from a manifest. */
const CREATE_APP_URL = "https://slack.com/api/apps.manifest.create";

/** The Web API method that deletes a Slack app. */
const DELETE_APP_URL = "https://slack.com/api/apps.manifest.delete";

/** The Web API method that tells who a token belongs to. */
const AUTH_TEST_URL = "https://slack.com/api/auth.test";

/** The origin of Slack's hosted MCP server, which the access token is issued for. */
export const SLACK_MCP_ORIGIN = "https://mcp.slack.com";

/**
 * How long one request to Slack may take. Without a limit, a connection that
 * Slack never answers would hold the setup form forever.
 */
const SLACK_REQUEST_TIMEOUT = Duration.seconds(30);

/** The most reasons of a refused manifest that an error message lists. */
const MAX_MANIFEST_PROBLEMS = 5;

/**
 * The user scopes the Connection asks for. A bot scope here would be refused
 * by Slack, because a loopback redirect URI works only with user tokens once
 * PKCE is on.
 */
const SLACK_USER_SCOPES = [
  "canvases:read",
  "canvases:write",
  "channels:history",
  "channels:read",
  "channels:write",
  "chat:write",
  "emoji:read",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "groups:write",
  "im:history",
  "im:read",
  "im:write",
  "lists:read",
  "lists:write",
  "mpim:history",
  "mpim:read",
  "mpim:write",
  "reactions:read",
  "reactions:write",
  "search:read.files",
  "search:read.im",
  "search:read.mpim",
  "search:read.private",
  "search:read.public",
  "search:read.users",
  "users:read",
  "users:read.email",
];

/**
 * The redirect URIs registered on every app Hercule creates. Slack lets a
 * loopback URI ignore the port, so one app serves a controller on any port.
 */
const SLACK_REDIRECT_URIS = [
  "http://127.0.0.1/oauth/callback",
  "http://localhost/oauth/callback",
  "http://127.0.0.1/callback",
];

/** The name of the one value the user pastes: the app configuration token. */
const CONFIGURATION_TOKEN_FIELD = "configurationToken";

/** Where the user makes a configuration token, in the words of Slack's own page. */
const HOW_TO_MAKE_TOKEN =
  "Go to api.slack.com/apps, open Your App Configuration Tokens, choose Generate Token, pick the workspace, and copy the Access Token.";

/**
 * Builds the manifest of the Slack app Hercule creates, as the JSON text
 * Slack's Web API takes. It is built from the same constants as the
 * connection type's declaration, so the scopes and redirect URLs the app is
 * registered with can never differ from the ones the sign-in asks for.
 *
 * `token_rotation_enabled` makes the access tokens short-lived and refreshable,
 * `is_mcp_enabled` lets the app talk to Slack's MCP server, and `pkce_enabled`
 * lets the sign-in work without a client secret.
 */
const buildAppManifest = (): string =>
  JSON.stringify({
    display_information: {
      name: "Hercule",
      description: "Connects Hercule to this Slack workspace.",
    },
    oauth_config: {
      redirect_urls: SLACK_REDIRECT_URIS,
      scopes: { user: SLACK_USER_SCOPES },
      pkce_enabled: true,
      token_management_enabled: true,
    },
    settings: {
      is_mcp_enabled: true,
      token_rotation_enabled: true,
      org_deploy_enabled: false,
      socket_mode_enabled: false,
    },
  });

const failValidation = (message: string) =>
  Effect.fail(new ConnectionValidationFailed({ message }));

/**
 * Posts to a Slack Web API method with the token as a Bearer header, and
 * returns the parsed JSON answer, not yet checked against a schema. Fails with
 * a `ConnectionValidationFailed` when Slack cannot be reached, does not answer
 * in time, answers HTTP 429, answers another status that is not 2xx, or
 * answers something that is not JSON. Slack reports its own failures in a 200
 * answer with `ok: false`, which the caller reads.
 *
 * The message never quotes the answer, which can hold secrets.
 */
const postToSlack = (
  url: string,
  token: string,
  jsonBody?: string,
): Effect.Effect<unknown, ConnectionValidationFailed, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const baseRequest = HttpClientRequest.post(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
    const request =
      jsonBody === undefined
        ? baseRequest
        : HttpClientRequest.bodyText(jsonBody, "application/json; charset=utf-8")(baseRequest);
    const response = yield* HttpClient.execute(request);
    if (response.status === 429) {
      return yield* failValidation(
        "Slack is limiting how often Hercule may ask. Try again in a minute.",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* failValidation(
        `Slack answered HTTP ${String(response.status)}. Try again in a minute.`,
      );
    }
    return yield* response.json.pipe(
      Effect.mapError(
        () =>
          new ConnectionValidationFailed({
            message: "Slack's answer could not be read as JSON. Try again in a minute.",
          }),
      ),
    );
  }).pipe(
    Effect.catchTag("HttpClientError", (error) =>
      failValidation(`Slack could not be reached: ${error.message}`),
    ),
    Effect.timeoutOrElse({
      duration: SLACK_REQUEST_TIMEOUT,
      orElse: () =>
        failValidation(
          `Slack did not answer within ${String(Duration.toSeconds(SLACK_REQUEST_TIMEOUT))} seconds. Try again.`,
        ),
    }),
  );

/**
 * Decodes a Slack answer with `schema`. Fails with a fixed message, because
 * the message of a decoding error quotes the value, which can be a secret.
 */
const decodeAnswer = <S extends Schema.Decoder<unknown>>(
  schema: S,
  answer: unknown,
): Effect.Effect<S["Type"], ConnectionValidationFailed> =>
  Schema.decodeUnknownEffect(schema)(answer).pipe(
    Effect.mapError(
      () =>
        new ConnectionValidationFailed({
          message: "Slack's answer did not have the shape Hercule expected. Try again later.",
        }),
    ),
  );

/**
 * Returns a Slack error code for a message, or `unknown` when the code holds
 * anything but lowercase letters, digits and underscores. A message names
 * Slack's code and nothing else Slack sent.
 */
const nameErrorCode = (code: string | undefined): string =>
  code !== undefined && /^[a-z0-9_]+$/.test(code) ? code : "unknown";

/**
 * Only the fields of `apps.manifest.create`'s answer that Hercule reads. The
 * answer also holds the app's client secret, signing secret and verification
 * token. Decoding drops every field not named here, so those secrets never
 * reach a value of this plugin.
 */
const CreateAppAnswer = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        message: Schema.optionalKey(Schema.String),
        pointer: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  app_id: Schema.optionalKey(Schema.String),
  credentials: Schema.optionalKey(Schema.Struct({ client_id: Schema.optionalKey(Schema.String) })),
});

/** The message for the reasons Slack gives for refusing the manifest. */
const describeManifestProblems = (
  problems: ReadonlyArray<{ readonly message?: string; readonly pointer?: string }> | undefined,
): string => {
  const listed = (problems ?? [])
    .slice(0, MAX_MANIFEST_PROBLEMS)
    .map(({ pointer, message }) =>
      [pointer, message].filter((part) => part !== undefined).join(": "),
    )
    .filter((line) => line !== "");
  return listed.length === 0 ? "" : ` Slack's reasons: ${listed.join("; ")}.`;
};

/**
 * Returns the message that tells the user what Slack's error code from
 * `apps.manifest.create` means and what to do about it.
 */
const describeCreateAppError = (
  code: string | undefined,
  problems: ReadonlyArray<{ readonly message?: string; readonly pointer?: string }> | undefined,
): string => {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
      return `Slack does not accept this as an app configuration token. Make a new one. ${HOW_TO_MAKE_TOKEN}`;
    case "token_expired":
      return `This configuration token has expired: Slack configuration tokens last 12 hours. Make a new one. ${HOW_TO_MAKE_TOKEN}`;
    case "token_revoked":
      return `This configuration token was revoked. Make a new one. ${HOW_TO_MAKE_TOKEN}`;
    case "not_allowed_token_type":
      return `Slack does not allow this kind of token to create an app. Make an app configuration token. ${HOW_TO_MAKE_TOKEN}`;
    case "invalid_manifest":
      return `Slack refused the app that Hercule asked it to create. This is a bug in Hercule: report it.${describeManifestProblems(problems)}`;
    case "ratelimited":
      return "Slack is limiting how often Hercule may ask. Try again in a minute.";
    default:
      return `Slack could not create the app (error code: ${nameErrorCode(code)}). Try again, and if it keeps failing, report it.`;
  }
};

/**
 * Checks that a pasted value could be an app configuration access token, and
 * returns it trimmed. Fails with a message that names the mistake, for the
 * mistakes that are easy to make on Slack's token page:
 *
 * - nothing pasted;
 * - the configuration refresh token, which starts with `xoxe-` (the access
 *   token starts with `xoxe.xoxp-`);
 * - a bot, user or app-level token (`xoxb-`, `xoxp-`, `xapp-`).
 */
const checkConfigurationToken = (
  value: string | undefined,
): Effect.Effect<string, ConnectionValidationFailed> => {
  const token = value?.trim() ?? "";
  if (token === "") {
    return failValidation(`The configuration token is missing. ${HOW_TO_MAKE_TOKEN}`);
  }
  if (token.startsWith("xoxe-")) {
    return failValidation(
      "This is the configuration Refresh Token, which starts with xoxe-. Copy the Access Token instead, which starts with xoxe.xoxp-.",
    );
  }
  if (/^(xoxb|xoxp|xapp)-/.test(token)) {
    return failValidation(
      `This is a bot, user or app-level token, not an app configuration token. ${HOW_TO_MAKE_TOKEN}`,
    );
  }
  return Effect.succeed(token);
};

/**
 * Returns an effect that deletes the app that `createOAuthClient` made, with
 * the configuration token that made it. The core runs it when the sign-in is
 * abandoned or fails, so no unused Hercule app stays in the workspace.
 *
 * It never fails: Slack's answer, a failed request and a timeout are all
 * dropped, because the sign-in has already ended and the user can delete the
 * app at api.slack.com/apps. It does nothing when Slack gave no app id.
 */
const deleteApp = (
  token: string,
  appId: string | undefined,
): Effect.Effect<void, never, HttpClient.HttpClient> =>
  appId === undefined
    ? Effect.void
    : postToSlack(DELETE_APP_URL, token, JSON.stringify({ app_id: appId })).pipe(Effect.ignore);

/**
 * Creates a Slack app in the user's workspace from their configuration token,
 * and returns the app's client id and an effect that deletes the app again.
 * The token is used for the request and kept in memory only for that effect.
 * Fails with a `ConnectionValidationFailed` that says what was wrong and what
 * to do, as `checkConfigurationToken` and `describeCreateAppError` describe.
 */
const createOAuthClient: NonNullable<ConnectionTypeContribution["createOAuthClient"]> = (values) =>
  Effect.gen(function* () {
    const token = yield* checkConfigurationToken(values[CONFIGURATION_TOKEN_FIELD]);
    const answer = yield* postToSlack(
      CREATE_APP_URL,
      token,
      JSON.stringify({ manifest: buildAppManifest() }),
    ).pipe(Effect.flatMap((json) => decodeAnswer(CreateAppAnswer, json)));
    if (!answer.ok) {
      return yield* failValidation(describeCreateAppError(answer.error, answer.errors));
    }
    const clientId = answer.credentials?.client_id;
    if (clientId === undefined || clientId === "") {
      const appName =
        answer.app_id === undefined ? "the app named Hercule" : `the app ${answer.app_id}`;
      return yield* failValidation(
        `Slack created the app but did not return its client id. Delete ${appName} at api.slack.com/apps and try again.`,
      );
    }
    return { clientId, deleteClient: deleteApp(token, answer.app_id) } satisfies CreatedOAuthClient;
  });

/** The fields of `auth.test`'s answer that `validate` reads. */
const AuthTestAnswer = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  team: Schema.optionalKey(Schema.String),
  team_id: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(Schema.String),
  user_id: Schema.optionalKey(Schema.String),
});

/** Returns the message for Slack's error code from `auth.test`. */
const describeAuthTestError = (code: string | undefined): string => {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
    case "token_expired":
    case "token_revoked":
    case "account_inactive":
      return `Slack no longer accepts this sign-in (error code: ${nameErrorCode(code)}). Connect Slack again.`;
    case "ratelimited":
      return "Slack is limiting how often Hercule may ask. Try again in a minute.";
    default:
      return `Slack could not check this sign-in (error code: ${nameErrorCode(code)}). Try again, and if it keeps failing, report it.`;
  }
};

/**
 * Asks Slack whom the access token belongs to. The account id is `<team id>:
 * <user id>` and the display name is `<workspace name> · <user name>`: a Slack
 * user belongs to one workspace, so the pair names one account, and both ids
 * stay the same when either is renamed. The host compares the account id on a
 * reconnect, so a reconnect cannot switch the Connection to another account.
 *
 * Fails with a `ConnectionValidationFailed` when no `accessToken` was given or
 * Slack refuses it.
 */
const validate: ConnectionTypeContribution["validate"] = (credentials) =>
  Effect.gen(function* () {
    const token = credentials["accessToken"];
    if (token === undefined || token === "") {
      return yield* failValidation("No Slack credential was given.");
    }
    const answer = yield* postToSlack(AUTH_TEST_URL, token).pipe(
      Effect.flatMap((json) => decodeAnswer(AuthTestAnswer, json)),
    );
    if (!answer.ok) return yield* failValidation(describeAuthTestError(answer.error));
    const { team_id, team, user_id, user } = answer;
    if (team_id === undefined || user_id === undefined) {
      return yield* failValidation(
        "Slack's answer did not say which workspace and user this sign-in belongs to. Try again later.",
      );
    }
    return {
      accountId: `${team_id}:${user_id}`,
      displayName: `${team ?? team_id} · ${user ?? user_id}`,
    };
  });

export const connectionType: ConnectionTypeContribution = {
  type: "slack",
  displayName: "Slack",
  setup: [{ kind: "oauth" }],
  oauth: {
    authorizationUrl: "https://slack.com/oauth/v2_user/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.user.access",
    scopes: SLACK_USER_SCOPES,
    // Slack's MCP server names itself as the resource the token is for.
    extraParams: { resource: SLACK_MCP_ORIGIN },
    publicClient: {
      createdAtSetup: {
        fields: [
          {
            name: CONFIGURATION_TOKEN_FIELD,
            label: "Configuration token",
            secret: true,
            help: "Make one at api.slack.com/apps under Your App Configuration Tokens: choose Generate Token, pick the workspace and copy the Access Token. Hercule uses it once to create its Slack app and never stores it.",
          },
        ],
      },
      redirectUris: SLACK_REDIRECT_URIS,
    },
  },
  validate,
  createOAuthClient,
};
