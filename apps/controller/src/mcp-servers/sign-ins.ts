/**
 * The sign-in of an MCP Server added by URL: the one place that reads, writes
 * and renews the secrets it is made of (spec 21 section 5.2).
 *
 * The secrets are owned by the server (owner kind `mcp-server`, owner id the
 * server's id), and the generic `secret.*` operations refuse that kind. A
 * server has at most one sign-in at a time:
 *
 * - a pasted token is the secret named `token`;
 * - a sign-in through the browser is the secret named `oauth`: one JSON
 *   document that holds the issuer, the endpoints, the resource, the scope,
 *   the client and the tokens, so a refresh never mixes tokens of one sign-in
 *   with endpoints of another;
 * - a server that needs no sign-in holds no secret.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { McpServerToken } from "@hercule/contract";
import { computeCredentialsIdentity, type RefreshGuard } from "../connections";
import { withTransaction } from "../db";
import {
  isExpired,
  isStale,
  makeRefreshPermits,
  ProviderUnreachable,
  renewTokenSet,
  type ProviderRefused,
  TokenSetSchema,
  type TokenSet,
} from "../oauth";
import { PromotionState } from "../promotion";
import { Secrets, type SecretOwner } from "../secrets";
import { mcpServerRepository, type McpServerStoredSource } from "./repository";

/** The name of the secret that holds a pasted token. */
export const SIGN_IN_TOKEN_SECRET = "token";

/** The name of the secret that holds a sign-in through the browser. */
export const SIGN_IN_OAUTH_SECRET = "oauth";

/** The sign-in a server was added with: what its `source` holds as `signIn`. */
type SignIn = Extract<McpServerStoredSource, { readonly kind: "url" }>["signIn"];

const buildOwner = (serverId: string): SecretOwner => ({ kind: "mcp-server", id: serverId });

/**
 * A sign-in through the browser, as the secret `oauth` holds it. Everything a
 * refresh needs is here, and a refresh uses nothing else: not the server's
 * address, and not metadata it finds again.
 *
 * - `issuer` is the authorization server's identifier.
 * - `resource` is the identifier (RFC 8707) every token request names.
 * - `scope` is what the sign-in asked for, when it asked for anything.
 * - `client` is the client Hercule registered, and how it signs token requests.
 */
const OAuthSignInSchema = Schema.Struct({
  issuer: Schema.String,
  authorizationEndpoint: Schema.String,
  tokenEndpoint: Schema.String,
  resource: Schema.String,
  scope: Schema.optionalKey(Schema.String),
  client: Schema.Struct({
    clientId: Schema.String,
    clientSecret: Schema.optionalKey(Schema.String),
    authMethod: Schema.Literals(["none", "client_secret_post", "client_secret_basic"]),
  }),
  tokens: TokenSetSchema,
});

export type OAuthSignIn = Schema.Schema.Type<typeof OAuthSignInSchema>;

const StoredOAuthSignIn = Schema.fromJsonString(OAuthSignInSchema);

const decodeStoredOAuthSignIn = Schema.decodeUnknownEffect(StoredOAuthSignIn);

/**
 * Whether a token fits the syntax of a bearer token (RFC 6750) that an MCP
 * server's pasted token must have. Hercule sends a token in a header and
 * removes it from every answer, which only works for a token of this form
 * (see `McpServerToken`).
 */
export const isBearerToken = Schema.is(McpServerToken);

/**
 * The server's OAuth sign-in changed while a refresh was on its way to the
 * provider: the user signed in again, pasted a token, or moved the server onto
 * a Connection, or the server was deleted. The refresh's answer is about a
 * sign-in the server no longer holds, so it is dropped. The message is fixed.
 */
export class SignInReplaced extends Schema.TaggedError<SignInReplaced>()("SignInReplaced", {
  message: Schema.String,
}) {}

/**
 * The tokens need renewing and there is no refresh token to renew them with,
 * so the user has to sign in again. The message is fixed.
 */
export class CannotRenew extends Schema.TaggedError<CannotRenew>()("CannotRenew", {
  message: Schema.String,
}) {}

/**
 * Why the tokens are being read: `for-use` is a request that starts an exchange
 * and needs a token that is not about to expire, `after-rejection` is the
 * retry after the server refused the token `isRejected` recognises.
 */
type RenewalReason =
  | { readonly _tag: "for-use" }
  | { readonly _tag: "after-rejection"; readonly isRejected: (accessToken: string) => boolean };

