/**
 * Connections as a plugin sees them: the type it declares at registration, and
 * the connections of that type it reaches at runtime.
 *
 * The core owns a connection. The plugin contributes what setting one up takes,
 * and answers the one question only it can answer: whether these credentials
 * work, and which account they belong to. The core owns the row, the secrets,
 * the status and the screen.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import type { PluginError } from "./plugin";
import { ContributionWord } from "./contributions";
import { SchemaValue } from "./manifest";

/** The status of a connection. Events are ingested only while it is `connected`. */
export const ConnectionStatus = Schema.Literals(["connected", "needs-reauth", "error", "disabled"]);

export type ConnectionStatus = Schema.Schema.Type<typeof ConnectionStatus>;

/**
 * One value the user pastes: a name for the secrets store, and a label for
 * the form. `secret: true` marks a value that must never reach an agent, such
 * as a token or a key. A value that only names something, such as an
 * organization slug or a URL, stays unmarked. The MCP Gateway removes the
 * marked values from every answer it relays, at any length, and removes no
 * other value of the Connection.
 *
 * The value is stored under the name, and the store binds a value to
 * `<kind>|<id>|<name>`, so a name containing the separator would be ambiguous.
 * It is rejected here, where the plugin author sees the error, rather than at
 * the write, where the user would.
 */
export const CredentialField = Schema.Struct({
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isPattern(/^[^|]+$/, {
      message: "A credential field name cannot contain a | character.",
    }),
  ),
  label: Schema.String,
  help: Schema.optionalKey(Schema.String),
  secret: Schema.optionalKey(Schema.Boolean),
});

export type CredentialField = Schema.Schema.Type<typeof CredentialField>;

/**
 * One step of a setup flow. The set of steps is fixed and the core renders all
 * of them: there is no UI extension point. That is what lets the Connections
 * screen show what a type needs before its plugin is even enabled.
 *
 * Three steps each obtain the credential in their own way: `credentials` (the
 * user pastes it), `oauth` (a redirect flow) and `device` (a device flow). A
 * type that declares more than one of them lets the user pick one for each
 * connection, with one exception: a type that declares both `oauth` and
 * `device` is refused at registration, because a type offers a redirect flow
 * or a device flow, not both. A `checklist` step applies whichever one the
 * user picks, and a `pairing` step obtains no credential.
 */
export const SetupStep = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("checklist"), markdown: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("credentials"), fields: Schema.Array(CredentialField) }),
  Schema.Struct({ kind: Schema.Literal("oauth") }),
  Schema.Struct({ kind: Schema.Literal("device") }),
  Schema.Struct({ kind: Schema.Literal("pairing") }),
]);

export type SetupStep = Schema.Schema.Type<typeof SetupStep>;

/** What the core's own OAuth2 client needs to run a type's redirect flow. */
export const OAuthDeclaration = Schema.Struct({
  authorizationUrl: Schema.String,
  tokenUrl: Schema.String,
  scopes: Schema.Array(Schema.String),
  extraParams: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /**
   * The resource the tokens are for, as an address (RFC 8707). The core sends it
   * on the authorization request and on every token request, the code exchange
   * and each refresh, because a provider that scopes tokens by resource needs it
   * on all of them. Leave it out when the provider does not.
   */
  resource: Schema.optionalKey(Schema.String),
  /**
   * Error codes this provider's token endpoint answers with when it cannot serve
   * the request now: "try again later", not "refused". The core treats such an
   * answer to a code exchange or a refresh as an unreachable provider, so a
   * Connection whose refresh hit one stays connected and is tried again, where
   * any other error code from the endpoint sends it to be signed in again. List
   * only codes that never mean the grant is bad.
   */
  transientErrors: Schema.optionalKey(Schema.Array(Schema.String)),
  /**
   * A public client, for a provider that accepts a code exchange and a
   * refresh with the client id and the PKCE code verifier alone. The core
   * then sends no client secret and reads nothing from the plugin's settings.
   * It comes in two forms.
   *
   * - `clientId`: a client the plugin ships. `redirectUris` are exactly the
   *   URIs the provider has registered for it, because a shared client cannot
   *   register every user's address.
   * - `createdAtSetup`: a client the plugin creates for each Connection when
   *   it is set up, with the plugin's `createOAuthClient`, from values the
   *   user pastes once (the `fields`). The core never stores those values.
   *   `redirectUris` are the URIs the plugin registers on every client it
   *   creates.
   *
   * A `redirectUris` entry that is an `http` loopback URI without a port
   * matches that URI at any port (RFC 8252 section 7.3). An entry with a
   * port matches only that port.
   */
  publicClient: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({ clientId: Schema.String, redirectUris: Schema.Array(Schema.String) }),
      Schema.Struct({
        createdAtSetup: Schema.Struct({ fields: Schema.Array(CredentialField) }),
        redirectUris: Schema.Array(Schema.String),
      }),
    ]),
  ),
});

