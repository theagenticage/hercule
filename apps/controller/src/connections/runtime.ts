/**
 * The connection types a boot registered, and the runtime surface each plugin
 * reaches its own connections through.
 *
 * It lives in the connections domain rather than in the plugin host because
 * everything it touches is here: the rows, the secrets they own, the OAuth
 * refresh. The host declares types into this store at boot and asks it for a
 * plugin's surface at activation; nothing points the other way.
 *
 * Scope is the `plugin_id` column and nothing else: the column says whose row a
 * connection is, so a plugin reaches its own and learns of no others.
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
 * One type a plugin declared: the decoded catalog half, and the `validate` no
 * catalog can hold. `contribution.type` is the qualified `<pluginId>/<word>`
 * the host minted, which is what everything else keys on.
 */
export interface RegisteredConnectionType {
  readonly pluginId: string;
  readonly contribution: ConnectionType & Pick<ConnectionTypeContribution, "validate">;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* connectionRepository;
  const secrets = yield* Secrets;
  const clientOf = yield* oauthClients;
  const declared = yield* Ref.make<ReadonlyMap<string, RegisteredConnectionType>>(new Map());

  const summary = (row: StoredConnection): ConnectionSummary => ({
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
   * One permit per connection, so two callers finding the same spent token do
   * not both spend a refresh token on it - some providers invalidate the old
   * one, which would leave the second caller holding a set that no longer works.
   *
   * Never pruned: the map is bounded by the connections this process ever saw,
   * and dropping an entry on delete would race a refresh still holding it.
   */
  const permits = new Map<string, Semaphore.Semaphore>();

  // Made synchronously: an effect between the read and the write is a point two
  // fibers can both pass, and they would each end up holding a permit of their own.
  const refreshPermit = (connectionId: string): Semaphore.Semaphore => {
    const held = permits.get(connectionId);
    if (held !== undefined) return held;
    const made = Semaphore.makeUnsafe(1);
    permits.set(connectionId, made);
    return made;
  };

  const runtimeFor = (pluginId: string): ConnectionsRuntime => {
    /**
     * One connection of this plugin's, or nothing it may know about: another
     * plugin's row and an id nobody created are the same answer, because a
     * plugin may not learn that the first exists.
     */
    const own = (id: string): Effect.Effect<StoredConnection, ConnectionUnavailable> =>
      Effect.flatMap(Effect.orDie(connections.one(id)), (found) =>
        Option.match(
          Option.filter(found, (row) => row.pluginId === pluginId),
          {
            onNone: () =>
              Effect.fail(
                new ConnectionUnavailable({ message: `no connection ${id} of this plugin's` }),
              ),
            onSome: Effect.succeed,
          },
        ),
      );

    /** A connection the core cannot act through until the user has been back. */
    const needsReauth = (
      connectionId: string,
      message: string,
    ): Effect.Effect<never, ConnectionUnavailable> =>
      Effect.andThen(
        setStatus(connectionId, "needs-reauth", message),
        Effect.fail(new ConnectionUnavailable({ message })),
      );

    /** What was declared for the type this row is, if it is a redirect flow. */
    const declaredOAuth = (row: StoredConnection): Effect.Effect<OAuthDeclaration | undefined> =>
      Effect.map(Ref.get(declared), (all) => all.get(row.type)?.contribution.oauth);

    /**
     * What the user pasted, in one read of the connection's own secrets. A
     * connection holding none cannot be acted through, which is the same answer
     * as one whose credentials no longer work.
     */
    const pastedCredentials = (
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

    /** The token set a connection holds, or nothing it can be acted through with. */
    const storedTokens = (connectionId: string): Effect.Effect<TokenSet, ConnectionUnavailable> =>
      Effect.flatMap(
        Effect.orDie(secrets.get({ kind: "connection", id: connectionId }, OAUTH_TOKENS)),
        Option.match({
          onNone: () => needsReauth(connectionId, "this connection holds no tokens"),
          onSome: (stored) => Effect.succeed(parseTokens(Redacted.value(stored))),
        }),
      );

    /**
     * Trades the refresh token in for a fresh set and writes it down. Runs under
     * this connection's permit, so the stored set is read again first: a caller
     * that waited for another's refresh spends nothing of its own.
     *
     * A provider that answered and said no is a credential to reauthorise; one
     * that could not be reached is weather, and the status stays as it was.
     */
    const refreshed = (
      connectionId: string,
      oauth: OAuthDeclaration,
    ): Effect.Effect<TokenSet, ConnectionUnavailable> =>
      Effect.gen(function* () {
        const tokens = yield* storedTokens(connectionId);
        const millis = yield* Clock.currentTimeMillis;
        if (!isStale(tokens, millis)) return tokens;

        const client = yield* Effect.orDie(clientOf(pluginId));
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
        // A provider that hands back no refresh token means the old one stands.
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
     * The access token of a redirect-flow connection, refreshed first when it is
     * spent or nearly so. The refresh is the core's: a plugin asks for
     * credentials and is handed a token that works, or told it cannot act.
     */
    const accessToken = (
      connectionId: string,
      oauth: OAuthDeclaration,
    ): Effect.Effect<Record<string, string>, ConnectionUnavailable> =>
      Effect.gen(function* () {
        const tokens = yield* storedTokens(connectionId);
        const millis = yield* Clock.currentTimeMillis;
        if (!isStale(tokens, millis)) return { accessToken: tokens.accessToken };
        const fresh = yield* refreshPermit(connectionId).withPermits(1)(
          refreshed(connectionId, oauth),
        );
        return { accessToken: fresh.accessToken };
      });

    return {
      list: () =>
        Effect.map(Effect.orDie(connections.ofPlugin(pluginId)), (rows) => rows.map(summary)),

      credentials: (connectionId) =>
        Effect.gen(function* () {
          const row = yield* own(connectionId);
          const oauth = yield* declaredOAuth(row);
          return oauth === undefined
            ? yield* pastedCredentials(connectionId)
            : yield* accessToken(connectionId, oauth);
        }),

      report: (connectionId, report) =>
        Effect.andThen(
          own(connectionId),
          setStatus(connectionId, report.status, report.detail ?? null),
        ),
    };
  };

  return {
    /** What this boot registered, replacing what the last one did. */
    replace: (types: ReadonlyArray<RegisteredConnectionType>): Effect.Effect<void> =>
      Ref.set(declared, new Map(types.map((one) => [one.contribution.type, one]))),

    /** The type of this qualified name, if this boot registered one. */
    named: (type: string): Effect.Effect<Option.Option<RegisteredConnectionType>> =>
      Effect.map(Ref.get(declared), (all) => Option.fromUndefinedOr(all.get(type))),

    runtimeFor,
  };
});

/** The connection types this boot registered, and what a plugin does with them. */
export class ConnectionTypes extends Context.Service<
  ConnectionTypes,
  Effect.Success<typeof make>
>()("hydra/controller/connections/ConnectionTypes") {}

export const ConnectionTypesLayer: Layer.Layer<
  ConnectionTypes,
  never,
  SqlClient.SqlClient | Secrets | PluginConfigs
> = Layer.effect(ConnectionTypes)(make);
