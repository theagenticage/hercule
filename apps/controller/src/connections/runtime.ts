/**
 * The connection types a boot registered, and the runtime surface each plugin
 * reaches its own connections through.
 *
 * It lives in the connections domain rather than in the plugin host because
 * everything it touches is here: the rows, the secrets they own, the OAuth
 * refresh. The host declares types into this store at boot and asks it for a
 * plugin's surface at activation; nothing points the other way.
 *
 * Scope is the `plugin_id` column and nothing else. A type name is a plugin's
 * claim, and two builds could claim the same word; the column says whose row it
 * is, so a plugin reaches its own connections and learns of no others.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
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
} from "@hydra/plugin-host";
import { announce, nowIso, withTransaction } from "../db";
import { Secrets, type SecretOwner } from "../secrets";
import {
  isStale,
  OAUTH_TOKENS,
  oauthClients,
  parseTokens,
  refreshAccess,
  serializeTokens,
  type TokenSet,
} from "./oauth";
import { connectionRepository, type StoredConnection } from "./repository";

/**
 * One type a plugin declared: the decoded catalog half, and the `validate` no
 * catalog can hold.
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
  const declared = yield* Ref.make<ReadonlyArray<RegisteredConnectionType>>([]);

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

    /** What this plugin declared for the type this row is, if it is a redirect flow. */
    const declaredOAuth = (row: StoredConnection): Effect.Effect<OAuthDeclaration | undefined> =>
      Effect.map(
        Ref.get(declared),
        (all) =>
          all.find((one) => one.pluginId === pluginId && one.contribution.type === row.type)
            ?.contribution.oauth,
      );

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
        const owner: SecretOwner = { kind: "connection", id: connectionId };
        const stored = yield* Effect.orDie(secrets.get(owner, OAUTH_TOKENS));
        if (Option.isNone(stored)) {
          return yield* needsReauth(connectionId, "this connection holds no tokens");
        }
        const tokens = parseTokens(Redacted.value(stored.value));
        const millis = yield* Clock.currentTimeMillis;
        if (!isStale(tokens, millis)) return { accessToken: tokens.accessToken };

        const client = yield* Effect.orDie(clientOf(pluginId));
        if (tokens.refreshToken === undefined || Option.isNone(client)) {
          return yield* needsReauth(connectionId, "this connection cannot be refreshed");
        }
        const refreshed = yield* refreshAccess({
          tokenUrl: oauth.tokenUrl,
          client: client.value,
          refreshToken: tokens.refreshToken,
        }).pipe(
          Effect.provide(FetchHttpClient.layer),
          Effect.catchTag("TokenRequestFailed", (error) =>
            needsReauth(connectionId, error.message),
          ),
        );
        // A provider that hands back no refresh token means the old one stands.
        const keep = refreshed.refreshToken ?? tokens.refreshToken;
        const next: TokenSet = { ...refreshed, refreshToken: keep };
        yield* Effect.orDie(secrets.set(owner, OAUTH_TOKENS, Redacted.make(serializeTokens(next))));
        return { accessToken: next.accessToken };
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
      Ref.set(declared, types),

    /** Every type this boot registered, with the plugin that owns it. */
    all: (): Effect.Effect<ReadonlyArray<RegisteredConnectionType>> => Ref.get(declared),

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
  SqlClient.SqlClient | Secrets
> = Layer.effect(ConnectionTypes)(make);
