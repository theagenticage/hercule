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
import { createHash } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import {
  ConnectionUnavailable,
  decodeAgainst,
  type ConnectionStatus,
  type ConnectionSummary,
  type ConnectionType,
  type ConnectionsRuntime,
  type ConnectionTypeContribution,
  type FeedDeclaration,
} from "@hercule/plugin-host";
import { announce, nowIso, withTransaction } from "../db";
import { Notifier } from "../notifications";
import { PromotionState } from "../promotion";
import { Secrets } from "../secrets";
import {
  isStale,
  OAUTH_TOKENS,
  oauthClients,
  parseTokens,
  refreshAccess,
  type ProviderUnreachable,
  serializeTokens,
  type OAuthClient,
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
  readonly contribution: ConnectionType &
    Pick<ConnectionTypeContribution, "validate" | "listChoices">;
  readonly feeds: Readonly<Record<string, FeedDeclaration>>;
}

/**
 * The message a caller gets when the user reconnected while a refresh was in
 * flight. The connection's new credentials are fine, so asking again works.
 */
const CREDENTIALS_REPLACED =
  "the connection's credentials were replaced while its access token was being refreshed: ask for them again";

/** The status detail of a Connection whose provider refused to refresh its access token. */
const REFRESH_REFUSED = "the provider refused to refresh the connection's access token";

/** The body of the Notification that a Connection needs signing in again. */
const NEEDS_SIGN_IN_BODY =
  "The provider no longer accepts this Connection's sign-in. Reconnect it on the Connections " +
  "screen. What uses it stays unavailable until you do.";

/**
 * What the core needs to call an outside server with a Connection's
 * credential.
 *
 * - `credentials` are what `ConnectionsRuntime.credentials` gives a plugin:
 *   the fields the user pasted, or `{ accessToken }` for OAuth tokens.
 * - `config` is the Connection's config decoded against its type's config
 *   schema (`{}` for a type with none).
 * - `identity` is a fingerprint of the credential values, which never
 *   reveals them. It changes when the credentials change, and a caller hands
 *   it back to `refreshAfterRejection` to say which credentials the outside
 *   server refused.
 */
export interface ConnectionCredentialsForUse {
  readonly credentials: Record<string, string>;
  readonly config: unknown;
  readonly identity: string;
}

/**
 * The core cannot give a Connection's credentials for use right now.
 * `reason` is one of:
 *
 * - `needs-sign-in`: the Connection needs the user to sign in again. It is
 *   `needs-reauth`, or the provider refused to refresh its token.
 * - `unreachable`: the provider could not be reached to refresh the token.
 *   The Connection is left as it was, so trying again later may work.
 * - `switched-off`: the user disabled the Connection.
 * - `missing`: there is no such Connection, or no plugin in this build
 *   declares its type.
 * - `invalid-config`: the Connection's config no longer fits its type's
 *   config schema, because the type changed since the config was written.
 *
 * `message` is one line a person can read.
 */
export class ConnectionCredentialsUnavailable extends Schema.TaggedError<ConnectionCredentialsUnavailable>()(
  "ConnectionCredentialsUnavailable",
  {
    reason: Schema.Literals([
      "needs-sign-in",
      "unreachable",
      "switched-off",
      "missing",
      "invalid-config",
    ]),
    message: Schema.String,
  },
) {}

/**
 * A Connection that holds pasted credentials and no OAuth tokens has nothing
 * to refresh: a rejected pasted credential stays rejected until the user
 * replaces it.
 */
export class ConnectionCannotRefresh extends Schema.TaggedError<ConnectionCannotRefresh>()(
  "ConnectionCannotRefresh",
  { message: Schema.String },
) {}

/**
 * Computes the fingerprint of a set of credentials: the SHA-256 of their
 * names and values as JSON, in name order, as hex. The order the fields were
 * stored in does not change it.
 */
