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
import { Duration, Effect, Option, Schema, Stream } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
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

/**
 * The most bytes of an answer that Hercule reads. Slack's answers are a few
 * KiB, so a larger one is not Slack's.
 */
const MAX_ANSWER_BYTES = 64 * 1024;

/**
 * The Slack error codes that a message may quote when it has no text of its
 * own for them. Any other code is not repeated, because a message shows
 * nothing that Slack wrote beyond a code Hercule knows.
 */
const QUOTABLE_ERROR_CODES = [
  "internal_error",
  "fatal_error",
  "service_unavailable",
  "request_timeout",
  "accesslimited",
  "missing_scope",
  "access_denied",
  "no_permission",
  "restricted_action",
];

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

/**
 * What to do when a configuration token cannot be used. The form already shows
 * the steps to make one, so a message says only where and what to copy.
 */
const GENERATE_NEW_TOKEN = "Generate a new one at api.slack.com/apps and copy its Access Token.";

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
 * Reads the whole body of an answer as JSON, refusing a body over
 * `MAX_ANSWER_BYTES` as soon as it grows past the limit. Fails with a
 * `ConnectionValidationFailed` when the body is too large, cannot be read, or
 * is not JSON.
 */
const readAnswerJson = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<unknown, ConnectionValidationFailed> =>
  Effect.gen(function* () {
    const decoder = new TextDecoder();
    let size = 0;
    let text = "";
    yield* Stream.runForEach(response.stream, (chunk) => {
      size += chunk.length;
      if (size > MAX_ANSWER_BYTES) {
        return failValidation("Slack's answer was far larger than expected. Try again later.");
      }
      text += decoder.decode(chunk, { stream: true });
      return Effect.void;
    }).pipe(
      Effect.catchTag("HttpClientError", () =>
        failValidation("Slack's answer could not be read. Try again in a minute."),
      ),
    );
    return yield* Effect.try({
      try: () => JSON.parse(text + decoder.decode()) as unknown,
      catch: () =>
        new ConnectionValidationFailed({
          message: "Slack's answer could not be read as JSON. Try again in a minute.",
        }),
    });
  });

/**
 * Posts to a Slack Web API method with the token as a Bearer header, and
 * returns the parsed JSON answer, not yet checked against a schema. Fails with
 * a `ConnectionValidationFailed` when Slack cannot be reached, does not answer
 * in time, answers HTTP 429, answers another status that is not 2xx (a
 * redirect is not followed, so it counts), or answers something that is
 * larger than `MAX_ANSWER_BYTES` or not JSON. Slack reports its own failures
 * in a 200 answer with `ok: false`, which the caller reads.
 *
 * Every message is fixed text: it never quotes the answer, which can hold
 * secrets, nor the transport's error, which can hold the request.
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
    // The token must go to Slack only. `fetch` follows a redirect with the
    // Authorization header, so a redirect is refused here instead.
    //
    // The response is tied to the scope this function ends, so a refusal
    // before the body is read (a status check) still closes the connection.
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    const response = yield* client
      .execute(request)
      .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
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
    return yield* readAnswerJson(response);
  }).pipe(
    Effect.scoped,
    Effect.catchTag("HttpClientError", () =>
      failValidation(
        "Slack could not be reached. Check the connection to the internet and try again.",
      ),
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
 * Returns how a message refers to a Slack error code it has no text for: the
 * code when it is one of `QUOTABLE_ERROR_CODES`, else "an unexpected error".
 */
const nameUnmappedError = (code: string | undefined): string =>
  code !== undefined && QUOTABLE_ERROR_CODES.includes(code)
    ? `the error "${code}"`
    : "an unexpected error";

/**
 * Only the fields of `apps.manifest.create`'s answer that Hercule reads. The
 * answer also holds the app's client secret, signing secret and verification
 * token. Decoding drops every field not named here, so those secrets never
 * reach a value of this plugin. The app id and the client id are read apart
 * from it, by `readCreatedIds`.
 */
const CreateAppAnswer = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
});

const AppIdField = Schema.Struct({ app_id: Schema.String });
const ClientIdField = Schema.Struct({ credentials: Schema.Struct({ client_id: Schema.String }) });

/** The shape of a Slack app id, such as `A0123ABCD`. */
const APP_ID_SHAPE = /^A[A-Z0-9]{6,}$/;

/** The shape of a Slack client id, such as `12677091710663.12690536129654`. */
const CLIENT_ID_SHAPE = /^\d+\.\d+$/;

/**
 * Reads the app id and the client id from the answer that created an app.
 * Each is read on its own, so that a malformed `credentials` object does not
 * lose a valid app id, which the cleanup needs. A value that is missing or
 * does not have Slack's shape is returned as undefined: it is never logged,
 * returned or kept, because it is not known to be an id.
 */
const readCreatedIds = (
  answer: unknown,
): { readonly appId: string | undefined; readonly clientId: string | undefined } => {
  const appId = Option.getOrUndefined(Schema.decodeUnknownOption(AppIdField)(answer))?.app_id;
  const clientId = Option.getOrUndefined(Schema.decodeUnknownOption(ClientIdField)(answer))
    ?.credentials.client_id;
  return {
    appId: appId !== undefined && APP_ID_SHAPE.test(appId) ? appId : undefined,
    clientId: clientId !== undefined && CLIENT_ID_SHAPE.test(clientId) ? clientId : undefined,
  };
};

