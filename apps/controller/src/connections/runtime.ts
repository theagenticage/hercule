/**
 * Holds the connection types registered at boot, and builds the
 * `ConnectionsRuntime` each plugin uses to reach its own connections.
 *
 * This module is in the connections domain rather than in the plugin host,
 * because everything it uses is here: the connection rows, their secrets and
 * the OAuth refresh. The plugin host registers types here at boot
 * and asks for a plugin's `ConnectionsRuntime` at activation; this module
 * never calls the plugin host.
 *
 * A plugin's access is scoped by the `plugin_id` column alone: a plugin reaches
 * the connections whose `plugin_id` is its own, and cannot learn that any
 * others exist.
 *
 * Every write here passes the promotion gate (`PromotionState`) itself. A
 * plugin calls this runtime from its own work, such as an ingest poll or a
 * workflow action, and the gate does not always count that work already.
 * While a promotion freezes the controller, the database refuses writes, so
 * a write waits until the freeze ends. Once the controller is sealed, it
 * never happens.
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
  type FeedDeclaration,
  type OAuthDeclaration,
} from "@hercule/plugin-host";
import { announce, nowIso, withTransaction } from "../db";
import { PromotionState } from "../promotion";
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
 * A connection type a plugin declared.
 *
 * - `contribution` is the decoded catalog entry, plus the `validate`
 *   function, which a catalog cannot hold because it is code.
 *   `contribution.type` is the qualified `<pluginId>/<word>` name the host
 *   built, and every lookup uses that name.
 * - `feeds` are the feeds the type's event source declared, keyed by feed
 *   name, and `{}` for a type no event source ingests for. A type has at
 *   most one event source: the plugin host refuses a second one.
 */
export interface RegisteredConnectionType {
  readonly pluginId: string;
  readonly contribution: ConnectionType & Pick<ConnectionTypeContribution, "validate">;
  readonly feeds: Readonly<Record<string, FeedDeclaration>>;
}

/**
 * The message a caller gets when the user reconnected while a refresh was in
 * flight. The connection's new credentials are fine, so asking again works.
 */
