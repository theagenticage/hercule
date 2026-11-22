/**
 * The OAuth sign-in of one MCP Server added by URL, from the start to the
 * finish (spec 21 section 5.2, spec 11 `mcpServer.startSignIn` and
 * `mcpServer.finishSignIn`). The browser does the user's part, and it may be
 * on another machine than the controller, so a sign-in is two calls:
 *
 * - `start` discovers the server's authorization server, finds a client for
 *   it, and answers the address to open in a browser. It writes nothing to the
 *   database: the attempt lives in the controller's memory for ten minutes.
 *   Losing it to a restart costs the user one more start, and the PKCE
 *   verifier, a secret, never reaches the disk.
 * - `finish` takes what the browser came back with, checks it belongs to the
 *   attempt, exchanges the code for tokens, and stores the sign-in in one
 *   transaction.
 *
 * A server has at most one attempt: a newer `start` replaces the older. A
 * per-server lock makes "start replaces the attempt" and "finish commits its
 * attempt" one after the other, never at once.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as HttpClient from "effect/http/HttpClient";
import {
  createInvalidStateError,
  createValidationError,
  type InvalidState,
  type McpServerSignInStart,
  type Validation,
} from "@hercule/contract";
import { currentStamp } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import {
  computeChallenge,
  exchangeCode,
  makeRefreshPermits,
  ProviderRefused,
  ProviderUnreachable,
  REFRESH_TIMEOUT_SECONDS,
  type TokenSet,
} from "../oauth";
import {
  buildAuthorizationUrl,
  discoverAuthorization,
  registerClient,
  type DiscoveredAuthorization,
  type RegisteredClient,
} from "./authorization";
import { mcpServerRepository } from "./repository";
import { isBearerToken, McpServerSignIns } from "./sign-ins";

/** How long a started sign-in can be finished. */
export const SIGN_IN_LIFETIME_MILLIS = 10 * 60 * 1000;

/**
 * The error codes an authorization endpoint may send back (RFC 6749 section
 * 4.1.2.1). A refusal names the provider's code only when it is one of these,
 * and never anything else the provider sent, because the message is shown to
 * people.
 */
const STANDARD_AUTHORIZATION_ERRORS: ReadonlySet<string> = new Set([
  "invalid_request",
  "unauthorized_client",
  "access_denied",
  "unsupported_response_type",
  "invalid_scope",
  "server_error",
  "temporarily_unavailable",
]);

/** What the browser came back with, read from the text a client sent. */
export interface Callback {
  /** The address the browser ended on, when the client sent a whole address. */
  readonly address: URL | undefined;
  readonly state: string;
  /** The authorization code. Exactly one of `code` and `error` is set. */
  readonly code: string | undefined;
  readonly error: string | undefined;
  /** The issuer the authorization server says the answer is from (RFC 9207), when it said. */
  readonly iss: string | undefined;
}

const refuseCallback = (message: string): Effect.Effect<never, Validation> =>
  Effect.fail(createValidationError([{ path: ["callbackQuery"], message }]));

/**
 * Reads what the browser came back with. The text is the whole address the
 * browser ended on, or only its query (with or without the leading `?`). A
 * fragment is dropped. Fails with `Validation` when the text is not a redirect
 * answer, with a message that never quotes it, because it holds a code:
 *
 * - it starts like an address and is not one;
 * - a parameter appears twice (the answer would have two readings);
 * - there is no `state`;
 * - it holds both `code` and `error`, or neither.
 *
 * A parameter with an empty value counts as absent.
 */
export const parseCallbackQuery = (text: string): Effect.Effect<Callback, Validation> => {
  const trimmed = text.trim();
  let address: URL | undefined;
  let query: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const parsed = URL.parse(trimmed);
    if (parsed === null) {
      return refuseCallback("this is not an address: paste the address the browser ended on");
    }
    address = parsed;
    query = parsed.search;
  } else {
    query = trimmed.split("#")[0] ?? "";
  }
  const params = new URLSearchParams(query);
  if (new Set(params.keys()).size !== [...params.keys()].length) {
    return refuseCallback("a parameter appears twice, so the answer has two readings");
  }
  const read = (name: string): string | undefined => {
    const value = params.get(name);
    return value === null || value === "" ? undefined : value;
  };
  const state = read("state");
  if (state === undefined) {
    return refuseCallback(
      "there is no state: paste the whole address the browser ended on, or its query",
    );
  }
  const code = read("code");
  const error = read("error");
  if ((code === undefined) === (error === undefined)) {
    return refuseCallback("the answer holds both a code and an error, or neither");
  }
  return Effect.succeed({ address, state, code, error, iss: read("iss") });
};