const computeCredentialsIdentity = (credentials: Record<string, string>): string =>
  createHash("sha256")
    .update(
      JSON.stringify(Object.entries(credentials).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    )
    .digest("hex");

/**
 * Runs `effect` again, once, when it failed because the user reconnected
 * while a token refresh was in flight. The second run reads the new
 * credentials, which are fine.
 */
const retryWhenCredentialsReplaced = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(effect, {
    times: 1,
    while: (error) =>
      error instanceof ConnectionUnavailable && error.message === CREDENTIALS_REPLACED,
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* connectionRepository;
  const secrets = yield* Secrets;
  const findOAuthClient = yield* oauthClients;
  const promotion = yield* PromotionState;
  const notifier = yield* Notifier;
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
   * Returns the registered type of the connection, or `undefined` when no
   * plugin in this build declares it.
   */
  const findRegisteredType = (
    row: StoredConnection,
  ): Effect.Effect<RegisteredConnectionType | undefined> =>
    Effect.map(Ref.get(declared), (all) => all.get(row.type));

  /**
   * Sets the connection's status and detail, unless the user disabled it.
   * Only the user enables a connection again, so a plugin's report or a
   * failed refresh that lands after the user disabled it changes nothing.
   *
   * When the status moves to `needs-reauth` from another status and
   * `raisesNotification` is set, the connection's Notification is raised in
   * the same transaction. A write that finds the connection `needs-reauth`
   * already raises none, so one transition raises one Notification.
   */
  const changeStatus = (
    connectionId: string,
    status: ConnectionStatus,
    detail: string | null,
    raisesNotification: boolean,
  ): Effect.Effect<void> =>
    promotion.whenServing(
      Effect.gen(function* () {
        const at = yield* nowIso;
        yield* Effect.orDie(
          withTransaction(
            sql,
            Effect.gen(function* () {
              const before = Option.getOrUndefined(yield* connections.one(connectionId));
              const changed = yield* connections.changeStatusFrom(
                connectionId,
                ["connected", "error", "needs-reauth"],
                status,
                detail,
                at,
              );
              if (!changed || before === undefined) return;
              yield* announce({
                _tag: "record",
                topic: "connection",
                id: connectionId,
                kind: "updated",
              });
              if (raisesNotification && before.status !== status) {
                const type = (yield* findRegisteredType(before))?.contribution;
                yield* notifier.createCoreNotification({
                  kind: "core.connection-error",
                  title: `${type?.displayName ?? before.type} connection '${before.label}' needs signing in again`,
                  body: NEEDS_SIGN_IN_BODY,
                  subject: [{ kind: "connection", id: connectionId }],
                });
              }
            }),
          ),
        );
      }),
    );

  const setStatus = (
    connectionId: string,
    status: ConnectionStatus,
    detail: string | null,
  ): Effect.Effect<void> => changeStatus(connectionId, status, detail, false);

  /**
   * Marks the connection `needs-reauth` and raises its Notification, with
   * `message` as the status detail.
   */
  const setNeedsReauth = (connectionId: string, message: string): Effect.Effect<void> =>
    changeStatus(connectionId, "needs-reauth", message, true);

  /**
   * Marks the connection `needs-reauth`, with `message` as the status detail,
   * and fails with a `ConnectionUnavailable` that carries the same message.
   */
  const markNeedsReauth = (
    connectionId: string,
    message: string,
  ): Effect.Effect<never, ConnectionUnavailable> =>
    Effect.andThen(
      setNeedsReauth(connectionId, message),
      Effect.fail(new ConnectionUnavailable({ message })),
    );

  /**
   * Runs `write` in one transaction, but only while the connection still
   * holds `held` as its token set and is still at `generation` of its
   * credentials. Fails with `ConnectionUnavailable` when either changed, and
   * then `write` does not run.
   *
   * A refresh calls the provider outside any transaction, so the user can
   * reconnect while the call is in flight. The reconnect replaces the token
   * set, or swaps it for pasted credentials. Whatever the refresh learned is
   * about credentials the connection no longer holds: storing its tokens
   * would put the old account back beside the new credentials, and marking
   * the connection `needs-reauth` would flag credentials that work. The
   * generation catches a reconnect that stores a token set identical to
   * `held`, which the comparison of the token sets cannot tell apart.
   */
  const writeWhileTokensHeld = (
    connectionId: string,
    held: string,
    generation: number,
    write: Effect.Effect<void>,
  ): Effect.Effect<void, ConnectionUnavailable> =>
    Effect.gen(function* () {
      const written = yield* promotion.whenServing(
        Effect.orDie(
          withTransaction(
            sql,
            Effect.gen(function* () {
              const row = yield* connections.one(connectionId);
              if (Option.isNone(row) || row.value.credentialsGeneration !== generation) {
                return false;
              }
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
   * Marks the connection `needs-reauth` because of the token set `held` at
   * `generation`, and fails with a `ConnectionUnavailable` that carries
   * `message`. The status is left alone when the connection no longer holds
   * `held` or has moved past `generation`, as `writeWhileTokensHeld` explains.
   */
  const markTokensNeedReauth = (
    connectionId: string,
    held: string,
    generation: number,
    message: string,
  ): Effect.Effect<never, ConnectionUnavailable> =>
    Effect.andThen(
      writeWhileTokensHeld(connectionId, held, generation, setNeedsReauth(connectionId, message)),
      Effect.fail(new ConnectionUnavailable({ message })),
    );

  /** Parses the token set `held`, or marks the connection `needs-reauth` and fails. */
  const parseStoredTokens = (
    row: StoredConnection,
    held: string,
  ): Effect.Effect<TokenSet, ConnectionUnavailable> =>
    parseTokens(held).pipe(
      // New tokens replace the unreadable ones when the user reconnects.
      Effect.catchTag("StoredTokensUnreadable", (error) =>
        markTokensNeedReauth(row.id, held, row.credentialsGeneration, error.message),
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
   * Returns the token endpoint and the client a connection of this type
   * refreshes with, or `None` when it has none: a redirect flow whose plugin
   * has no client id and secret set, or a type with neither flow.
   *
   * - The type's `oauth` declaration refreshes with the client its redirect
   *   flow runs as: the public client the plugin ships, with no secret, or
   *   else the plugin's client and its secret.
   * - The type's `device` declaration refreshes with its public client id and
   *   no secret.
   *
   * A type declares at most one of the two.
   */
  const findRefreshEndpoint = (
    row: StoredConnection,
    type: ConnectionType,
  ): Effect.Effect<Option.Option<{ readonly tokenUrl: string; readonly client: OAuthClient }>> =>
    Effect.gen(function* () {
      const { oauth, device } = type;
      if (oauth !== undefined) {
        const client = yield* Effect.orDie(findOAuthClient(row.pluginId, oauth));
        return Option.map(client, (found) => ({ tokenUrl: oauth.tokenUrl, client: found }));
      }
      if (device !== undefined) {
        return Option.some({ tokenUrl: device.tokenUrl, client: { clientId: device.clientId } });
      }
      return Option.none();
    });

  /**
   * Exchanges the refresh token for a new token set, stores it and returns
   * it. It runs while holding this connection's semaphore and reads the stored
   * tokens again first, so a caller that waited for another caller's refresh
   * gets the new tokens without refreshing again.
   *
   * It refreshes when the access token is stale, or, when `rejectedIdentity`
   * is given, when the stored access token still has that identity: an outside
   * server refused it, whatever its expiry says. A token with another identity
   * was replaced meanwhile and is returned as it is.
   *
   * - With no refresh token or no client to refresh with, it marks the
   *   connection `needs-reauth` and fails.
   * - When the token endpoint rejects the refresh, it marks the connection
   *   `needs-reauth` and fails.
   * - When the token endpoint cannot be reached, it fails with
   *   `ProviderUnreachable` and leaves the status unchanged. The error is not
   *   converted here, so a caller can tell this apart from a connection that
   *   needs reconnecting.
   * - When the user reconnected meanwhile, it fails and changes nothing, as
   *   `writeWhileTokensHeld` explains. The refresh is bound to the generation
   *   of `row`, so `row` must have been read before the call.
   */
  const refreshTokens = (
    row: StoredConnection,
    type: ConnectionType,
    rejectedIdentity: string | undefined,
  ): Effect.Effect<TokenSet, ConnectionUnavailable | ProviderUnreachable> =>
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
      const tokens = yield* parseStoredTokens(row, held);
      const millis = yield* Clock.currentTimeMillis;
      const needsRefresh =
        rejectedIdentity === undefined
          ? isStale(tokens, millis)
          : computeCredentialsIdentity({ accessToken: tokens.accessToken }) === rejectedIdentity;
      if (!needsRefresh) return tokens;

      const endpoint = yield* findRefreshEndpoint(row, type);
      const { refreshToken } = tokens;
      if (refreshToken === undefined || Option.isNone(endpoint)) {
        return yield* markTokensNeedReauth(
          row.id,
          held,
          row.credentialsGeneration,
          "this connection cannot be refreshed",
        );
      }
      // The request and the write that stores its answer are uninterruptible
      // together. A provider that rotates its refresh token invalidates the old
      // one the moment it answers, so a caller cancelled between the answer and
      // the write (a timeout, a cancelled run) would lose the only tokens that
      // still work. `refreshAccess` bounds the request with its own timeout,
      // so this cannot hold the caller or the lock for long.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const answer = yield* refreshAccess({ ...endpoint.value, refreshToken }).pipe(
            Effect.provide(FetchHttpClient.layer),
            // The provider's own text stays out of the message: the status
            // detail and the Notification are read by people and agents.
            Effect.catchTag("ProviderRefused", () =>
              markTokensNeedReauth(row.id, held, row.credentialsGeneration, REFRESH_REFUSED),
            ),
          );
          // When the response has no refresh token, the old one is still valid.
          const next: TokenSet = { ...answer, refreshToken: answer.refreshToken ?? refreshToken };
          yield* writeWhileTokensHeld(
            row.id,
            held,
            row.credentialsGeneration,
            Effect.orDie(
              secrets.set(
                { kind: "connection", id: row.id },
                OAUTH_TOKENS,
                Redacted.make(serializeTokens(next)),
              ),
            ),
          );
          return next;
        }),
      );
    });

  /**
   * Returns the connection and its registered type when the core may use the
   * connection's credentials, or fails with a `ConnectionCredentialsUnavailable`
   * that says why not: `missing` for no such connection or an unregistered
   * type, `switched-off` for a `disabled` one, and `needs-sign-in` for one
   * that is `needs-reauth`. Reads only, so it never refreshes.
   */
  const readConnectionForUse = (
    connectionId: string,
  ): Effect.Effect<
    { readonly row: StoredConnection; readonly type: RegisteredConnectionType },
    ConnectionCredentialsUnavailable
  > =>
    Effect.gen(function* () {
      const row = Option.getOrUndefined(yield* Effect.orDie(connections.one(connectionId)));
      if (row === undefined) {
        return yield* Effect.fail(
          new ConnectionCredentialsUnavailable({
            reason: "missing",
            message: `there is no connection ${connectionId}`,
          }),
        );
      }
      const type = yield* findRegisteredType(row);
      if (type === undefined) {
        return yield* Effect.fail(
          new ConnectionCredentialsUnavailable({
            reason: "missing",
            message: `no plugin in this build declares the connection type ${row.type}`,
          }),
        );
      }
      if (row.status === "disabled") {
        return yield* Effect.fail(
          new ConnectionCredentialsUnavailable({
            reason: "switched-off",
            message: `the connection '${row.label}' is disabled: enable it in Settings > Connections`,
          }),
        );
      }
      if (row.status === "needs-reauth") {
        return yield* Effect.fail(
          new ConnectionCredentialsUnavailable({
            reason: "needs-sign-in",
            message: `the connection '${row.label}' needs signing in again: reconnect it in Settings > Connections`,
          }),
        );
      }
      return { row, type };
    });

  /**
   * The connection row and registered type that a refresh read under the
   * connection's refresh permit. The credentials a caller returns, and the
   * config that goes with them, belong to this row.
   */
  interface ReadUnderPermit {
    readonly row: StoredConnection;
    readonly type: RegisteredConnectionType;
  }

  /**
   * Refreshes a connection's tokens under its refresh permit and returns them
   * with the row and type read under that permit. It passes the promotion gate
   * before it takes the permit, so no caller holds the permit while it waits
   * for a freeze to end.
   *
   * The connection is read again under the permit, before the provider is
   * called. A caller that waited for the permit may find that the caller
   * before it got the connection refused, or that the user disabled it, and
   * then no second refresh runs with a refresh token the provider already
   * refused. The row also gives the refresh its generation, as
   * `refreshTokens` explains. `rejectedIdentity` is as in `refreshTokens`.
   *
   * Fails with a `ConnectionCredentialsUnavailable` when the connection may
   * not be used, and as `refreshTokens` does otherwise.
   */
  const refreshUnderPermit = (
    connectionId: string,
    rejectedIdentity: string | undefined,
  ): Effect.Effect<
    ReadUnderPermit & { readonly tokens: TokenSet },
    ConnectionCredentialsUnavailable | ConnectionUnavailable | ProviderUnreachable
  > =>
    promotion.whenServing(
      readOrCreateRefreshPermit(connectionId).withPermits(1)(
        Effect.flatMap(readConnectionForUse(connectionId), (current) =>
          Effect.map(
            refreshTokens(current.row, current.type.contribution, rejectedIdentity),
            (tokens) => ({ tokens, row: current.row, type: current.type }),
          ),
        ),
      ),
    );

  /**
   * Returns the token set a connection holds, refreshing it first when its
   * access token has expired or is about to, and the row and type the refresh
   * read when it ran. `stored` is the connection's secret under
   * `OAUTH_TOKENS`, which the caller has already read, after it read `row`.
   * The expiry in the returned set belongs to its access token: both come from
   * the one set that was read, or the one the refresh returned.
   *
   * A token from a redirect flow or a device flow is refreshed when it has an
   * expiry and a refresh token. A token with no expiry never needs a refresh.
   * A type that declares neither flow cannot refresh, so its connection needs
   * reauth once the token lapses.
   *
   * Fails with `ConnectionUnavailable` when the token cannot be used, with
   * `ProviderUnreachable` when a refresh could not reach the provider, and
   * with `ConnectionCredentialsUnavailable` when the connection read under the
   * permit may not be used.
   *
   * A refresh passes the promotion gate as one unit, before the provider is
   * called: it waits while a promotion freezes the controller, and never
   * happens once it is sealed. The provider's answer and the write that
   * stores it are never separated by a promotion's freeze: many providers rotate the
   * refresh token and invalidate the old one, so a refresh whose new tokens
   * are not in the copy would leave the new machine holding a refresh token
   * that no longer works.
   *
   * Cancelling the caller does not cancel a refresh that has started. The
   * request, its 30-second timeout and the write that stores the answer run
   * to their end first, for the same reason: the provider has already
   * invalidated the old tokens by the time it answers. So a cancelled caller
   * can wait up to the timeout before it stops.
   */
  const readFreshTokens = (
    row: StoredConnection,
    stored: Redacted.Redacted<string>,
  ): Effect.Effect<
    { readonly tokens: TokenSet; readonly read: ReadUnderPermit | undefined },
    ConnectionCredentialsUnavailable | ConnectionUnavailable | ProviderUnreachable
  > =>
    Effect.gen(function* () {
      const held = Redacted.value(stored);
      const tokens = yield* parseStoredTokens(row, held);
      const millis = yield* Clock.currentTimeMillis;
      if (!isStale(tokens, millis)) return { tokens, read: undefined };
      const type = (yield* findRegisteredType(row))?.contribution;
      if (type?.oauth === undefined && type?.device === undefined) {
        return yield* markTokensNeedReauth(
          row.id,
          held,
          row.credentialsGeneration,
          "this connection's access token has expired",
        );
      }
      const refreshed = yield* refreshUnderPermit(row.id, undefined);
      return { tokens: refreshed.tokens, read: refreshed };
    });

  /**
   * Returns the token set of a token connection, refreshing it first when its
   * access token has expired or is about to, as `readFreshTokens` explains.
   * Fails with `ConnectionUnavailable` when the token cannot be used, and with
   * `ProviderUnreachable` when a refresh could not reach the provider.
   */
  const readFreshTokenSet = (
    row: StoredConnection,
    stored: Redacted.Redacted<string>,
  ): Effect.Effect<TokenSet, ConnectionUnavailable | ProviderUnreachable> =>
    readFreshTokens(row, stored).pipe(
      Effect.map((fresh) => fresh.tokens),
      Effect.catchTag("ConnectionCredentialsUnavailable", (error) =>
        Effect.fail(new ConnectionUnavailable({ message: error.message })),
      ),
    );

  /**
   * Returns a connection's credentials, decrypted, from one read of its
   * secrets, with the row and type a refresh read under the permit when one
   * ran. Which kind depends on what the connection holds, not on its type,
   * because a type may offer both pasted credentials and a token flow:
   *
   * - a connection that holds `oauth.tokens` was set up through a redirect
   *   flow or a device flow, and returns `{ accessToken }`;
   * - any other connection returns the fields the user pasted, keyed by name.
   *
   * Fails as `readFreshTokens` does when its token cannot be used. A
   * connection with no secrets whose type signs in through a redirect flow or
   * a device flow is also marked `needs-reauth`: signing in again is how the
   * user gives it a token.
   *
   * Fails with `ProviderUnreachable` when a refresh could not reach the
   * provider. `readStoredCredentials` turns that into a `ConnectionUnavailable`
   * for a plugin; the core's own reads keep it apart.
   */
  const readStoredCredentialsOrUnreachable = (
    row: StoredConnection,
  ): Effect.Effect<
    { readonly credentials: Record<string, string>; readonly read: ReadUnderPermit | undefined },
    ConnectionCredentialsUnavailable | ConnectionUnavailable | ProviderUnreachable
  > =>
    Effect.gen(function* () {
      const stored = yield* Effect.orDie(secrets.values({ kind: "connection", id: row.id }));
      const tokens = stored.find((one) => one.name === OAUTH_TOKENS);
      if (tokens !== undefined) {
        const fresh = yield* readFreshTokens(row, tokens.value);
        return { credentials: { accessToken: fresh.tokens.accessToken }, read: fresh.read };
      }
      if (stored.length === 0) {
        const message = `the connection ${row.id} holds no credentials`;
        const type = (yield* findRegisteredType(row))?.contribution;
        if (type?.oauth !== undefined || type?.device !== undefined) {
          return yield* markNeedsReauth(row.id, message);
        }
        return yield* Effect.fail(new ConnectionUnavailable({ message }));
      }
      return {
        credentials: Object.fromEntries(stored.map((one) => [one.name, Redacted.value(one.value)])),
        read: undefined,
      };
    });

  /**
   * Returns a connection's credentials as `readStoredCredentialsOrUnreachable`
   * does, but fails with a `ConnectionUnavailable` when the provider could not
   * be reached or the connection may not be used: a plugin cannot tell these
   * apart.
   */
  const readStoredCredentials = (
    row: StoredConnection,
  ): Effect.Effect<Record<string, string>, ConnectionUnavailable> =>
    readStoredCredentialsOrUnreachable(row).pipe(
      Effect.map((found) => found.credentials),
      Effect.mapError((error) =>
        error._tag === "ConnectionUnavailable"
          ? error
          : new ConnectionUnavailable({ message: error.message }),
      ),
    );

  /**
   * Returns the credentials with their config and identity, ready for the
   * core to use. Fails with `invalid-config` when the connection's config does not
   * fit its type's config schema, because the type changed since the config
   * was written and the core cannot hand a caller a config it cannot trust.
   */
  const buildCredentialsForUse = (
    row: StoredConnection,
    type: RegisteredConnectionType,
    credentials: Record<string, string>,
  ): Effect.Effect<ConnectionCredentialsForUse, ConnectionCredentialsUnavailable> =>
    Effect.gen(function* () {
      const { configSchema } = type.contribution;
      const config =
        configSchema === undefined
          ? row.config
          : yield* Effect.mapError(
              decodeAgainst(configSchema, row.config),
              (error) =>
                new ConnectionCredentialsUnavailable({
                  reason: "invalid-config",
                  message: `the config of the connection '${row.label}' does not fit its type: ${error.message}`,
                }),
            );
      return { credentials, config, identity: computeCredentialsIdentity(credentials) };
    });

  /** Converts a failed read of a token into the error the core's callers see. */
  const toCredentialsUnavailable = (
    error: ConnectionCredentialsUnavailable | ConnectionUnavailable | ProviderUnreachable,
  ): ConnectionCredentialsUnavailable =>
    error._tag === "ConnectionCredentialsUnavailable"
      ? error
      : new ConnectionCredentialsUnavailable({
          reason: error._tag === "ProviderUnreachable" ? "unreachable" : "needs-sign-in",
          message: error.message,
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
     * Returns the token set a Connection holds, refreshing it first when its
     * access token has expired or is inside the refresh margin. `stored` is
     * the Connection's secret under `OAUTH_TOKENS`, which the caller has
     * already read. Core code that hands a token to a session uses this, so
     * it gets a working token or a failure, whatever the Connection's type.
     *
     * Fails with `ConnectionUnavailable` when the token cannot be used (the
     * refresh was refused, which also marks the Connection `needs-reauth`),
     * and with `ProviderUnreachable` when the refresh could not reach the
     * provider. The two stay apart so a caller can tell a person to reconnect
     * from telling them to try again later.
     *
     * This may call the provider and write the Connection's status, so it must
     * run outside any transaction: never call it inside `withTransaction`.
     */
    readFreshTokenSet,

    /**
     * Returns a Connection's credentials, config and identity for the core to
     * call an outside server with. Unlike `runtimeFor(...).credentials`, it is
     * not scoped to a plugin and keeps an unreachable provider apart from a
     * refused refresh. OAuth tokens are refreshed first when they are stale,
     * as `readFreshTokenSet` explains, and a refresh the provider refuses
     * marks the Connection `needs-reauth`.
     *
     * Fails with a `ConnectionCredentialsUnavailable` whose `reason` is
     * `needs-sign-in` (the Connection is `needs-reauth`, holds no credentials
     * of a flow it needs, or the provider refused the refresh), `unreachable`
     * (the provider could not be reached; the Connection is left alone),
     * `switched-off` (the Connection is `disabled`) or `missing` (no such
     * Connection, or no registered type) or `invalid-config` (the config no
     * longer fits its type's schema).
     *
     * This may call the provider and write the Connection's status, so it must
     * run outside any transaction.
     */
    readCredentialsForUse: (
      connectionId: string,
    ): Effect.Effect<ConnectionCredentialsForUse, ConnectionCredentialsUnavailable> =>
      Effect.gen(function* () {
        const { row, type } = yield* readConnectionForUse(connectionId);
        const found = yield* retryWhenCredentialsReplaced(
          readStoredCredentialsOrUnreachable(row),
        ).pipe(Effect.mapError(toCredentialsUnavailable));
        // The config comes from the row a refresh read under the permit, not
        // from the earlier read, which a reconnect or a switch off may have outdated.
        return yield* buildCredentialsForUse(
          found.read?.row ?? row,
          found.read?.type ?? type,
          found.credentials,
        );
      }),

    /**
     * Returns a Connection's credentials after an outside server answered 401
     * to a request that carried the credentials with identity
     * `rejectedIdentity`. It runs under the Connection's refresh permit, so
     * callers that were rejected together refresh once between them:
     *
     * - when the stored credentials no longer have that identity, someone
     *   refreshed or reconnected meanwhile, and it returns them as they are;
     * - otherwise it refreshes the OAuth tokens now, even when they are not
     *   stale, with the outcome rules of the stale refresh: a refusal marks the
     *   Connection `needs-reauth` and fails with `needs-sign-in`, and an
     *   unreachable provider leaves the Connection alone and fails with
     *   `unreachable`.
     *
     * Fails with `ConnectionCannotRefresh`, and changes nothing, when the
     * Connection holds pasted credentials and no OAuth tokens and they are the
     * ones that were rejected. Fails with a `ConnectionCredentialsUnavailable`
     * as `readCredentialsForUse` does. The Connection is read again under the
     * permit, before the provider is called and on the retry after a
     * reconnect, so a Connection that another caller just got refused, or
     * that the user disabled meanwhile, fails with `needs-sign-in` or
     * `switched-off` and the provider is not called.
     *
     * This may call the provider and write the Connection's status, so it must
     * run outside any transaction.
     */
    refreshAfterRejection: (
      connectionId: string,
      rejectedIdentity: string,
    ): Effect.Effect<
      ConnectionCredentialsForUse,
      ConnectionCredentialsUnavailable | ConnectionCannotRefresh
    > =>
      Effect.gen(function* () {
        const { row, type } = yield* readConnectionForUse(connectionId);
        const found = yield* retryWhenCredentialsReplaced(
          Effect.gen(function* () {
            const tokens = yield* Effect.orDie(
              secrets.get({ kind: "connection", id: row.id }, OAUTH_TOKENS),
            );
            if (Option.isSome(tokens)) {
              const refreshed = yield* refreshUnderPermit(row.id, rejectedIdentity);
              return {
                credentials: { accessToken: refreshed.tokens.accessToken },
                read: refreshed,
              };
            }
            const pasted = yield* readStoredCredentialsOrUnreachable(row);
            if (computeCredentialsIdentity(pasted.credentials) === rejectedIdentity) {
              return yield* Effect.fail(
                new ConnectionCannotRefresh({
                  message: `the connection '${row.label}' holds pasted credentials, which cannot be refreshed: replace them in Settings > Connections`,
                }),
              );
            }
            return pasted;
          }),
        ).pipe(
          Effect.mapError((error) =>
            error._tag === "ConnectionCannotRefresh" ? error : toCredentialsUnavailable(error),
          ),
        );
        return yield* buildCredentialsForUse(
          found.read?.row ?? row,
          found.read?.type ?? type,
          found.credentials,
        );
      }),

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
  SqlClient.SqlClient | Secrets | PluginConfigs | PromotionState | Notifier
> = Layer.effect(ConnectionTypes)(make);