const REPLACED_WHILE_RENEWING =
  "the sign-in was replaced while its tokens were being renewed, and the answer was dropped";

const make = Effect.gen(function* () {
  const secrets = yield* Secrets;
  const servers = yield* mcpServerRepository;
  const sql = yield* SqlClient.SqlClient;
  const promotion = yield* PromotionState;
  const httpClient = yield* HttpClient.HttpClient;
  const refreshPermits = makeRefreshPermits();

  /**
   * Returns the token a request to the server carries, or `undefined` when
   * the server carries none. A secret that cannot be read means the database
   * or the Master Key is broken, which no caller can act on, so it is a
   * defect.
   */
  const readToken = (serverId: string, signIn: SignIn): Effect.Effect<string | undefined> =>
    signIn === "token"
      ? Effect.map(Effect.orDie(secrets.get(buildOwner(serverId), SIGN_IN_TOKEN_SECRET)), (found) =>
          Option.getOrUndefined(Option.map(found, Redacted.value)),
        )
      : Effect.sync(() => undefined);

  /**
   * Reads the stored OAuth sign-in and the text it was read from, which a
   * later write compares with to know the sign-in did not change. Returns
   * `none` when the server holds none. Never fails: a secret that cannot be
   * read or decoded is a defect, and its message never quotes the stored
   * text, which holds tokens.
   */
  const readStoredOAuth = (
    serverId: string,
  ): Effect.Effect<Option.Option<{ readonly text: string; readonly signIn: OAuthSignIn }>> =>
    Effect.gen(function* () {
      const found = yield* Effect.orDie(secrets.get(buildOwner(serverId), SIGN_IN_OAUTH_SECRET));
      if (Option.isNone(found)) return Option.none();
      const text = Redacted.value(found.value);
      const signIn = yield* decodeStoredOAuthSignIn(text).pipe(
        Effect.catchTag("SchemaError", () =>
          Effect.die(new Error("the stored OAuth sign-in of an MCP server cannot be read")),
        ),
      );
      return Option.some({ text, signIn });
    });

  const decideNeedsRenewal = (
    tokens: TokenSet,
    reason: RenewalReason,
    nowMillis: number,
  ): boolean =>
    reason._tag === "after-rejection"
      ? reason.isRejected(tokens.accessToken)
      : isStale(tokens, nowMillis);

  /**
   * Stores the renewed tokens of the sign-in `held` read, but only while the
   * server still holds that sign-in: its `sign_in_generation` is `generation`
   * and the secret is still the text `held`. Both are checked in the one
   * transaction that writes, so a sign-in the user made while the provider
   * was called is never overwritten. Fails with `SignInReplaced` when either
   * changed, and then writes nothing.
   *
   * The new access token must be a bearer token, because it is sent in a
   * header and removed from every answer. Fails with `ProviderUnreachable`
   * (the token endpoint answered something Hercule cannot use) when it is not.
   */
  const writeTokensIfHeld = (
    serverId: string,
    held: { readonly text: string; readonly signIn: OAuthSignIn },
    generation: number,
    next: TokenSet,
  ): Effect.Effect<void, SignInReplaced | ProviderUnreachable> =>
    Effect.gen(function* () {
      if (!isBearerToken(next.accessToken)) {
        return yield* new ProviderUnreachable({
          message: "the token endpoint's answer holds an access token that is not a bearer token",
        });
      }
      const written = yield* Effect.orDie(
        withTransaction(
          sql,
          Effect.gen(function* () {
            const current = yield* servers.readSignInGeneration(serverId);
            const stored = yield* secrets.get(buildOwner(serverId), SIGN_IN_OAUTH_SECRET);
            if (
              Option.isNone(current) ||
              current.value !== generation ||
              Option.isNone(stored) ||
              Redacted.value(stored.value) !== held.text
            ) {
              return false;
            }
            yield* secrets.set(
              buildOwner(serverId),
              SIGN_IN_OAUTH_SECRET,
              Redacted.make(JSON.stringify({ ...held.signIn, tokens: next })),
            );
            return true;
          }),
        ),
      );
      if (!written) return yield* new SignInReplaced({ message: REPLACED_WHILE_RENEWING });
    });

  /**
   * Returns the server's OAuth tokens, renewing them first when `reason` says
   * they need it. A renewal runs in this order:
   *
   * 1. It passes the promotion gate, so a refresh never starts on a
   *    controller that is being handed over, and takes the server's permit,
   *    so one refresh runs at a time. The gate comes first: no caller holds
   *    the permit while it waits for a freeze to end.
   * 2. It reads the sign-in again under the permit. A caller that waited may
   *    find the caller before it renewed already.
   * 3. It runs `guard`, the caller's own check that its work still stands, right
   *    before the request to the provider.
   * 4. It sends the refresh and stores the answer as one uninterruptible step
   *    (`renewTokenSet`).
   *
   * Fails with `ProviderRefused` or `ProviderUnreachable` as `renewTokenSet`
   * does, with `SignInReplaced` when the server holds no OAuth sign-in or
   * another one than the renewal started from, with `CannotRenew` when the
   * tokens need renewing and there is no refresh token to do it with, and with
   * what `guard` fails with. A token that is merely about to expire and has no
   * refresh token is still returned, until it expires.
   */
  const readTokens = <GuardFailure>(
    serverId: string,
    reason: RenewalReason,
    guard: RefreshGuard<GuardFailure>,
  ): Effect.Effect<
    TokenSet,
    ProviderRefused | ProviderUnreachable | SignInReplaced | CannotRenew | GuardFailure
  > =>
    Effect.gen(function* () {
      const first = yield* readStoredOAuth(serverId);
      if (Option.isNone(first)) {
        return yield* new SignInReplaced({ message: "the server holds no OAuth sign-in" });
      }
      const firstMillis = yield* Clock.currentTimeMillis;
      // Most requests find a token that is good, and take neither the gate nor the permit.
      if (
        reason._tag === "for-use" &&
        !decideNeedsRenewal(first.value.signIn.tokens, reason, firstMillis)
      ) {
        return first.value.signIn.tokens;
      }
      return yield* promotion.whenServing(
        refreshPermits.withPermit(
          `mcp-server:${serverId}`,
          Effect.gen(function* () {
            // The generation is read before the sign-in, so a sign-in that lands
            // between the two reads leaves a pair that the write below refuses.
            const generation = yield* Effect.orDie(servers.readSignInGeneration(serverId));
            const held = yield* readStoredOAuth(serverId);
            if (Option.isNone(generation) || Option.isNone(held)) {
              return yield* new SignInReplaced({ message: "the server holds no OAuth sign-in" });
            }
            const { signIn } = held.value;
            const millis = yield* Clock.currentTimeMillis;
            if (!decideNeedsRenewal(signIn.tokens, reason, millis)) return signIn.tokens;
            const { refreshToken } = signIn.tokens;
            if (refreshToken === undefined) {
              if (reason._tag === "for-use" && !isExpired(signIn.tokens, millis)) {
                return signIn.tokens;
              }
              return yield* new CannotRenew({
                message: "the sign-in has no refresh token to renew its tokens with",
              });
            }
            yield* guard;
            return yield* renewTokenSet({
              refreshToken,
              endpoint: {
                tokenUrl: signIn.tokenEndpoint,
                client: signIn.client,
                resource: signIn.resource,
                bearerOnly: true,
              },
              writeIfHeld: (next) =>
                writeTokensIfHeld(serverId, held.value, generation.value, next),
            }).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              // No span at all: a client span records the address, and a failed
              // one records the error text.
              Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
            );
          }),
        ),
      );
    });

  return {
    /**
     * Returns the token a request to the server carries as the server's
     * sign-in is now: the pasted token for `token`, and none for `none` and
     * for `oauth`, whose tokens are read with `readOAuthForUse`. Never fails:
     * a broken secret store is a defect.
     */
    readToken,

    /**
     * Returns the server's OAuth sign-in, or `none` when it holds none. Never
     * fails: a broken secret store is a defect.
     */
    readOAuth: (serverId: string): Effect.Effect<Option.Option<OAuthSignIn>> =>
      Effect.map(
        readStoredOAuth(serverId),
        Option.map((stored) => stored.signIn),
      ),

    /**
     * Returns the OAuth tokens for a request that starts an exchange, renewing
     * them first when they expire within the refresh margin. `guard` runs
     * right before a renewal calls the provider. Fails as `readTokens` says.
     */
    readOAuthForUse: <GuardFailure>(serverId: string, guard: RefreshGuard<GuardFailure>) =>
      readTokens(serverId, { _tag: "for-use" }, guard),

    /**
     * Returns the OAuth tokens after the server refused an access token that
     * `isRejected` recognises: the stored ones when they have changed since,
     * and otherwise renewed ones, whatever their expiry says. `guard` is as in
     * `readOAuthForUse`. Fails as `readTokens` says.
     */
    renewOAuthAfterRejection: <GuardFailure>(
      serverId: string,
      isRejected: (accessToken: string) => boolean,
      guard: RefreshGuard<GuardFailure>,
    ) => readTokens(serverId, { _tag: "after-rejection", isRejected }, guard),

    /**
     * Returns a string that changes whenever the server's sign-in changes: its
     * `revision`, the name and rotation time of each secret, and for an OAuth
     * sign-in a fingerprint of its tokens. All three are in it on purpose.
     *
     * - The `revision` rises with every new sign-in, and covers a secret that
     *   is deleted and stored again within the same clock tick, which can leave
     *   its rotation time unchanged.
     * - The rotation times change when a token is rotated without a new
     *   sign-in, as an OAuth refresh does: it replaces the tokens and does not
     *   raise the `revision`.
     * - The fingerprint changes with the decrypted tokens, so a refresh that
     *   rotates them in the same clock tick as the last write is seen too. It
     *   is a hash and never reveals a token.
     */
    readVersion: (serverId: string): Effect.Effect<string> =>
      Effect.gen(function* () {
        const found = yield* Effect.orDie(servers.readMany([serverId], "without-tools"));
        const refs = yield* Effect.orDie(secrets.refs("mcp-server", [serverId]));
        const server = found.get(serverId);
        const oauth =
          server?.source.kind === "url" && server.source.signIn === "oauth"
            ? yield* readStoredOAuth(serverId)
            : Option.none();
        const fingerprint = Option.match(oauth, {
          onNone: () => null,
          onSome: ({ signIn }) =>
            computeCredentialsIdentity({
              accessToken: signIn.tokens.accessToken,
              refreshToken: signIn.tokens.refreshToken ?? "",
            }),
        });
        return JSON.stringify([server?.revision, refs.get(serverId) ?? [], fingerprint]);
      }),

    /**
     * Stores a pasted token for the server, replacing the one it holds. The
     * caller raises the server's `revision` and sets its `signIn` in the same
     * transaction. Must run inside a transaction.
     */
    storeToken: (serverId: string, token: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        Effect.catchTag(
          secrets.set(buildOwner(serverId), SIGN_IN_TOKEN_SECRET, Redacted.make(token)),
          "SecretNameError",
          Effect.die,
        ),
      ),

    /**
     * Stores the OAuth sign-in of a finished browser sign-in for the server,
     * replacing the one it holds. The caller raises the server's `revision`
     * and `sign_in_generation` and sets its `signIn` in the same transaction.
     * Must run inside a transaction.
     */
    storeOAuth: (serverId: string, signIn: OAuthSignIn): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        Effect.catchTag(
          secrets.set(
            buildOwner(serverId),
            SIGN_IN_OAUTH_SECRET,
            Redacted.make(JSON.stringify(signIn)),
          ),
          "SecretNameError",
          Effect.die,
        ),
      ),

    /**
     * Deletes every sign-in secret the server holds. Must run inside a
     * transaction, the one that deletes or replaces the server.
     */
    deleteAll: (serverId: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const refs = yield* secrets.refs("mcp-server", [serverId]);
        for (const { name } of refs.get(serverId) ?? []) {
          yield* Effect.catchTag(
            secrets.delete(buildOwner(serverId), name),
            "SecretNameError",
            Effect.die,
          );
        }
      }),
  };
});

/**
 * Reads, stores and renews the sign-in secrets of MCP Servers added by URL.
 * There is one instance for the controller, because it holds the permits that
 * let one refresh run at a time per server, and a check, a call and a refresh
 * after a rejection share them.
 */
export class McpServerSignIns extends Context.Service<
  McpServerSignIns,
  Effect.Success<typeof make>
>()("hercule/controller/mcp-servers/McpServerSignIns") {}

/** The sign-ins, renewing OAuth tokens through `fetch`. */
export const McpServerSignInsLayer: Layer.Layer<
  McpServerSignIns,
  never,
  Secrets | SqlClient.SqlClient | PromotionState
> = Layer.effect(McpServerSignIns)(make).pipe(Layer.provide(FetchHttpClient.layer));