export type OAuthDeclaration = Schema.Schema.Type<typeof OAuthDeclaration>;

/**
 * What the core's own OAuth2 client needs to run a type's device flow
 * (RFC 8628). The client id is part of the declaration, because a device flow
 * needs no client secret: the id is public, and the plugin ships it.
 */
export const DeviceDeclaration = Schema.Struct({
  clientId: Schema.String.check(Schema.isMinLength(1)),
  deviceCodeUrl: Schema.String,
  tokenUrl: Schema.String,
  scopes: Schema.Array(Schema.String),
});

export type DeviceDeclaration = Schema.Schema.Type<typeof DeviceDeclaration>;

/**
 * Everything about a type that the catalog can store. `validate` is the rest of
 * the contribution and is deliberately not here: a function cannot be stored
 * in a JSON column.
 */
export const ConnectionType = Schema.Struct({
  /**
   * The plugin's own short name for the type. The host prefixes it with the
   * plugin's id to make the id the rest of Hercule uses. The separator is
   * rejected here, where the plugin author sees the error, so that the
   * qualified id has exactly one meaning.
   */
  type: ContributionWord,
  displayName: Schema.String.check(Schema.isMinLength(1)),
  setup: Schema.Array(SetupStep),
  /**
   * Required when, and only when, `setup` has an `oauth` step. A type that
   * declares both `oauth` and `device` is refused at registration.
   */
  oauth: Schema.optionalKey(OAuthDeclaration),
  /**
   * Required when, and only when, `setup` has a `device` step. A type that
   * declares both `oauth` and `device` is refused at registration.
   */
  device: Schema.optionalKey(DeviceDeclaration),
  /** Per-connection plugin config, rendered as a generated form. */
  configSchema: Schema.optionalKey(SchemaValue),
});

export type ConnectionType = Schema.Schema.Type<typeof ConnectionType>;

/** The type rejected the credentials, with the plugin's own message. */
export class ConnectionValidationFailed extends Schema.TaggedError<ConnectionValidationFailed>()(
  "ConnectionValidationFailed",
  { message: Schema.String },
) {}

/**
 * The connection cannot be used: it does not belong to this plugin, or its
 * credentials are no longer usable. One error for both, because a plugin must
 * not learn that another plugin's row exists.
 */
export class ConnectionUnavailable extends Schema.TaggedError<ConnectionUnavailable>()(
  "ConnectionUnavailable",
  { message: Schema.String },
) {}

/** The public OAuth client a plugin created for one Connection. */
export interface CreatedOAuthClient {
  /** The id the provider gave the client. The core sends it, with no secret, on every exchange and refresh. */
  readonly clientId: string;
  /**
   * Deletes the client at the provider. The core calls it when the sign-in the
   * client was created for ends without a Connection (the user never came
   * back, denied, or signed in to another account). It is dropped, uncalled,
   * once the sign-in succeeds.
   *
   * It holds what it needs in memory (for example the configuration token the
   * user pasted), so that the core never stores it. It never fails: it logs
   * nothing secret and swallows its own errors, because a client left behind
   * is a nuisance and not a reason to fail the user's sign-in.
   */
  readonly deleteClient: Effect.Effect<void, never, HttpClient.HttpClient>;
}

/** The external account a set of credentials belongs to, as the type's `validate` returns it. */
export interface ExternalAccount {
  /** The account's name, which the Connections screen shows: the GitHub login, the Gmail address. */
  readonly displayName: string;
  /**
   * The provider's stable id for the account, such as GitHub's numeric user
   * id as a string. It must not be empty, and it must stay the same when the
   * account is renamed: the core compares it on every reconnect, so that new
   * credentials for another account are refused. The core cannot compare the
   * account name instead, because a renamed login would then be refused too.
   *
   * The core treats a `validate` that returns an empty `accountId` as a failed
   * validation, because an empty id would match any other empty id.
   */
  readonly accountId: string;
  /**
   * One sentence the Connection shows as long as these credentials are in
   * use, when they work but cost the user something: "This fine-grained
   * token cannot read notifications, so review requests raise no signal."
   */
  readonly warning?: string;
}

