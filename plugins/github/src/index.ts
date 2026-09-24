/**
 * GitHub, as a connection type: a personal access token pasted by the user and
 * checked by asking GitHub which account it belongs to.
 *
 * It is also the event source for GitHub events: the event kinds it can emit
 * are declared here, so a subscription or a filter can use one before anything
 * polls. Ingest, resources and the watch list will be added with the tickets
 * that need them; a type with no per-connection config declares no config
 * schema at all.
 */
import { Effect, Schema } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import {
  ConnectionValidationFailed,
  HOST_API,
  registerConnectionType,
  registerEventSource,
  type ConnectionTypeContribution,
  type EventSourceDefinition,
  type Plugin,
} from "@hercule/plugin-host";
import { GITHUB_EVENT_KINDS } from "./kinds";

/** The endpoint that returns the account a token belongs to. */
const USER_URL = "https://api.github.com/user";

/** GitHub rejects a request without a user agent, so one is always sent. */
const USER_AGENT = "Hercule";

const failValidation = (message: string) =>
  Effect.fail(new ConnectionValidationFailed({ message }));

/** The only field of the response this plugin reads. */
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
        // The host passes exactly the fields the type declared.
        authorization: `Bearer ${credentials["pat"]!}`,
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
        failValidation("GitHub's response did not include an account name."),
      ),
    );
    return { displayName: account.login };
  }).pipe(
    Effect.catchTag("HttpClientError", (error) =>
      failValidation(`GitHub could not be reached: ${error.message}`),
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
          help: "A fine-grained or classic token with the scopes for the repositories you want Hercule to see.",
        },
      ],
    },
  ],
  validate,
};

/** The unqualified id, which the host prefixes to make `github/github`. */
const eventSource: EventSourceDefinition = {
  id: "github",
  connectionType: "github/github",
  kinds: GITHUB_EVENT_KINDS,
};

export const github: Plugin = {
  manifest: {
    id: "github",
    displayName: "GitHub",
    hostApi: HOST_API,
    capabilities: ["connections", "event-sources"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    Effect.andThen(
      registerConnectionType(host, connectionType),
      registerEventSource(host, eventSource),
    ),
  // Nothing runs on the controller yet: the ingest loop will be added by the
  // event source ticket.
  activate: () => Effect.succeed(Effect.void),
};
