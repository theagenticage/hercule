/**
 * How a check or a call reaches one MCP Server: where it sends a request and
 * with which credential (spec 21 sections 3.10 and 5.1).
 *
 * A server can be reached in more than one way. A plugin server is reached
 * at the origin its plugin's contribution names, with the credential of a
 * Connection. A server added by URL is reached at its own address, with its
 * own sign-in. `ServerAccess` hides which way it is, so `checks.ts`,
 * `calls.ts` and `upstream.ts` never name a contribution, a Connection or a
 * sign-in to send a request. Each way is one adapter in this file, and
 * `resolveServerAccess` picks it.
 *
 * Only a check or a call resolves an access, at the point it is about to send.
 * The verdicts of the catalogue (`isServable`, `decideCallRefusal`,
 * `decideLeftOutReason`) stay pure functions of the view and are never routed
 * through here.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  computeCredentialsIdentity,
  ConnectionCannotRefresh,
  ConnectionCredentialsUnavailable,
  type ConnectionTypes,
  type RefreshGuard,
  type StoredConnection,
} from "../connections";
import {
  describeSignInFix,
  judgeDependencies,
  type McpServerAvailabilityView,
  type UsablePlugin,
} from "./catalogue";
import type { StoredMcpServerAvailability } from "./repository";
import { SIGN_IN_TOKEN_SECRET, type McpServerSignIns } from "./sign-ins";

/**
 * What one request to an MCP Server carries.
 *
 * - `credentials` are the values the endpoint builds its request from.
 * - `secretNames` are the names, among `credentials`, of the values that must
 *   never reach an agent. The upstream session removes them from every answer.
 * - `config` is what the endpoint needs besides the credentials, such as a
 *   Connection's decoded settings (`{}` when there are none).
 * - `identity` is a fingerprint of the credential values, which never reveals
 *   them. It changes when the credentials change. A caller hands it back to
 *   `ServerCredentials.refreshAfterRejection` to say which credentials the
 *   server refused.
 */
export interface UpstreamCredentials {
  readonly credentials: Record<string, string>;
  readonly secretNames: ReadonlyArray<string>;
  readonly config: unknown;
  readonly identity: string;
}

/**
 * The address of an MCP Server and how a request to it is built.
 *
 * `checkUrlOnOrigin` runs on every request built here: the URL must be on
 * `origin`, whatever `buildRequest` returns.
 */
export interface UpstreamEndpoint {
  /** Scheme, host and optional port that every request goes to. */
  readonly origin: string;
  /** The name that messages about the server use for its vendor. */
  readonly displayName: string;
  /**
   * Builds the URL and the headers of one request from the credentials it
   * carries. Pure: no I/O. May throw, which the caller turns into a failure
   * that says nothing about what was thrown, because that may hold a
   * credential.
   */
  readonly buildRequest: (credentials: UpstreamCredentials) => {
    readonly url: string;
    readonly headers: Record<string, string>;
  };
}

/**
 * A server cannot give credentials right now. `status` and `detail` are what
 * the server shows because of it, in words a person can act on, and never
 * hold what the provider sent. `cause` is `connection` when a Connection
 * needs the user, and not the server itself.
 */
export class ServerCredentialsUnavailable extends Schema.TaggedError<ServerCredentialsUnavailable>()(
  "ServerCredentialsUnavailable",
  {
    status: Schema.Literals(["unreachable", "error", "needs-sign-in"]),
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Literal("connection")),
  },
) {}

/**
 * The credentials the server refused cannot be replaced: nothing is left to
 * refresh them with, and the user has to replace them. The caller decides
 * what the refusal means for what it was doing.
 */
export class ServerCredentialsCannotRefresh extends Schema.TaggedError<ServerCredentialsCannotRefresh>()(
  "ServerCredentialsCannotRefresh",
  { message: Schema.String },
) {}

/**
 * The credentials of one MCP Server, with what a check or a call does to them.
 * It is made for one server as the database held it when it was resolved.
 */