/**
 * One choice for a config field that loads its choices from the external
 * account, such as a Sentry team. `value` is what the config stores; `label`
 * is what the form shows.
 */
export interface ConfigChoice {
  readonly value: string;
  readonly label: string;
}

/**
 * A connection type as a plugin declares it. `validate` asks the external
 * service who the credentials belong to, so it needs an `HttpClient` and
 * nothing else: the host provides the real one, and a plugin test provides a
 * stub. It returns the account's name and the provider's stable `accountId`,
 * which the host compares on every reconnect (see `ExternalAccount`).
 *
 * `validate` receives the fields the user pasted, or `{ accessToken }` when
 * the connection was set up through a redirect flow or a device flow. A type
 * that offers both kinds of step reads whichever it was given.
 */
export interface ConnectionTypeContribution extends ConnectionType {
  readonly validate: (
    credentials: Record<string, string>,
  ) => Effect.Effect<ExternalAccount, ConnectionValidationFailed, HttpClient.HttpClient>;
  /**
   * Creates a public OAuth client for one Connection and returns its id.
   * Required when, and only when, `oauth.publicClient` is `createdAtSetup`.
   *
   * `values` holds exactly the fields `createdAtSetup` declares, as the user
   * pasted them, none of them empty. The core calls this once per setup, before
   * it opens the provider's sign-in page, and keeps the returned `clientId`
   * with the Connection. It keeps nothing else: a value the user pasted, and
   * anything else the provider returns (a client secret, a signing secret),
   * must stay inside this function. Fails with `ConnectionValidationFailed`,
   * whose message the user reads, when the provider refuses: say what was
   * wrong and what the user should do. The message must not contain a value
   * the user pasted.
   */
  readonly createOAuthClient?: (
    values: Record<string, string>,
  ) => Effect.Effect<CreatedOAuthClient, ConnectionValidationFailed, HttpClient.HttpClient>;
  /**
   * Returns the choices for one config field, read from the external account
   * with the connection's credentials. Required when a
   * property of `configSchema` carries the `choices: true` annotation; only a
   * string or a list of strings may carry it. `credentials` has the shape
   * `ConnectionsRuntime.credentials` returns, and `config` is the connection's
   * stored config. Fails with `PluginError`, whose message the form shows,
   * when the service cannot be read. At most 1,000 choices.
   */
  readonly listChoices?: (
    field: string,
    connection: { readonly credentials: Record<string, string>; readonly config: unknown },
  ) => Effect.Effect<ReadonlyArray<ConfigChoice>, PluginError, HttpClient.HttpClient>;
}

/** What `register` may declare: the connection types this plugin supports. */
export interface ConnectionRegistration {
  readonly registerType: (
    contribution: ConnectionTypeContribution,
  ) => Effect.Effect<void, PluginError>;
}

/** One connection as its own plugin sees it. Never the credential values. */
export interface ConnectionSummary {
  readonly id: string;
  /** The qualified type, `<pluginId>/<word>`, not the short name the plugin declared. */
  readonly type: string;
  readonly label: string;
  readonly status: ConnectionStatus;
  readonly labels: ReadonlyArray<string>;
  readonly config: Readonly<Record<string, Schema.Json>>;
}

/** What a plugin reports about a connection it has just used. */
export interface ConnectionReport {
  readonly status: "connected" | "needs-reauth" | "error";
  readonly detail?: string;
}

/** The connections of this plugin's own types, and no others. */
export interface ConnectionsRuntime {
  readonly list: () => Effect.Effect<ReadonlyArray<ConnectionSummary>>;
  /**
   * Returns the connection's credentials, decrypted: the fields the user
   * pasted, or `{ accessToken }` for a connection set up through a redirect
   * flow or a device flow. Which of the two depends on how this connection was
   * set up, not on its type. An access token is refreshed first when it has
   * expired or is about to.
   */
  readonly credentials: (
    connectionId: string,
  ) => Effect.Effect<Record<string, string>, ConnectionUnavailable>;
  readonly report: (
    connectionId: string,
    report: ConnectionReport,
  ) => Effect.Effect<void, ConnectionUnavailable>;
}
