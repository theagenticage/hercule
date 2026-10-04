/**
 * GitHub, as a connection type. The user signs in through Hercule's own
 * OAuth App with a device flow, or pastes a personal access token instead.
 * Either way the token is checked by asking GitHub which account it belongs
 * to. A Connection's config holds the settings of its feeds: the extra
 * repositories it watches and how far back the checks feed looks.
 */
import { Effect, Schema } from "effect";
import { ConnectionValidationFailed, type ConnectionTypeContribution } from "@hercule/plugin-host";
import { readToken, requestGithub } from "./api";
import { RepoName } from "./repo-name";

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

/**
 * How many days back the checks feed looks for open pull requests when a
 * Connection does not set its own window (spec 08 section 5.1).
 */
export const DEFAULT_CHECKS_WINDOW_DAYS = 7;

/**
 * A GitHub Connection's own settings, shown as a form on the Connection under
 * the schema's title. Every field is optional, so a Connection created before
 * a field existed, with an empty config, stays valid.
 */
export const GithubConnectionConfig = Schema.Struct({
  repos: Schema.optionalKey(
    Schema.Array(RepoName).annotate({
      title: "Extra repositories",
      description: "Repositories to watch beyond the repo Resources linked here, as owner/repo.",
    }),
  ),
  checksWindowDays: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30 })).annotate({
      title: "Checks window (days)",
      description: `Follows checks on open pull requests updated within this many days. ${String(DEFAULT_CHECKS_WINDOW_DAYS)} by default, from 1 to 30.`,
    }),
  ),
}).annotate({ title: "Watching" });

export type GithubConnectionConfig = Schema.Schema.Type<typeof GithubConnectionConfig>;

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
    const token = readToken(credentials);
    if (token === undefined) return yield* failValidation("No GitHub token was given.");
    const response = yield* requestGithub({ method: "GET", path: "/user", token });
    if (response.status === 401) return yield* failValidation("GitHub rejected the token.");
    if (response.status !== 200) {
      return yield* failValidation(`GitHub returned status ${String(response.status)}.`);
    }
    const account = yield* decodeAccount(response.body).pipe(
      Effect.catchTag("SchemaError", () =>
        failValidation("GitHub's response did not include the account's login and user id."),
      ),
    );
    return { displayName: account.login, accountId: String(account.id) };
  }).pipe(Effect.catchTag("GithubUnreachable", (error) => failValidation(error.message)));

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
  configSchema: GithubConnectionConfig,
  validate,
};