export interface ServerCredentials {
  /**
   * Goes up when the user replaces what the server signs in with. An upstream
   * session opened under an older one is replaced. A refresh that only
   * renews the same sign-in does not change it.
   */
  readonly generation: number;
  /**
   * The id of the record that holds the credentials, whose change can change
   * them: the Connection's id for a plugin server. A committed change to that
   * record makes the calls look at the sessions that were opened with them.
   */
  readonly credentialsRecordId: string;
  /**
   * Returns the credentials for a request that starts an exchange, renewing
   * them first when they have expired. A renewal runs `guard` right before it
   * calls the provider, and fails with whatever the guard fails with. Fails
   * with `ServerCredentialsUnavailable` when the server cannot give any.
   * May call the provider and write state, so it never runs inside a
   * transaction.
   */
  readonly readForUse: <GuardFailure = never>(
    guard?: RefreshGuard<GuardFailure>,
  ) => Effect.Effect<UpstreamCredentials, ServerCredentialsUnavailable | GuardFailure>;
  /**
   * Returns the credentials after the server refused the ones with identity
   * `rejectedIdentity`: the stored ones when they have changed since, and
   * otherwise new ones, which this makes. Fails with `ServerCredentialsCannotRefresh`
   * and changes nothing when there is nothing to refresh with, and with
   * `ServerCredentialsUnavailable` when the server cannot give any. `guard` is
   * as in `readForUse`.
   */
  readonly refreshAfterRejection: <GuardFailure = never>(
    rejectedIdentity: string,
    guard?: RefreshGuard<GuardFailure>,
  ) => Effect.Effect<
    UpstreamCredentials,
    ServerCredentialsUnavailable | ServerCredentialsCannotRefresh | GuardFailure
  >;
  /**
   * Returns the credentials as they are stored now and never renews them, for
   * a request that only continues an exchange that already went out or ends
   * a session. Fails with `ServerCredentialsUnavailable`.
   */
  readonly readWithoutRefresh: Effect.Effect<UpstreamCredentials, ServerCredentialsUnavailable>;
  /**
   * Returns a string that changes whenever the stored credentials change,
   * including a renewal. A caller reads it before and after it reads the
   * credentials, to notice a renewal that landed in between.
   */
  readonly readVersion: Effect.Effect<string>;
  /**
   * Returns the status and the words the server shows when it refused the
   * credentials and nothing better is known: the credentials cannot be
   * renewed, or a renewal worked and the server still refused them.
   */
  readonly describeRejected: () => {
    readonly status: "error" | "needs-sign-in";
    readonly detail: string;
  };
}

/** A server that cannot be reached now, and what it shows because of that. */
export interface UnusableAccess {
  readonly _tag: "unusable";
  readonly status: "error" | "needs-sign-in";
  readonly detail: string;
  /** What made the status, when it is the plugin or the Connection and not the server. */
  readonly cause: "plugin" | "connection" | null;
}

/** A server that can be reached: where to send, and with which credentials. */
export interface UsableAccess {
  readonly _tag: "usable";
  readonly endpoint: UpstreamEndpoint;
  readonly credentials: ServerCredentials;
}

/** How to reach one MCP Server now, or why it cannot be reached. */
export type ServerAccess = UnusableAccess | UsableAccess;

/**
 * Converts a Connection's failure to give credentials into the status an MCP
 * Server shows for it, with a detail a person can act on, and `cause`
 * `connection` when the Connection needs the user. The text is fixed here and
 * never the Connection's own message, which may hold what the provider sent.
 */
