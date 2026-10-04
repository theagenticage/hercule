/**
 * GitHub, as a connection type. The user signs in through Hercule's own
 * OAuth App with a device flow, or pastes a personal access token instead.
 * Either way the token is checked by asking GitHub which account it belongs
 * to.
 */
import { Effect, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { ConnectionValidationFailed, type ConnectionTypeContribution } from "@hercule/plugin-host";

/** The endpoint that returns the account a token belongs to. */
const USER_URL = "https://api.github.com/user";

/**
 * The client id of Hercule's OAuth App on GitHub. A client id is public: the
 * device flow needs no client secret, so every Hercule install can share one
 * app without a relay.
 */
const OAUTH_APP_CLIENT_ID = "Ov23liAQFrHlllNX9ld6";

/**
 * What the account needs: repositories (including private ones and their
 * workflows), the organizations it belongs to, and its notifications.
 */
const SCOPES = ["repo", "read:org", "notifications", "workflow"];

/** GitHub rejects a request without a user agent, so one is always sent. */
const USER_AGENT = "Hercule";

const failValidation = (message: string) =>
  Effect.fail(new ConnectionValidationFailed({ message }));

/**
 * The only fields of the response this plugin reads: the login, which is the
 * account's name, and the numeric user id, which stays the same when the
 * account is renamed.
 */
const Account = Schema.Struct({ login: Schema.String, id: Schema.Number });

const decodeAccount = Schema.decodeUnknownEffect(Account);

/**
 * Asks GitHub who the token belongs to. The login is the account name the
 * Connections screen shows. The user id is the account id the host compares
 * on a reconnect, so that a reconnect cannot switch the connection to
 * another account.
 *
 * The host passes the pasted `pat` field, or the `accessToken` the device
 * flow obtained.
 */
const validate: ConnectionTypeContribution["validate"] = (credentials) =>
  Effect.gen(function* () {
    const token = credentials["pat"] ?? credentials["accessToken"];
    if (token === undefined) return yield* failValidation("No GitHub token was given.");
    const response = yield* HttpClient.get(USER_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
      },
    });
    if (response.status === 401) return yield* failValidation("GitHub rejected the token.");
    if (response.status !== 200) {
      return yield* failValidation(`GitHub returned status ${String(response.status)}.`);
    }
    const account = yield* decodeAccount(yield* response.json).pipe(
      Effect.catchTag("SchemaError", () =>
        failValidation("GitHub's response did not include the account's login and user id."),
      ),
    );
    return { displayName: account.login, accountId: String(account.id) };
  }).pipe(
    Effect.catchTag("HttpClientError", (error) =>
      failValidation(`GitHub could not be reached: ${error.message}`),
    ),
  );

export const connectionType: ConnectionTypeContribution = {
  type: "github",
  displayName: "GitHub",
  // The device flow comes first because it is the one the setup screen
  // offers by default; pasting a token is the fallback.
  setup: [
    { kind: "device" },
    {
      kind: "credentials",
      fields: [
        {
          name: "pat",
          label: "Personal access token",
          help: "A fine-grained or classic token with the scopes for the repositories you want Hercule to see.",
        },
      ],
    },
  ],
  device: {
    clientId: OAUTH_APP_CLIENT_ID,
    deviceCodeUrl: "https://github.com/login/device/code",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: SCOPES,
  },
  validate,
};