const CREDENTIALS_REPLACED =
  "the connection's credentials were replaced while its access token was being refreshed: ask for them again";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* connectionRepository;
  const secrets = yield* Secrets;
  const findOAuthClient = yield* oauthClients;
  const promotion = yield* PromotionState;
  const declared = yield* Ref.make<ReadonlyMap<string, RegisteredConnectionType>>(new Map());

  const toConnectionSummary = (row: StoredConnection): ConnectionSummary => ({
    id: row.id,
    type: row.type,
    label: row.label,
    status: row.status,
    labels: row.labels,
    config: row.config,
  });

  /**
   * Sets the connection's status and detail, unless the user disabled it.
   * Only the user enables a connection again, so a plugin's report or a
   * failed refresh that lands after the user disabled it changes nothing.
   */
  const setStatus = (
    connectionId: string,
    status: ConnectionStatus,
    detail: string | null,
  ): Effect.Effect<void> =>
    promotion.whenServing(
      Effect.gen(function* () {
        const at = yield* nowIso;
        yield* Effect.orDie(
          withTransaction(
            sql,
            Effect.gen(function* () {
              const changed = yield* connections.changeStatusFrom(
                connectionId,
                ["connected", "error", "needs-reauth"],
                status,
                detail,
                at,
              );
              if (!changed) return;
              yield* announce({
                _tag: "record",
                topic: "connection",
                id: connectionId,
                kind: "updated",
              });
            }),
          ),
        );
      }),
    );

  /**
   * Marks the connection `needs-reauth`, with `message` as the status detail,
   * and fails with a `ConnectionUnavailable` that carries the same message.
   */
  const markNeedsReauth = (
    connectionId: string,
    message: string,
  ): Effect.Effect<never, ConnectionUnavailable> =>
    Effect.andThen(
      setStatus(connectionId, "needs-reauth", message),
      Effect.fail(new ConnectionUnavailable({ message })),
    );

  /**
   * Returns the registered type of the connection, or `undefined` when no
   * plugin in this build declares it.
   */
  const findRegisteredType = (
    row: StoredConnection,
  ): Effect.Effect<RegisteredConnectionType | undefined> =>
    Effect.map(Ref.get(declared), (all) => all.get(row.type));

  /**
   * Runs `write` in one transaction, but only while the connection still
   * holds `held` as its token set. Fails with `ConnectionUnavailable` when it
   * holds something else, and then `write` does not run.
   *
   * A refresh calls the provider outside any transaction, so the user can
   * reconnect while the call is in flight. The reconnect replaces the token
   * set, or swaps it for pasted credentials. Whatever the refresh learned is
   * about credentials the connection no longer holds: storing its tokens
   * would put the old account back beside the new credentials, and marking
   * the connection `needs-reauth` would flag credentials that work.
   */
  const writeWhileTokensHeld = (
    connectionId: string,
    held: string,
    write: Effect.Effect<void>,
  ): Effect.Effect<void, ConnectionUnavailable> =>
    Effect.gen(function* () {
      const written = yield* promotion.whenServing(
        Effect.orDie(
          withTransaction(
            sql,
            Effect.gen(function* () {
              const current = yield* secrets.get(
                { kind: "connection", id: connectionId },
                OAUTH_TOKENS,
              );
              if (Option.isNone(current) || Redacted.value(current.value) !== held) return false;
              yield* write;
              return true;
            }),
          ),
        ),
      );
      if (!written) {
        return yield* Effect.fail(new ConnectionUnavailable({ message: CREDENTIALS_REPLACED }));
      }
    });

  /**
   * Marks the connection `needs-reauth` because of the token set `held`, and
   * fails with a `ConnectionUnavailable` that carries `message`. The status
   * is left alone when the connection no longer holds `held`, as
   * `writeWhileTokensHeld` explains.
   */
  const markTokensNeedReauth = (
    connectionId: string,
    held: string,
    message: string,
  ): Effect.Effect<never, ConnectionUnavailable> =>
    Effect.andThen(
      writeWhileTokensHeld(connectionId, held, setStatus(connectionId, "needs-reauth", message)),
      Effect.fail(new ConnectionUnavailable({ message })),
    );

  /** Parses the token set `held`, or marks the connection `needs-reauth` and fails. */
  const parseStoredTokens = (
    connectionId: string,
    held: string,
  ): Effect.Effect<TokenSet, ConnectionUnavailable> =>
    parseTokens(held).pipe(
      // New tokens replace the unreadable ones when the user reconnects.
      Effect.catchTag("StoredTokensUnreadable", (error) =>
        markTokensNeedReauth(connectionId, held, error.message),
      ),
    );

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
   * - When the user reconnected meanwhile, it fails and changes nothing, as
   *   `writeWhileTokensHeld` explains.
   */
  const refreshTokens = (
    row: StoredConnection,
    oauth: OAuthDeclaration,
  ): Effect.Effect<TokenSet, ConnectionUnavailable> =>
    Effect.gen(function* () {
      const stored = yield* Effect.orDie(
        secrets.get({ kind: "connection", id: row.id }, OAUTH_TOKENS),
      );
      // The caller found a token set before it waited for the semaphore, so
      // finding none now means a reconnect swapped it for pasted credentials.
      if (Option.isNone(stored)) {
        return yield* Effect.fail(new ConnectionUnavailable({ message: CREDENTIALS_REPLACED }));
      }
      const held = Redacted.value(stored.value);
      const tokens = yield* parseStoredTokens(row.id, held);
      const millis = yield* Clock.currentTimeMillis;
      if (!isStale(tokens, millis)) return tokens;

      const client = yield* Effect.orDie(findOAuthClient(row.pluginId));
      if (tokens.refreshToken === undefined || Option.isNone(client)) {
        return yield* markTokensNeedReauth(row.id, held, "this connection cannot be refreshed");
      }
      const answer = yield* refreshAccess({
        tokenUrl: oauth.tokenUrl,
        client: client.value,
        refreshToken: tokens.refreshToken,
      }).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.catchTag("ProviderRefused", (error) =>
          markTokensNeedReauth(row.id, held, error.message),
        ),
        Effect.catchTag("ProviderUnreachable", (error) =>
          Effect.fail(new ConnectionUnavailable({ message: error.message })),
        ),
      );
      // When the response has no refresh token, the old one is still valid.
      const keep = answer.refreshToken ?? tokens.refreshToken;
      const next: TokenSet = { ...answer, refreshToken: keep };
      yield* writeWhileTokensHeld(
        row.id,
        held,
        Effect.orDie(
          secrets.set(
            { kind: "connection", id: row.id },
            OAUTH_TOKENS,
            Redacted.make(serializeTokens(next)),
          ),
        ),
      );
      return next;
    });

  /**
   * Returns the access token of a token connection, refreshing it first when
   * it has expired or is about to. The core does the refresh, so a caller that
   * asks for credentials gets a working token or a `ConnectionUnavailable`.
   *
   * Only a type with an `oauth` declaration can refresh. A token from a device
   * flow has no expiry, so it never needs a refresh; if a provider ever sends
   * one with an expiry anyway, the connection needs reauth once it lapses.
   *
   * A refresh passes the promotion gate as one unit, before the provider is
   * called: it waits while a promotion freezes the controller, and never
   * happens once it is sealed. The provider's answer and the write that
   * stores it cannot be split. Many providers rotate the refresh token and
   * invalidate the old one, so a refresh whose new tokens are not in the
   * copy would leave the new machine holding a refresh token that no longer
   * works.
   */
  const readFreshAccessToken = (
    row: StoredConnection,
    stored: Redacted.Redacted<string>,
  ): Effect.Effect<Record<string, string>, ConnectionUnavailable> =>
    Effect.gen(function* () {
      const held = Redacted.value(stored);
      const tokens = yield* parseStoredTokens(row.id, held);
      const millis = yield* Clock.currentTimeMillis;
      if (!isStale(tokens, millis)) return { accessToken: tokens.accessToken };
      const oauth = (yield* findRegisteredType(row))?.contribution.oauth;
      if (oauth === undefined) {
        return yield* markTokensNeedReauth(
          row.id,
          held,
          "this connection's access token has expired",
        );
      }
      // The gate is passed before the permit is taken, so no caller holds
      // the permit while it waits for a freeze to end.
      const fresh = yield* promotion.whenServing(
        readOrCreateRefreshPermit(row.id).withPermits(1)(refreshTokens(row, oauth)),
      );
      return { accessToken: fresh.accessToken };
    });

  /**
   * Returns a connection's credentials, decrypted, from one read of its
   * secrets. Which kind depends on what the connection holds, not on its
   * type, because a type may offer both pasted credentials and a token flow:
   *
   * - a connection that holds `oauth.tokens` was set up through a redirect
   *   flow or a device flow, and returns `{ accessToken }`;
   * - any other connection returns the fields the user pasted, keyed by name.
   *
   * Fails with `ConnectionUnavailable` when the connection holds no secrets,
   * or when its token cannot be used, as `readFreshAccessToken` explains. A
   * connection with no secrets whose type signs in through a redirect flow or
   * a device flow is also marked `needs-reauth`: signing in again is how the
   * user gives it a token.
   */
  const readStoredCredentials = (
    row: StoredConnection,
  ): Effect.Effect<Record<string, string>, ConnectionUnavailable> =>
    Effect.gen(function* () {
      const stored = yield* Effect.orDie(secrets.values({ kind: "connection", id: row.id }));
      const tokens = stored.find((one) => one.name === OAUTH_TOKENS);
      if (tokens !== undefined) return yield* readFreshAccessToken(row, tokens.value);
      if (stored.length === 0) {
        const message = `the connection ${row.id} holds no credentials`;
        const type = (yield* findRegisteredType(row))?.contribution;
        if (type?.oauth !== undefined || type?.device !== undefined) {
          return yield* markNeedsReauth(row.id, message);
        }
        return yield* Effect.fail(new ConnectionUnavailable({ message }));
      }
      return Object.fromEntries(stored.map((one) => [one.name, Redacted.value(one.value)]));
    });

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

    return {
      list: () =>
        Effect.map(Effect.orDie(connections.ofPlugin(pluginId)), (rows) =>
          rows.map(toConnectionSummary),
        ),

      credentials: (connectionId) =>
        Effect.flatMap(readOwnConnectionOrFail(connectionId), readStoredCredentials),

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

    /**
     * Returns a string that changes whenever the connection's credentials
     * change: the name and rotation time of each secret it holds, without
     * decrypting any. A reconnect either rotates a secret of the same name or
     * swaps the names, so the string differs after one. An OAuth refresh
     * rotates the token set, so it changes the string too.
     */
    readCredentialsVersion: (connectionId: string): Effect.Effect<string> =>
      Effect.map(Effect.orDie(secrets.refs("connection", [connectionId])), (all) =>
        JSON.stringify(all.get(connectionId) ?? []),
      ),
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
  SqlClient.SqlClient | Secrets | PluginConfigs | PromotionState
> = Layer.effect(ConnectionTypes)(make);