const buildUnavailableFromConnection = (
  error: ConnectionCredentialsUnavailable,
  connection: Pick<StoredConnection, "label">,
  displayName: string,
): ServerCredentialsUnavailable => {
  switch (error.reason) {
    case "needs-sign-in":
      return new ServerCredentialsUnavailable({
        status: "needs-sign-in",
        detail: `Reconnect ${connection.label} in Settings > Connections`,
        cause: "connection",
      });
    case "switched-off":
      return new ServerCredentialsUnavailable({
        status: "error",
        detail: `The Connection ${connection.label} is switched off`,
        cause: "connection",
      });
    case "unreachable":
      return new ServerCredentialsUnavailable({
        status: "unreachable",
        detail: `${displayName} could not be reached to refresh the sign-in`,
      });
    case "credentials-replaced":
      // The Connection is fine: the user reconnected twice while the sign-in
      // was refreshed. The backoff checks again soon.
      return new ServerCredentialsUnavailable({
        status: "unreachable",
        detail: `The sign-in of ${connection.label} was replaced while it was being refreshed`,
      });
    case "no-credentials":
      return new ServerCredentialsUnavailable({
        status: "error",
        detail: `The Connection ${connection.label} holds no credentials: reconnect it in Settings > Connections`,
      });
    case "invalid-config":
      return new ServerCredentialsUnavailable({
        status: "error",
        detail: `The settings of ${connection.label} no longer fit its type: check them in Settings > Connections`,
      });
    case "missing":
      return new ServerCredentialsUnavailable({
        status: "error",
        detail: "The Connection of this server is missing",
      });
  }
};

/**
 * The credentials generation of a server added by URL. Every change of such a
 * server's sign-in raises the server's `revision`, which replaces the upstream
 * sessions opened before it, so the generation never needs to move.
 */
const URL_SERVER_CREDENTIALS_GENERATION = 0;

/**
 * Returns the credentials generation a server is at now, or `undefined` when
 * a plugin server's Connection is gone. A caller compares it with the
 * `generation` an upstream session was opened with, without resolving an
 * access, because it only looks at a session and sends nothing. It returns
 * the same generation the server's access holds.
 */
export const readCredentialsGeneration = (
  view: Pick<McpServerAvailabilityView, "dependencies">,
): number | undefined =>
  view.dependencies.kind === "plugin"
    ? view.dependencies.connection?.credentialsGeneration
    : URL_SERVER_CREDENTIALS_GENERATION;

/**
 * Builds the access of a plugin server: the contribution's endpoint and the
 * Connection's credentials. Returns `unusable` when its Connection is not of
 * the type its contribution needs. That check stays here, before any send,
 * because the credentials of a Connection of another type would go to this
 * server's origin.
 */
const resolvePluginAccess = (
  { contribution, connection }: UsablePlugin,
  connectionTypes: ConnectionTypes["Service"],
): ServerAccess => {
  if (connection.type !== contribution.connectionType) {
    return {
      _tag: "unusable",
      status: "error",
      detail: `This server needs a ${contribution.connectionType} Connection, and ${connection.label} is another type`,
      cause: null,
    };
  }
  const { displayName } = contribution;
  const toUnavailable = (error: ConnectionCredentialsUnavailable) =>
    buildUnavailableFromConnection(error, connection, displayName);
  // A guard's own failure passes through unchanged.
  const mapUnavailable = <GuardFailure>(error: ConnectionCredentialsUnavailable | GuardFailure) =>
    error instanceof ConnectionCredentialsUnavailable ? toUnavailable(error) : error;
  return {
    _tag: "usable",
    endpoint: {
      origin: contribution.origin,
      displayName,
      buildRequest: ({ credentials, config }) =>
        contribution.buildUpstreamRequest({ credentials, config }),
    },
    credentials: {
      generation: connection.credentialsGeneration,
      credentialsRecordId: connection.id,
      readForUse: (guard) =>
        Effect.mapError(
          connectionTypes.readCredentialsForUse(connection.id, guard),
          mapUnavailable,
        ),
      refreshAfterRejection: (rejectedIdentity, guard) =>
        Effect.mapError(
          connectionTypes.refreshAfterRejection(connection.id, rejectedIdentity, guard),
          (error) =>
            error instanceof ConnectionCannotRefresh
              ? new ServerCredentialsCannotRefresh({ message: error.message })
              : mapUnavailable(error),
        ),
      readWithoutRefresh: Effect.mapError(
        connectionTypes.readCredentialsWithoutRefresh(connection.id),
        toUnavailable,
      ),
      readVersion: connectionTypes.readCredentialsVersion(connection.id),
      describeRejected: () => ({
        status: "error",
        detail: `${displayName}'s MCP server refused the Connection's token`,
      }),
    },
  };
};

