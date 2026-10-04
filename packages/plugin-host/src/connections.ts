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
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { PluginError } from "./plugin";
import { ContributionWord } from "./contributions";
import { SchemaValue } from "./manifest";

/** The status of a connection. Events are ingested only while it is `connected`. */
export const ConnectionStatus = Schema.Literals(["connected", "needs-reauth", "error", "disabled"]);

export type ConnectionStatus = Schema.Schema.Type<typeof ConnectionStatus>;

/**
 * One secret the user pastes: a name for the secrets store, and a label for
 * the form.
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
  readonly detail?: string;
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