/**
 * Checks that a pasted address is the redirect address the sign-in started
 * with, which tells a user who pasted the address of another sign-in or
 * another window. The port is part of it, and the query is not. An address
 * with a user name or a password never matches.
 */
export const isRedirectAddress = (address: URL, redirectUri: string): boolean => {
  const expected = new URL(redirectUri);
  return (
    address.username === "" &&
    address.password === "" &&
    address.origin === expected.origin &&
    address.pathname === expected.pathname
  );
};

/** Compares two secrets in constant time. */
const isSameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/**
 * A sign-in that was started and not finished. It holds everything `finish`
 * needs, so `finish` repeats no discovery: what the server's metadata said at
 * the start is what the answer is checked against.
 */
interface Attempt {
  readonly serverId: string;
  /** The server's `sign_in_generation` when the attempt started. */
  readonly signInGeneration: number;
  /** The value that ties the browser's answer to this attempt. */
  readonly state: string;
  /** The PKCE verifier, a secret that never leaves this process until the code exchange. */
  readonly codeVerifier: string;
  /** The redirect address of the attempt, sent again exactly as given at the exchange. */
  readonly redirectUri: string;
  readonly discovery: DiscoveredAuthorization;
  readonly client: RegisteredClient;
  readonly expiresAtMillis: number;
  /** Set once a `finish` took the attempt, so a second answer with the same `state` is refused. */
  claimed: boolean;
}

/** The server a sign-in is for. Only a server added by URL has one. */
export interface SignInTarget {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

/** Returns 32 random bytes, base64url-encoded (43 characters): a PKCE verifier or a `state`. */
const buildRandomToken = (): string => randomBytes(32).toString("base64url");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const servers = yield* mcpServerRepository;
  const signIns = yield* McpServerSignIns;
  const audit = yield* AuditLog;
  const httpClient = yield* HttpClient.HttpClient;

  /** The attempts that were started and not finished, by server id: at most one per server. */
  const attempts = new Map<string, Attempt>();
  /**
   * The number of the newest `start` of each server. A start takes its number
   * when it begins and publishes its attempt only while it is still the newest,
   * so a slow start never replaces the attempt of a start that began later.
   * It holds one small number per server that was ever started.
   */
  const latestStarts = new Map<string, number>();
  let startsBegun = 0;
  // Its permits are plain per-key mutexes.
  const locks = makeRefreshPermits();
  const withServerLock = <A, E, R>(serverId: string, effect: Effect.Effect<A, E, R>) =>
    locks.withPermit(`mcp-server-sign-in:${serverId}`, effect);

  /** Forgets every attempt that ran out. Runs inside the lock of the server it is called for. */
  const sweepExpired = (nowMillis: number): void => {
    for (const [serverId, attempt] of attempts) {
      if (attempt.expiresAtMillis <= nowMillis) attempts.delete(serverId);
    }
  };

