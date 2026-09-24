/**
 * Holds the connection types registered at boot, and builds the
 * `ConnectionsRuntime` each plugin uses to reach its own connections.
 *
 * This module is in the connections domain rather than in the plugin host,
 * because everything it uses is here: the connection rows, their secrets and
 * the OAuth refresh. The plugin host registers types here at boot and asks for
 * a plugin's `ConnectionsRuntime` at activation; this module never calls the
 * plugin host.
 *
 * A plugin's access is scoped by the `plugin_id` column alone: a plugin reaches
 * the connections whose `plugin_id` is its own, and cannot learn that any
 * others exist.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  ConnectionUnavailable,
  type ConnectionStatus,
  type ConnectionSummary,
  type ConnectionType,
  type ConnectionsRuntime,
  type ConnectionTypeContribution,
  type OAuthDeclaration,
} from "@hercule/plugin-host";
import { announce, nowIso, withTransaction } from "../db";
import { Secrets } from "../secrets";
import {
  isStale,
  OAUTH_TOKENS,
  oauthClients,
  parseTokens,
  refreshAccess,
  serializeTokens,
  type TokenSet,
} from "./oauth";
import { PluginConfigs } from "./plugin-configs";
import { connectionRepository, type StoredConnection } from "./repository";

/**
 * A connection type a plugin declared: the decoded catalog entry, plus the
 * `validate` function, which a catalog cannot hold because it is code.
 * `contribution.type` is the qualified `<pluginId>/<word>` name the host built,
 * and every lookup uses that name.
 */
export interface RegisteredConnectionType {
  readonly pluginId: string;
  readonly contribution: ConnectionType & Pick<ConnectionTypeContribution, "validate">;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* connectionRepository;
  const secrets = yield* Secrets;
  const findOAuthClient = yield* oauthClients;
  const declared = yield* Ref.make<ReadonlyMap<string, RegisteredConnectionType>>(new Map());

  const toConnectionSummary = (row: StoredConnection): ConnectionSummary => ({
    id: row.id,
    type: row.type,
    label: row.label,
    status: row.status,
    labels: row.labels,
    config: row.config,
  });