/**
 * Builds the access of a server added by URL: requests go to its own address,
 * with its pasted token as a bearer token when it holds one. There is nothing
 * to refresh, so a token the server refuses stays refused until the user
 * replaces it, and the server then needs sign-in.
 *
 * The access is made for the `revision` the server had when it was resolved.
 * Every change of a URL server's sign-in raises the revision, so a request
 * that only continues an exchange, or ends an upstream session, never carries
 * a token that replaced the one the session was opened with
 * (`readWithoutRefresh`).
 */
const resolveUrlAccess = (
  server: StoredMcpServerAvailability,
  signIns: McpServerSignIns,
): UsableAccess => {
  const { source, name, id, revision } = server;
  if (source.kind !== "url") {
    // The dependencies of a view are read from its server's source, so a URL
    // access is only asked for a server added by URL.
    throw new Error(`MCP server ${id} has no URL to reach it at`);
  }
  const { url, signIn } = source;
  const toUpstream = (token: string | undefined): UpstreamCredentials => {
    const credentials = token === undefined ? {} : { [SIGN_IN_TOKEN_SECRET]: token };
    return {
      credentials,
      secretNames: [SIGN_IN_TOKEN_SECRET],
      config: {},
      identity: computeCredentialsIdentity(credentials),
    };
  };
  return {
    _tag: "usable",
    endpoint: {
      origin: new URL(url).origin,
      displayName: name,
      buildRequest: ({ credentials }) => {
        const token = credentials[SIGN_IN_TOKEN_SECRET];
        return { url, headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } };
      },
    },
    credentials: {
      generation: URL_SERVER_CREDENTIALS_GENERATION,
      credentialsRecordId: id,
      // The guard protects a refresh, and this access never refreshes.
      readForUse: () => Effect.map(signIns.readToken(id, signIn), toUpstream),
      refreshAfterRejection: () =>
        Effect.fail(
          new ServerCredentialsCannotRefresh({
            message: `${name} holds a sign-in that cannot be renewed`,
          }),
        ),
      readWithoutRefresh: signIns.readTokenWhileRevisionIs(id, signIn, revision).pipe(
        Effect.map(toUpstream),
        Effect.mapError(
          () =>
            new ServerCredentialsUnavailable({
              status: "error",
              detail: `The sign-in of ${name} was replaced`,
            }),
        ),
      ),
      readVersion: signIns.readVersion(id),
      describeRejected: () => ({
        status: "needs-sign-in",
        detail: `${name} ${signIn === "none" ? "asks for sign-in" : "refused its sign-in"}: ${describeSignInFix("url")}`,
      }),
    },
  };
};

/**
 * Resolves how to reach a server from the view of it. Returns `unusable`, with
 * what the server shows, when a plugin server's plugin or Connection cannot
 * serve it (`judgeDependencies`), or when its Connection is not of the type
 * its contribution needs. Otherwise returns the server's endpoint and
 * credentials: a plugin server's from its contribution and Connection, and a
 * server added by URL's from its address and its own sign-in.
 *
 * It reads nothing: the view holds what it needs, and the returned
 * credentials read the sign-in when they are asked.
 */
export const resolveServerAccess = (
  view: McpServerAvailabilityView,
  connectionTypes: ConnectionTypes["Service"],
  signIns: McpServerSignIns,
): ServerAccess => {
  const judged = judgeDependencies(view.dependencies);
  if (judged._tag === "unusable") return judged;
  return judged.kind === "plugin"
    ? resolvePluginAccess(judged, connectionTypes)
    : resolveUrlAccess(view.server, signIns);
};