/**
 * Returns the message that tells the user what Slack's error code from
 * `apps.manifest.create` means and what to do about it.
 */
const describeCreateAppError = (code: string | undefined): string => {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
      return `Slack does not accept this as an app configuration token. ${GENERATE_NEW_TOKEN}`;
    case "token_expired":
      return `This configuration token has expired: Slack configuration tokens last 12 hours. ${GENERATE_NEW_TOKEN}`;
    case "token_revoked":
      return `This configuration token was revoked. ${GENERATE_NEW_TOKEN}`;
    case "not_allowed_token_type":
      return `Slack does not allow this kind of token to create an app. Make an app configuration token. ${GENERATE_NEW_TOKEN}`;
    case "invalid_manifest":
      return `Slack refused the app that Hercule asked it to create. This is a bug in Hercule: report it.`;
    case "ratelimited":
      return "Slack is limiting how often Hercule may ask. Try again in a minute.";
    default:
      return `Slack could not create the app and answered with ${nameUnmappedError(code)}. Try again, and if it keeps failing, report it.`;
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
    return failValidation(`The configuration token is missing. Paste the Access Token you copied.`);
  }
  if (token.startsWith("xoxe-")) {
    return failValidation(
      "This is the configuration Refresh Token, which starts with xoxe-. Copy the Access Token instead, which starts with xoxe.xoxp-.",
    );
  }
  if (/^(xoxb|xoxp|xapp)-/.test(token)) {
    return failValidation(
      `This is a bot, user or app-level token, not an app configuration token. ${GENERATE_NEW_TOKEN}`,
    );
  }
  return Effect.succeed(token);
};

/** The fields of `apps.manifest.delete`'s answer that Hercule reads. */
const DeleteAppAnswer = Schema.Struct({ ok: Schema.Boolean });

/**
 * Returns an effect that deletes a Slack app that `createOAuthClient` made,
 * with the configuration token that made it, and returns whether Slack
 * confirmed the delete (`ok: true`).
 *
 * It never fails. When Slack refuses, cannot be reached or answers something
 * unreadable, it logs a warning that names the app id (which is not a secret)
 * and says how the user can remove the app, and returns false.
 */
const deleteApp = (
  token: string,
  appId: string,
): Effect.Effect<boolean, never, HttpClient.HttpClient> =>
  postToSlack(DELETE_APP_URL, token, JSON.stringify({ app_id: appId })).pipe(
    Effect.flatMap((json) => decodeAnswer(DeleteAppAnswer, json)),
    Effect.map((answer) => answer.ok),
    Effect.catch(() => Effect.succeed(false)),
    Effect.tap((deleted) =>
      deleted
        ? Effect.void
        : Effect.logWarning(
            `Hercule could not delete the Slack app ${appId} that it created. The user can remove the app named Hercule at api.slack.com/apps.`,
          ),
    ),
  );

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
    const json = yield* postToSlack(
      CREATE_APP_URL,
      token,
      JSON.stringify({ manifest: buildAppManifest() }),
    );
    const answer = yield* decodeAnswer(CreateAppAnswer, json);
    if (!answer.ok) return yield* failValidation(describeCreateAppError(answer.error));
    const { appId, clientId } = readCreatedIds(json);
    if (appId === undefined) {
      return yield* failValidation(
        "Slack did not say which app it created. If an app named Hercule appeared at api.slack.com/apps, delete it, then try again.",
      );
    }
    if (clientId === undefined) {
      const removed = yield* deleteApp(token, appId);
      return yield* failValidation(
        removed
          ? "Slack did not finish creating the app. Hercule removed it. Try again."
          : "Slack did not finish creating the app, and Hercule could not remove it: delete the app named Hercule at api.slack.com/apps, then try again.",
      );
    }
    return {
      clientId,
      deleteClient: Effect.asVoid(deleteApp(token, appId)),
    } satisfies CreatedOAuthClient;
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
      return "Slack no longer accepts this sign-in. Connect Slack again.";
    case "ratelimited":
      return "Slack is limiting how often Hercule may ask. Try again in a minute.";
    default:
      return `Slack could not check this sign-in and answered with ${nameUnmappedError(code)}. Try again, and if it keeps failing, report it.`;
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

/**
 * What the user reads before pasting the configuration token: what Hercule
 * does in their workspace, and where to get the token. It is Markdown, so the
 * address of Slack's app page is a link.
 */
const SETUP_INSTRUCTIONS = [
  "Hercule adds a small app named Hercule to your Slack workspace, so your agents can use Slack as you.",
  "",
  "1. Open Slack's app page, [api.slack.com/apps](https://api.slack.com/apps).",
  "2. Under Your App Configuration Tokens, choose Generate Token, pick your workspace, and copy the Access Token.",
  "3. Paste it here.",
].join("\n");

export const connectionType: ConnectionTypeContribution = {
  type: "slack",
  displayName: "Slack",
  setup: [{ kind: "checklist", markdown: SETUP_INSTRUCTIONS }, { kind: "oauth" }],
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
            help: "Hercule uses it once to create the Slack app, and does not keep it.",
          },
        ],
      },
      redirectUris: SLACK_REDIRECT_URIS,
    },
  },
  validate,
  createOAuthClient,
};