  const setStatus = (
    connectionId: string,
    status: ConnectionStatus,
    detail: string | null,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const at = yield* nowIso;
      yield* Effect.orDie(
        withTransaction(
          sql,
          Effect.gen(function* () {
            yield* connections.update(connectionId, { status, statusDetail: detail }, at);
            yield* announce({
              _tag: "record",
              topic: "connection",
              id: connectionId,
              kind: "updated",
            });
          }),
        ),
      );
    });

  /**
   * One semaphore per connection, so two callers that find the same expired
   * token do not both use the refresh token. Some providers invalidate a
   * refresh token once it is used, which would leave the second caller with
   * tokens that no longer work.
   *
   * The map is never pruned: it holds at most one entry per connection this
   * process has seen, and removing an entry on delete could race a refresh
   * that still holds it.
   */
  const permits = new Map<string, Semaphore.Semaphore>();

  // Synchronous on purpose: if an effect ran between the read and the write, two
  // fibers could both pass the read and each create a semaphore of its own.
  const readOrCreateRefreshPermit = (connectionId: string): Semaphore.Semaphore => {
    const held = permits.get(connectionId);
    if (held !== undefined) return held;
    const made = Semaphore.makeUnsafe(1);
    permits.set(connectionId, made);
    return made;
  };

  const runtimeFor = (pluginId: string): ConnectionsRuntime => {
    /**
     * Returns one of this plugin's connections, or fails with
     * `ConnectionUnavailable`. Another plugin's connection and an id that does
     * not exist fail the same way, so a plugin cannot learn that another
     * plugin's connection exists.
     */
    const readOwnConnectionOrFail = (
      id: string,
    ): Effect.Effect<StoredConnection, ConnectionUnavailable> =>
      Effect.flatMap(Effect.orDie(connections.one(id)), (found) =>
        Option.match(
          Option.filter(found, (row) => row.pluginId === pluginId),
          {
            onNone: () =>
              Effect.fail(
                new ConnectionUnavailable({ message: `this plugin has no connection ${id}` }),
              ),
            onSome: Effect.succeed,
          },
        ),
      );

    /**
     * Marks the connection `needs-reauth`, with `message` as the status detail,
     * and fails with a `ConnectionUnavailable` that carries the same message.
     */
    const needsReauth = (
      connectionId: string,
      message: string,
    ): Effect.Effect<never, ConnectionUnavailable> =>
      Effect.andThen(
        setStatus(connectionId, "needs-reauth", message),
        Effect.fail(new ConnectionUnavailable({ message })),
      );

    /** Returns the OAuth declaration of the connection's type, or `undefined` when it has none. */
    const readDeclaredOAuth = (
      row: StoredConnection,
    ): Effect.Effect<OAuthDeclaration | undefined> =>
      Effect.map(Ref.get(declared), (all) => all.get(row.type)?.contribution.oauth);

    /**
     * Returns the credentials the user pasted, read from the connection's
     * secrets in one query. Fails with `ConnectionUnavailable` when the
     * connection has no secrets.
     */
    const readPastedCredentials = (
      connectionId: string,
    ): Effect.Effect<Record<string, string>, ConnectionUnavailable> =>
      Effect.flatMap(
        Effect.orDie(secrets.values({ kind: "connection", id: connectionId })),
        (stored) =>
          stored.length === 0
            ? Effect.fail(
                new ConnectionUnavailable({
                  message: `the connection ${connectionId} holds no credentials`,
                }),
              )
            : Effect.succeed(
                Object.fromEntries(stored.map((one) => [one.name, Redacted.value(one.value)])),
              ),
      );

    /** Returns the stored token set, or marks the connection `needs-reauth` and fails. */
    const readStoredTokens = (
      connectionId: string,
    ): Effect.Effect<TokenSet, ConnectionUnavailable> =>
      Effect.flatMap(
        Effect.orDie(secrets.get({ kind: "connection", id: connectionId }, OAUTH_TOKENS)),
        Option.match({
          onNone: () => needsReauth(connectionId, "this connection holds no tokens"),
          onSome: (stored) => Effect.succeed(parseTokens(Redacted.value(stored))),
        }),
      );

    /**
     * Exchanges the refresh token for a new token set, stores it and returns
     * it. It runs while holding this connection's semaphore and reads the stored
     * tokens again first, so a caller that waited for another caller's refresh
     * gets the new tokens without refreshing again.
     *
     * - With no refresh token or no OAuth client, it marks the connection
     *   `needs-reauth` and fails.
     * - When the token endpoint rejects the refresh, it marks the connection
     *   `needs-reauth` and fails.
     * - When the token endpoint cannot be reached, it fails and leaves the
     *   status unchanged.
     */
    const refreshTokens = (
      connectionId: string,
      oauth: OAuthDeclaration,
    ): Effect.Effect<TokenSet, ConnectionUnavailable> =>
      Effect.gen(function* () {
        const tokens = yield* readStoredTokens(connectionId);
        const millis = yield* Clock.currentTimeMillis;
        if (!isStale(tokens, millis)) return tokens;

        const client = yield* Effect.orDie(findOAuthClient(pluginId));
        if (tokens.refreshToken === undefined || Option.isNone(client)) {
          return yield* needsReauth(connectionId, "this connection cannot be refreshed");
        }
        const answer = yield* refreshAccess({
          tokenUrl: oauth.tokenUrl,
          client: client.value,
          refreshToken: tokens.refreshToken,
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.catchTag("TokenRefused", (error) => needsReauth(connectionId, error.message)),
          Effect.catchTag("TokenUnreachable", (error) =>
            Effect.fail(new ConnectionUnavailable({ message: error.message })),
          ),
        );
        // When the response has no refresh token, the old one is still valid.
        const keep = answer.refreshToken ?? tokens.refreshToken;
        const next: TokenSet = { ...answer, refreshToken: keep };
        yield* Effect.orDie(
          secrets.set(
            { kind: "connection", id: connectionId },
            OAUTH_TOKENS,
            Redacted.make(serializeTokens(next)),
          ),
        );
        return next;
      });

    /**
     * Returns the access token of an OAuth connection, refreshing it first when
     * it has expired or is about to. The core does the refresh, so a plugin that
     * asks for credentials gets a working token or a `ConnectionUnavailable`.
     */
    const readFreshAccessToken = (
      connectionId: string,
      oauth: OAuthDeclaration,
    ): Effect.Effect<Record<string, string>, ConnectionUnavailable> =>
      Effect.gen(function* () {
        const tokens = yield* readStoredTokens(connectionId);
        const millis = yield* Clock.currentTimeMillis;
        if (!isStale(tokens, millis)) return { accessToken: tokens.accessToken };
        const fresh = yield* readOrCreateRefreshPermit(connectionId).withPermits(1)(
          refreshTokens(connectionId, oauth),
        );
        return { accessToken: fresh.accessToken };
      });

    return {
      list: () =>
        Effect.map(Effect.orDie(connections.ofPlugin(pluginId)), (rows) =>
          rows.map(toConnectionSummary),
        ),

      credentials: (connectionId) =>
        Effect.gen(function* () {
          const row = yield* readOwnConnectionOrFail(connectionId);
          const oauth = yield* readDeclaredOAuth(row);
          return oauth === undefined
            ? yield* readPastedCredentials(connectionId)
            : yield* readFreshAccessToken(connectionId, oauth);
        }),

      report: (connectionId, report) =>
        Effect.andThen(
          readOwnConnectionOrFail(connectionId),
          setStatus(connectionId, report.status, report.detail ?? null),
        ),
    };
  };

  return {
    /** Replaces the registered connection types with the ones this boot declared. */
    replace: (types: ReadonlyArray<RegisteredConnectionType>): Effect.Effect<void> =>
      Ref.set(declared, new Map(types.map((one) => [one.contribution.type, one]))),

    /** Returns the connection type with this qualified name, if this boot registered one. */
    named: (type: string): Effect.Effect<Option.Option<RegisteredConnectionType>> =>
      Effect.map(Ref.get(declared), (all) => Option.fromUndefinedOr(all.get(type))),

    /** Returns every connection type this boot registered, in registration order. */
    list: (): Effect.Effect<ReadonlyArray<RegisteredConnectionType>> =>
      Effect.map(Ref.get(declared), (all) => [...all.values()]),

    runtimeFor,
  };
});

/** The connection types this boot registered, and the `ConnectionsRuntime` each plugin uses. */
export class ConnectionTypes extends Context.Service<
  ConnectionTypes,
  Effect.Success<typeof make>
>()("hercule/controller/connections/ConnectionTypes") {}

export const ConnectionTypesLayer: Layer.Layer<
  ConnectionTypes,
  never,
  SqlClient.SqlClient | Secrets | PluginConfigs
> = Layer.effect(ConnectionTypes)(make);
