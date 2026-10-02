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
 * connection. A `checklist` step applies whichever one the user picks.
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
  /** Required when, and only when, `setup` has an `oauth` step. */
  oauth: Schema.optionalKey(OAuthDeclaration),
  /** Required when, and only when, `setup` has a `device` step. */
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

/**
 * A connection type as a plugin declares it. `validate` asks the external
 * service who the credentials belong to, so it needs an `HttpClient` and
 * nothing else: the host provides the real one, and a plugin test provides a
 * stub.
 *
 * `validate` receives the fields the user pasted, or `{ accessToken }` when
 * the connection was set up through a redirect flow or a device flow. A type
 * that offers both kinds of step reads whichever it was given.
 */
export interface ConnectionTypeContribution extends ConnectionType {
  readonly validate: (
    credentials: Record<string, string>,
  ) => Effect.Effect<
    { readonly displayName: string; readonly detail?: string },
    ConnectionValidationFailed,
    HttpClient.HttpClient
  >;
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
