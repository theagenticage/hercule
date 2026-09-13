/**
 * Connections as a plugin sees them: the type it declares at registration, and
 * the connections of that type it reaches at runtime.
 *
 * A connection is core-owned. The plugin contributes what setting one up takes
 * and the one question only it can answer - whether these credentials work, and
 * which account they name - and the core owns the row, the secrets, the status
 * and the screen.
 */
import { Effect, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type { PluginError } from "./plugin";
import { SchemaValue } from "./manifest";

/** Where a connection stands. Ingest runs in `connected` and nowhere else. */
export const ConnectionStatus = Schema.Literals(["connected", "needs-reauth", "error", "disabled"]);

export type ConnectionStatus = Schema.Schema.Type<typeof ConnectionStatus>;

/** One secret the user pastes: named for the store, labelled for the form. */
export const CredentialField = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  help: Schema.optionalKey(Schema.String),
});

export type CredentialField = Schema.Schema.Type<typeof CredentialField>;

/**
 * One step of a setup flow. The set is fixed and the core renders all of it:
 * there is no UI extension point, which is what lets the Connections screen
 * show what a type takes before its plugin is even enabled.
 */
export const SetupStep = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("checklist"), markdown: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("credentials"), fields: Schema.Array(CredentialField) }),
  Schema.Struct({ kind: Schema.Literal("oauth") }),
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
 * Everything about a type that the catalog can hold. `validate` is the rest of
 * the contribution and is deliberately not here: a function does not survive
 * the crossing into a JSON column.
 */
export const ConnectionType = Schema.Struct({
  type: Schema.String.check(Schema.isMinLength(1)),
  displayName: Schema.String.check(Schema.isMinLength(1)),
  setup: Schema.Array(SetupStep),
  oauth: Schema.optionalKey(OAuthDeclaration),
  /** Per-connection plugin config, rendered as a generated form. */
  configSchema: Schema.optionalKey(SchemaValue),
});

export type ConnectionType = Schema.Schema.Type<typeof ConnectionType>;

/** The type turned the credentials down, in the plugin's own words. */
export class ConnectionValidationFailed extends Schema.TaggedError<ConnectionValidationFailed>()(
  "ConnectionValidationFailed",
  { message: Schema.String },
) {}

/**
 * The connection cannot be acted through: it is not one of this plugin's, or
 * its credentials are no longer usable. One error for both, because a plugin
 * may not learn that another plugin's row exists.
 */
export class ConnectionUnavailable extends Schema.TaggedError<ConnectionUnavailable>()(
  "ConnectionUnavailable",
  { message: Schema.String },
) {}

/**
 * What a plugin declares one type as. `validate` asks the external service who
 * the credentials belong to, so it needs an `HttpClient` and nothing else: the
 * host provides the live one, and a plugin test provides a stub.
 */
export interface ConnectionTypeContribution extends Omit<ConnectionType, "setup"> {
  /**
   * The steps, as the plugin hands them over. Widened past {@link SetupStep}
   * because a plugin is untyped code at the boundary: the host decodes this
   * against the schema, and a step it does not know is refused there rather
   * than trusted because a compiler saw it.
   */
  readonly setup: ReadonlyArray<SetupStep | { readonly kind: string }>;
  readonly validate: (
    credentials: Record<string, string>,
  ) => Effect.Effect<
    { readonly displayName: string; readonly detail?: string },
    ConnectionValidationFailed,
    HttpClient.HttpClient
  >;
}

/** What `register` may declare: the types this plugin services. */
export interface ConnectionRegistration {
  readonly registerType: (
    contribution: ConnectionTypeContribution,
  ) => Effect.Effect<void, PluginError>;
}

/** One connection as its own plugin sees it. Never the credential values. */
export interface ConnectionSummary {
  readonly id: string;
  readonly type: string;
  readonly label: string;
  readonly status: ConnectionStatus;
  readonly labels: ReadonlyArray<string>;
  readonly config: Schema.Json;
}

/** What a plugin reports about a connection it has just used. */
export interface ConnectionReport {
  readonly status: "connected" | "needs-reauth" | "error";
  readonly detail?: string;
}

/** The connections of this plugin's own types, and no others. */
export interface ConnectionsRuntime {
  readonly list: () => Effect.Effect<ReadonlyArray<ConnectionSummary>>;
  /** The decoded credentials, by the field names the type declared. */
  readonly credentials: (
    connectionId: string,
  ) => Effect.Effect<Record<string, string>, ConnectionUnavailable>;
  readonly report: (
    connectionId: string,
    report: ConnectionReport,
  ) => Effect.Effect<void, ConnectionUnavailable>;
}