  /**
   * Checks that the server still exists, is still added by URL, and still has
   * the `sign_in_generation` an attempt started with. A pasted token, a Replace
   * or another finished sign-in raises the generation. Reads only, so it runs
   * inside or outside a transaction.
   */
  const isStillSameSignIn = (
    serverId: string,
    signInGeneration: number,
  ): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      const found = (yield* servers.readMany([serverId], "without-tools")).get(serverId);
      const generation = yield* servers.readSignInGeneration(serverId);
      return (
        found !== undefined &&
        found.source.kind === "url" &&
        Option.isSome(generation) &&
        generation.value === signInGeneration
      );
    });

  const expiredSignIn = (server: Pick<SignInTarget, "id">): InvalidState =>
    createInvalidStateError(
      `This sign-in can no longer be finished: it ran out (it lasts ten minutes), a newer sign-in replaced it, or the server's sign-in changed. Start it again: hercule mcp-server sign-in ${server.id}`,
      { reason: "sign-in-expired" },
    );

  const refusedSignIn = (what: string): InvalidState =>
    createInvalidStateError(`${what} Start the sign-in again.`, { reason: "sign-in-refused" });

  /** Runs `effect` with the HTTP client of this service, and no trace span (a span records the address and the error text). */
  const outbound = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    );

  /**
   * Sends the code to the token endpoint, with the PKCE verifier, the client's
   * own authentication, the resource, and the redirect address exactly as the
   * attempt used it. The request has the same 30 seconds as a refresh, because
   * the user waits on it.
   */
  const exchange = (attempt: Attempt, code: string) =>
    outbound(
      exchangeCode({
        tokenUrl: attempt.discovery.tokenEndpoint,
        client: attempt.client,
        code,
        redirectUri: attempt.redirectUri,
        codeVerifier: attempt.codeVerifier,
        resource: attempt.discovery.resource,
        bearerOnly: true,
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.seconds(REFRESH_TIMEOUT_SECONDS),
          orElse: () =>
            Effect.fail(
              new ProviderUnreachable({
                message: `the token endpoint did not answer within ${String(REFRESH_TIMEOUT_SECONDS)} seconds`,
              }),
            ),
        }),
      ),
    );

  /**
   * Takes the attempt the answer belongs to, so that no second answer with
   * the same `state` is used. Fails with `InvalidState` (`sign-in-expired`)
   * when the server has no attempt, the attempt ran out or is already taken,
   * or the `state` is not the attempt's. The deadline is checked here, so an
   * attempt that ran out is refused whether or not anything swept it away.
   * Fails with `Validation` when the
   * client sent a whole address that is not the attempt's redirect address,
   * and then leaves the attempt as it is, so the user may paste the right one.
   */
  const claimAttempt = (
    server: Pick<SignInTarget, "id">,
    callback: Callback,
  ): Effect.Effect<Attempt, InvalidState | Validation> =>
    withServerLock(
      server.id,
      Effect.gen(function* () {
        const attempt = attempts.get(server.id);
        if (attempt !== undefined && attempt.expiresAtMillis <= (yield* Clock.currentTimeMillis)) {
          attempts.delete(server.id);
          return yield* expiredSignIn(server);
        }
        if (
          attempt === undefined ||
          attempt.claimed ||
          !isSameSecret(attempt.state, callback.state)
        ) {
          return yield* expiredSignIn(server);
        }
        if (
          callback.address !== undefined &&
          !isRedirectAddress(callback.address, attempt.redirectUri)
        ) {
          return yield* refuseCallback(
            "this address is not the redirect address of the sign-in that waits: paste the address the browser ended on after you signed in to this server",
          );
        }
        attempt.claimed = true;
        return attempt;
      }),
    );

  /** Forgets the attempt when it is still the server's current one. */
  const dropAttempt = (attempt: Attempt) =>
    withServerLock(
      attempt.serverId,
      Effect.sync(() => {
        if (attempts.get(attempt.serverId) === attempt) attempts.delete(attempt.serverId);
      }),
    );

  /**
   * Checks the answer's `iss` parameter against the issuer the attempt started
   * with (RFC 9207). It must be present when the authorization server's
   * metadata promised it, and it must equal the issuer whenever it is present.
   * An answer from another authorization server could otherwise be mixed up
   * with this one's. Fails with `InvalidState` (`sign-in-refused`).
   */
  const checkIssuer = (attempt: Attempt, callback: Callback): Effect.Effect<void, InvalidState> =>
    (callback.iss === undefined && attempt.discovery.sendsIssuer) ||
    (callback.iss !== undefined && callback.iss !== attempt.discovery.issuer)
      ? Effect.fail(
          refusedSignIn(
            "The answer does not come from the authorization server that the sign-in started with, so it was refused.",
          ),
        )
      : Effect.void;

  /**
   * Exchanges the code for tokens and returns them. Fails with
   * `InvalidState`: `sign-in-refused` when the authorization server refuses the
   * code, and `source-unreadable` when it cannot be reached or answers with an
   * access token that cannot be used as a bearer token. The messages name only
   * a standard error code, never provider text.
   */
  const exchangeForTokens = (
    attempt: Attempt,
    code: string,
  ): Effect.Effect<TokenSet, InvalidState> =>
    exchange(attempt, code).pipe(
      Effect.catchTag("ProviderRefused", (error: ProviderRefused) =>
        Effect.fail(
          refusedSignIn(
            error.code === undefined
              ? "The authorization server refused the code."
              : `The authorization server refused the code (${error.code}).`,
          ),
        ),
      ),
      Effect.catchTag("ProviderUnreachable", () =>
        Effect.fail(
          createInvalidStateError(
            "The authorization server could not be reached to finish the sign-in. Start the sign-in again.",
            { reason: "source-unreadable" },
          ),
        ),
      ),
      Effect.flatMap((tokens) =>
        isBearerToken(tokens.accessToken)
          ? Effect.succeed(tokens)
          : Effect.fail(
              createInvalidStateError(
                "The authorization server gave an access token that Hercule cannot send as a bearer token. Start the sign-in again.",
                { reason: "source-unreadable" },
              ),
            ),
      ),
    );

  /**
   * Stores the sign-in in one transaction, under the server's lock, when the
   * attempt is still the server's current one, it has not run out, the server
   * still exists and is a server added by URL, and its `sign_in_generation` is
   * the attempt's. Otherwise it writes nothing and fails with `InvalidState`
   * (`sign-in-expired`): the user pasted a token, replaced the server, or
   * started another sign-in while the browser and the token endpoint were
   * busy. The server goes back to `checking`, as `setToken` does, and the
   * audit entry says only that the sign-in is now OAuth.
   */
  const commit = (
    attempt: Attempt,
    tokens: TokenSet,
  ): Effect.Effect<void, InvalidState | SqlError> =>
    withServerLock(
      attempt.serverId,
      Effect.gen(function* () {
        const { serverId } = attempt;
        if (
          attempts.get(serverId) !== attempt ||
          attempt.expiresAtMillis <= (yield* Clock.currentTimeMillis)
        ) {
          return yield* expiredSignIn({ id: serverId });
        }
        const stored = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            if (!(yield* isStillSameSignIn(serverId, attempt.signInGeneration))) return false;
            const at = yield* nowIso;
            const { discovery, client } = attempt;
            yield* signIns.deleteAll(serverId);
            yield* signIns.storeOAuth(serverId, {
              issuer: discovery.issuer,
              authorizationEndpoint: discovery.authorizationEndpoint,
              tokenEndpoint: discovery.tokenEndpoint,
              resource: discovery.resource,
              ...(discovery.scope === undefined ? {} : { scope: discovery.scope }),
              client: {
                clientId: client.clientId,
                ...(client.clientSecret === undefined ? {} : { clientSecret: client.clientSecret }),
                authMethod: client.authMethod,
              },
              tokens,
            });
            yield* servers.writeOAuthSignIn(serverId, at);
            yield* audit.append({
              kind: "mcpServer.updated",
              actor: yield* currentStamp,
              record: { topic: "mcpServer", id: serverId },
              payload: { mcpServerId: serverId, signIn: "oauth" },
              at,
            });
            return true;
          }),
        );
        attempts.delete(serverId);
        if (!stored) return yield* expiredSignIn({ id: serverId });
      }),
    );

  return {
    /**
     * Starts a sign-in for a server added by URL and returns the address to
     * open in a browser, and when the sign-in runs out. It discovers the
     * server's authorization server, registers a client for it (or keeps the
     * one the server's last sign-in used, when that sign-in's issuer, token
     * endpoint and authorization endpoint are the ones found now), and keeps
     * the attempt in memory, replacing any attempt the server had. It writes
     * nothing to the database, so a start that is slow cannot bring back a
     * secret that a delete, a Replace or a pasted token removed meanwhile.
     * `signInGeneration` is the server's `sign_in_generation`, read before this
     * call.
     *
     * The discovery takes a while and runs outside the lock, so the attempt is
     * published only when, under the lock, no newer start of this server has
     * begun, the server is still a server added by URL, and its
     * `sign_in_generation` is still `signInGeneration`. A start that lost one of
     * these fails with `sign-in-expired` and leaves the newer attempt alone.
     *
     * Fails with `InvalidState`: `sign-in-unsupported` when the server offers
     * no sign-in through the browser that Hercule can use, `source-unreadable`
     * when the server or its authorization server cannot be reached or answers
     * what OAuth does not allow, and `sign-in-expired` as said above.
     */
    start: (
      server: SignInTarget,
      signInGeneration: number,
      redirectUri: string,
    ): Effect.Effect<McpServerSignInStart, InvalidState | SqlError> =>
      Effect.gen(function* () {
        const startNumber = yield* withServerLock(
          server.id,
          Effect.sync(() => {
            startsBegun += 1;
            latestStarts.set(server.id, startsBegun);
            return startsBegun;
          }),
        );
        const discovery = yield* outbound(discoverAuthorization(server.url));
        const stored = yield* signIns.readOAuth(server.id);
        const client =
          Option.isSome(stored) &&
          stored.value.issuer === discovery.issuer &&
          stored.value.tokenEndpoint === discovery.tokenEndpoint &&
          stored.value.authorizationEndpoint === discovery.authorizationEndpoint
            ? stored.value.client
            : yield* outbound(registerClient(discovery));
        const codeVerifier = buildRandomToken();
        const state = buildRandomToken();
        const expiresAtMillis = yield* withServerLock(
          server.id,
          Effect.gen(function* () {
            const nowMillis = yield* Clock.currentTimeMillis;
            sweepExpired(nowMillis);
            if (
              latestStarts.get(server.id) !== startNumber ||
              !(yield* isStillSameSignIn(server.id, signInGeneration))
            ) {
              return yield* expiredSignIn(server);
            }
            const expiresAtMillis = nowMillis + SIGN_IN_LIFETIME_MILLIS;
            attempts.set(server.id, {
              serverId: server.id,
              signInGeneration,
              state,
              codeVerifier,
              redirectUri,
              discovery,
              client,
              expiresAtMillis,
              claimed: false,
            });
            return expiresAtMillis;
          }),
        );
        return {
          authorizationUrl: buildAuthorizationUrl({
            authorizationEndpoint: discovery.authorizationEndpoint,
            clientId: client.clientId,
            redirectUri,
            codeChallenge: computeChallenge(codeVerifier),
            state,
            resource: discovery.resource,
            scope: discovery.scope,
          }),
          expiresAt: new Date(expiresAtMillis).toISOString(),
        };
      }).pipe(
        Effect.catchTag("AuthorizationUnsupported", (error) =>
          Effect.fail(
            createInvalidStateError(
              `${server.name} cannot be signed in through the browser: ${error.message}. Paste a token instead: hercule mcp-server set-token ${server.id}`,
              { reason: "sign-in-unsupported" },
            ),
          ),
        ),
        Effect.catchTag("AuthorizationUnreadable", (error) =>
          Effect.fail(
            createInvalidStateError(
              `The sign-in of ${server.name} could not start: ${error.message}. Try again later.`,
              { reason: "source-unreadable" },
            ),
          ),
        ),
      ),

    /**
     * Finishes the sign-in with what the browser came back with, and stores
     * it. `callbackQuery` is the whole address the browser ended on, or its
     * query. The checks run in this order, and the first to fail ends it:
     *
     * 1. the text is a redirect answer (`parseCallbackQuery`), and a whole
     *    address is the attempt's own redirect address;
     * 2. the server's attempt has that `state` (it is taken, so it is used
     *    once);
     * 3. the answer's `iss` is the issuer the attempt started with;
     * 4. the answer is a code, not an error;
     * 5. the server still has the `sign_in_generation` the attempt started
     *    with, so a void attempt never sends its code;
     * 6. the authorization server accepts the code (outside any transaction,
     *    because it waits on an outside server);
     * 7. the sign-in is stored when the server is still the one the attempt
     *    started from and the attempt has not run out (`commit`).
     *
     * An attempt that fails after step 2 is used up, and the user starts
     * again. The caller wakes the server's check after this returns, when the
     * server is switched on.
     *
     * Fails with `Validation` for step 1 and `InvalidState` for the others:
     * `sign-in-expired` for steps 2, 5 and 7, `sign-in-refused` for steps 3 and
     * 4 and when the authorization server refuses the code, and
     * `source-unreadable` when it cannot be reached.
     */
    finish: (
      server: Pick<SignInTarget, "id">,
      callbackQuery: string,
    ): Effect.Effect<void, InvalidState | Validation | SqlError> =>
      Effect.gen(function* () {
        const callback = yield* parseCallbackQuery(callbackQuery);
        const attempt = yield* claimAttempt(server, callback);
        // The attempt is taken, so whatever fails from here on uses it up.
        yield* Effect.gen(function* () {
          yield* checkIssuer(attempt, callback);
          if (callback.code === undefined) {
            const { error } = callback;
            return yield* refusedSignIn(
              error !== undefined && STANDARD_AUTHORIZATION_ERRORS.has(error)
                ? `The authorization server did not sign you in (${error}).`
                : "The authorization server did not sign you in.",
            );
          }
          // A pasted token, a Replace or another sign-in that landed since the
          // start makes the attempt void, and then the code and the verifier
          // must not leave this process.
          if (!(yield* isStillSameSignIn(attempt.serverId, attempt.signInGeneration))) {
            return yield* expiredSignIn({ id: attempt.serverId });
          }
          const tokens = yield* exchangeForTokens(attempt, callback.code);
          yield* commit(attempt, tokens);
        }).pipe(Effect.onError(() => dropAttempt(attempt)));
      }),
  };
});

/** The OAuth sign-in of an MCP Server added by URL. */
export const mcpServerOAuthSignIn = make;

export type McpServerOAuthSignIn = Effect.Success<typeof make>;
