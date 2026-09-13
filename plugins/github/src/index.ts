/**
 * GitHub, as a connection type: a personal access token pasted by the user and
 * checked against the account it belongs to.
 *
 * Nothing else lives here yet. Ingest, resources and the watch list arrive with
 * the tickets that need them; a type with no per-connection config declares no
 * config schema at all.
 */
import { Effect, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  ConnectionValidationFailed,
  HOST_API,
  PluginError,
  type ConnectionTypeContribution,
  type Plugin,
} from "@hydra/plugin-host";

/** The endpoint that answers who a token belongs to. */
const USER_URL = "https://api.github.com/user";

/** GitHub refuses a request without one, so it is part of the contract. */
const USER_AGENT = "Hydra";

const refused = (message: string) => Effect.fail(new ConnectionValidationFailed({ message }));

/** The one field of the answer this plugin reads; the rest of it is GitHub's. */
const Account = Schema.Struct({ login: Schema.String });

const decodeAccount = Schema.decodeUnknownEffect(Account);

/**
 * Asks GitHub who the token belongs to. The login is the account name the
 * Connections screen shows, which is the whole reason for the call.
 */
const validate: ConnectionTypeContribution["validate"] = (credentials) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(USER_URL, {
      headers: {
        // The host hands over exactly the fields the type declared.
        authorization: `Bearer ${credentials["pat"]!}`,
        accept: "application/vnd.github+json",
        "user-agent": USER_AGENT,
      },
    });
    if (response.status === 401) return yield* refused("GitHub rejected the token.");
    if (response.status !== 200) {
      return yield* refused(`GitHub answered ${String(response.status)}.`);
    }
    const account = yield* decodeAccount(yield* response.json).pipe(
      Effect.catchTag("SchemaError", () => refused("GitHub answered without naming an account.")),
    );
    return { displayName: account.login };
  }).pipe(
    Effect.catchTag("HttpClientError", (error) =>
      refused(`GitHub could not be reached: ${error.message}`),
    ),
  );

const connectionType: ConnectionTypeContribution = {
  type: "github",
  displayName: "GitHub",
  setup: [
    {
      kind: "credentials",
      fields: [
        {
          name: "pat",
          label: "Personal access token",
          help: "A fine-grained or classic token with the scopes for the repositories you want Hydra to see.",
        },
      ],
    },
  ],
  validate,
};

export const github: Plugin = {
  manifest: {
    id: "github",
    displayName: "GitHub",
    hostApi: HOST_API,
    capabilities: ["connections"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    host.connections === undefined
      ? Effect.fail(new PluginError({ message: "the connections capability was not granted" }))
      : host.connections.registerType(connectionType),
  // Nothing runs on the controller yet: the ingest loop belongs to the event
  // source ticket.
  activate: () => Effect.succeed(Effect.void),
};
