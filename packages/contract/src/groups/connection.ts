/**
 * Connections: one record per external account Hercule acts through.
 *
 * The type is a plugin contribution, so what a connection needs to be set up -
 * its fields, its config schema - comes from the plugin catalog rather than
 * from here. This file holds the record the core owns: which account it is,
 * its status, and which secrets it owns.
 *
 * A `type` anywhere below is `<pluginId>/<word>`, as the catalog lists it. It
 * is one opaque string: a client passes back what the catalog gave it and never
 * parses it.
 *
 * `credentials` is references only. A value goes in on create or on a rotation
 * and is never read back, by this API or any other.
 */
import { Schema } from "effect";
import { ConnectionStatus } from "@hercule/plugin-host";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";
import {
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Id, Timestamp } from "../ids";
import { page, pageParams } from "../pagination";
import { Authenticated } from "../security";
import { atMost, bounded, SecretValue } from "../strings";
import { Label, MAX_TASK_LABELS } from "./task";

/** Re-exported from the package plugins are written against, so both use the same list. */
export { ConnectionStatus } from "@hercule/plugin-host";

/**
 * The qualified id of the shipped GitHub connection type. A repo's credential
 * is a GitHub token, so a repo can act through no other kind of account. Every
 * place that applies this rule - the controller, the CLI, the web app's
 * account pickers - imports the id from here rather than writing it again.
 */
export const GITHUB_CONNECTION_TYPE = "github/github";

/** The longest user-given label: "work", "personal". */
export const MAX_CONNECTION_LABEL_LENGTH = 128;

const ConnectionLabel = bounded(1, MAX_CONNECTION_LABEL_LENGTH);

/**
 * The topics a connection's events file into. At least one, because the first
 * is the connection's default topic and triage has nothing to fall back on.
 */
const Topics = atMost(Label, MAX_TASK_LABELS).check(Schema.isMinLength(1));

/**
 * The browser's origin and nothing else: scheme and host, with no path and no
 * trailing slash. The redirect URI is this origin followed by the callback
 * path, and it must match what the user registered with the provider byte for
 * byte, so the shape is fixed here rather than normalised on either side.
 */
const Origin = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^/?#]+$/, {
    message: "Write the origin as a scheme and a host with no path, like https://hercule.example.",
  }),
);

/** A connection's own plugin config, validated against the type's declared schema. */
const Config = Schema.Record(Schema.String, Schema.Json);

/** The credential values the user pastes, keyed by the field names the type declared. */
const Credentials = Schema.Record(Schema.String, SecretValue);

/** One secret the connection owns. The name, and when it was last replaced. */
export const CredentialRef = Schema.Struct({
  name: Schema.String,
  rotatedAt: Schema.optionalKey(Timestamp),
});

export type CredentialRef = Schema.Schema.Type<typeof CredentialRef>;

export const Connection = Schema.Struct({
  id: Id,
  type: Schema.String,
  label: ConnectionLabel,
  /** The account name the type's own `validate` returned. */
  displayName: Schema.String,
  status: ConnectionStatus,
  statusDetail: Schema.optionalKey(Schema.String),
  labels: Schema.Array(Label),
  config: Config,
  credentials: Schema.Array(CredentialRef),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type Connection = Schema.Schema.Type<typeof Connection>;

/** What a connection listing may be sorted by. */
export const CONNECTION_SORT_FIELDS = ["createdAt", "label"] as const;

export const ConnectionCreateInput = Schema.Struct({
  type: Schema.String,
  label: ConnectionLabel,
  labels: Topics,
  config: Schema.optionalKey(Config),
  credentials: Credentials,
});

export type ConnectionCreateInput = Schema.Schema.Type<typeof ConnectionCreateInput>;

/** The payload of `connection.update`: what the user chose, never the account. */
export const ConnectionUpdateInput = Schema.Struct({
  label: Schema.optionalKey(ConnectionLabel),
  labels: Schema.optionalKey(Topics),
  config: Schema.optionalKey(Config),
});

export type ConnectionUpdateInput = Schema.Schema.Type<typeof ConnectionUpdateInput>;

/** A fresh set of values for the fields the type declares. */
export const ConnectionCredentialsInput = Schema.Struct({ credentials: Credentials });

export type ConnectionCredentialsInput = Schema.Schema.Type<typeof ConnectionCredentialsInput>;

/**
 * The payload for starting a redirect flow. `origin` is the browser's origin:
 * the controller cannot see it, and the redirect URI built from it must match
 * what the user registered with the provider, so it has to come from the
 * browser.
 *
 * `label`, `labels` and `config` are optional because on a reconnect, the
 * existing connection already has them.
 */
export const ConnectionOAuthStartInput = Schema.Struct({
  type: Schema.String,
  origin: Origin,
  label: Schema.optionalKey(ConnectionLabel),
  labels: Schema.optionalKey(Topics),
  config: Schema.optionalKey(Config),
  /** Set on a reconnect: the connection whose tokens this flow replaces. */
  connectionId: Schema.optionalKey(Id),
});

export type ConnectionOAuthStartInput = Schema.Schema.Type<typeof ConnectionOAuthStartInput>;

/** Where to send the browser. The state and the verifier stay on the server. */
export const ConnectionOAuthStart = Schema.Struct({ authorizationUrl: Schema.String });

export type ConnectionOAuthStart = Schema.Schema.Type<typeof ConnectionOAuthStart>;

export const connection = HttpApiGroup.make("connection")
  .add(
    HttpApiEndpoint.get("query", "/connections", {
      query: Schema.Struct({
        type: Schema.optionalKey(Schema.String),
        status: Schema.optionalKey(ConnectionStatus),
        ...pageParams(CONNECTION_SORT_FIELDS).fields,
      }),
      success: page(Connection),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("read", "/connections/:id", {
      params: { id: Id },
      success: Connection,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("create", "/connections", {
      payload: ConnectionCreateInput,
      // The request creates a new connection, so it returns `201` rather than
      // the `200` an edit returns.
      success: HttpApiSchema.status(201)(Connection),
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.patch("update", "/connections/:id", {
      params: { id: Id },
      payload: ConnectionUpdateInput,
      success: Connection,
      // `invalid_state`: the stored row has a type this build no longer
      // defines. A different build fixes that, not a different request.
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.delete("delete", "/connections/:id", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    HttpApiEndpoint.post("setCredentials", "/connections/:id/credentials", {
      params: { id: Id },
      payload: ConnectionCredentialsInput,
      success: Connection,
      // `invalid_state`: as on `update`, the row has a type this build no
      // longer defines.
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    // Not under `/connections`: what it starts is a setup, and a setup is not a
    // connection until the provider sends the browser back.
    HttpApiEndpoint.post("startOAuth", "/oauth/start", {
      payload: ConnectionOAuthStartInput,
      success: ConnectionOAuthStart,
      // `invalid_state`: the plugin that owns the type has no client
      // credentials. The user fixes that in Settings; a different request
      // cannot.
      error: [Unauthenticated, Forbidden, Validation, InvalidState, Internal],
    }),
  )
  .middleware(Authenticated);
