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
 * A server has at most one attempt, kept in `attempts`. A `start` takes the
 * server's place at once with a placeholder, which voids the older attempt, and
 * replaces the placeholder with its attempt when its discovery is done. A
 * start that fails removes its placeholder, so a failed start also leaves the
 * server with no attempt. Every step of the map that decides who wins (take,
 * claim, publish, drop) runs without waiting, so no lock is needed: the only
 * wait that matters is the database write of `commit`, and the transaction
 * checks there that the server's sign-in is still the one the attempt started
 * from.
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
  isRedirectAddress,
  parseCallbackQuery,
  type InvalidState,
  type McpServerSignInStart,
  type ParsedCallback,
  type Validation,
} from "@hercule/contract";
import { currentStamp } from "../actor";
import { nowIso, withTransaction } from "../db";
import { AuditLog } from "../events";
import { computeChallenge, exchangeCode, ProviderRefused, type TokenSet } from "../oauth";
import {
  buildAuthorizationUrl,
  discoverAuthorization,
  registerClient,
  type DiscoveredAuthorization,
  type RegisteredClient,
} from "./authorization";
import { mcpServerRepository } from "./repository";
import { McpServerSignIns, type OAuthSignIn } from "./sign-ins";

/** How long a started sign-in can be finished. */
const SIGN_IN_LIFETIME_MILLIS = 10 * 60 * 1000;

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

const refuseCallback = (message: string): Effect.Effect<never, Validation> =>
  Effect.fail(createValidationError([{ path: ["callbackQuery"], message }]));

/**
 * Reads what the browser came back with (`parseCallbackQuery` of the
 * contract). Fails with `Validation` when the text is not a redirect answer,
 * with a message that never quotes it, because it holds a code.
 */
const readCallback = (text: string): Effect.Effect<ParsedCallback, Validation> => {
  const parsed = parseCallbackQuery(text);
  return parsed._tag === "Refused" ? refuseCallback(parsed.reason) : Effect.succeed(parsed);
};

/** Compares two secrets in constant time. */
const isSameSecret = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** A start that is still discovering. It holds the server's place in `attempts`, so that the older attempt is void and nothing else is published meanwhile. */
interface StartingAttempt {
  readonly _tag: "Starting";
}

/**
 * A sign-in that was started and not finished. It holds everything `finish`
 * needs, so `finish` repeats no discovery: the answer is checked against the
 * server's metadata as it was read at the start.
 */
interface Attempt {
  readonly _tag: "Waiting";
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
  const serviceScope = yield* Effect.scope;

  /** The attempts that were started and not finished, by server id: at most one per server. */
  const attempts = new Map<string, Attempt | StartingAttempt>();
  /**
   * The client each server's latest start registered, until a sign-in commits
   * and stores one, so that a second start before that registers nothing again.
   * It holds the authorization server it is for, which a start compares, and
   * when a start last used the client.
   *
   * Only `start` adds an entry, one per server (a later start replaces it). An
   * entry goes when the server's sign-in commits, when the authorization server
   * rejects the client (`forgetClient`), and, on every start and finish, when no
   * start used it for longer than an attempt lasts. So the map holds at most
   * one entry for each server that was started recently. A server that is
   * deleted or replaced has its entry swept the same way, which is why this
   * module does not need to hear of a delete.
   */
  const unstoredClients = new Map<
    string,
    {
      readonly discovery: DiscoveredAuthorization;
      readonly client: RegisteredClient;
      readonly lastUsedAtMillis: number;
    }
  >();

  /**
   * Forgets every attempt that ran out, and every unstored client that no
   * start used for as long as an attempt lasts. Placeholders have no deadline.
   * Runs on every start and finish. Each attempt is also forgotten at its own
   * deadline (`forgetAttemptAtDeadline`), so a verifier does not stay in memory
   * when no one starts or finishes again.
   */
  const sweepExpired = (nowMillis: number): void => {
    for (const [serverId, entry] of attempts) {
      if (entry._tag === "Waiting" && entry.expiresAtMillis <= nowMillis) attempts.delete(serverId);
    }
    for (const [serverId, unstored] of unstoredClients) {
      if (unstored.lastUsedAtMillis + SIGN_IN_LIFETIME_MILLIS <= nowMillis) {
        unstoredClients.delete(serverId);
      }
    }
  };

  /**
   * Forgets the server's attempt with this `state` once the sign-in lifetime
   * is over, and then returns. It holds the `state` and not the attempt, so the
   * attempt's verifier is not kept alive by a finished attempt's timer.
   */
  const forgetAttemptAtDeadline = (serverId: string, state: string): Effect.Effect<void> =>
    Effect.sleep(Duration.millis(SIGN_IN_LIFETIME_MILLIS)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          const entry = attempts.get(serverId);
          if (entry?._tag === "Waiting" && entry.state === state) attempts.delete(serverId);
        }),
      ),
    );

  /** Forgets `entry` when it is still the server's current one, so a newer entry stays. */
  const forgetEntry = (serverId: string, entry: Attempt | StartingAttempt): void => {
    if (attempts.get(serverId) === entry) attempts.delete(serverId);
  };

  /**
   * Makes every later start register a new client for the server, because the
   * authorization server no longer knows or accepts the one the attempt used.
   */
  const forgetClient = (attempt: Attempt): void => {
    unstoredClients.delete(attempt.serverId);
    signIns.markClientRejected(attempt.serverId, attempt.client.clientId);
  };

  /**
   * Returns the client a start may use again for `discovery`, or `undefined`
   * when it must register one. Using an unstored client renews its time of use.
   * The client is: the client the server's last start registered
   * and no sign-in stored yet, or else the client of the sign-in the server
   * holds. It is reused only for the same issuer, token endpoint and
   * authorization endpoint, while its secret has not expired, and unless the
   * authorization server rejected it (a refused code exchange, a refused
   * refresh, or a browser sent back with `invalid_client`).
   */
  const findReusableClient = (
    serverId: string,
    discovery: DiscoveredAuthorization,
    nowMillis: number,
  ): Effect.Effect<RegisteredClient | undefined> =>
    Effect.gen(function* () {
      const isSameServer = (other: DiscoveredAuthorization | OAuthSignIn) =>
        other.issuer === discovery.issuer &&
        other.tokenEndpoint === discovery.tokenEndpoint &&
        other.authorizationEndpoint === discovery.authorizationEndpoint;
      const unstored = unstoredClients.get(serverId);
      if (
        unstored !== undefined &&
        isSameServer(unstored.discovery) &&
        (unstored.client.secretExpiresAtMillis ?? Infinity) > nowMillis
      ) {
        // Using the client keeps it for another ten minutes (`sweepExpired`).
        unstoredClients.set(serverId, { ...unstored, lastUsedAtMillis: nowMillis });
        return unstored.client;
      }
      const stored = yield* signIns.readOAuth(serverId);
      return Option.isSome(stored) &&
        isSameServer(stored.value) &&
        (stored.value.client.secretExpiresAtMillis ?? Infinity) > nowMillis &&
        !signIns.isClientRejected(serverId, stored.value.client.clientId)
        ? stored.value.client
        : undefined;
    });

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

  const createExpiredSignInError = (server: Pick<SignInTarget, "id">): InvalidState =>
    createInvalidStateError(
      `This sign-in can no longer be finished: it ran out (it lasts ten minutes), a newer sign-in replaced it, or the server's sign-in changed. Start it again: hercule mcp-server sign-in ${server.id}`,
      { reason: "sign-in-expired" },
    );

  const createRefusedSignInError = (what: string): InvalidState =>
    createInvalidStateError(`${what} Start the sign-in again.`, { reason: "sign-in-refused" });

  /** Runs `effect` with the HTTP client of this service, and no trace span (a span records the address and the error text). */
  const provideOutboundHttp = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
    );

  /**
   * Sends the code to the token endpoint, with the PKCE verifier, the client's
   * own authentication, the resource, and the redirect address exactly as the
   * attempt used it.
   */
  const exchange = (attempt: Attempt, code: string) =>
    provideOutboundHttp(
      exchangeCode({
        tokenUrl: attempt.discovery.tokenEndpoint,
        client: attempt.client,
        code,
        redirectUri: attempt.redirectUri,
        codeVerifier: attempt.codeVerifier,
        resource: attempt.discovery.resource,
        bearerOnly: true,
      }),
    );

  /**
   * Takes the attempt the answer belongs to, so that no second answer with
   * the same `state` is used. Fails with `InvalidState` (`sign-in-expired`)
   * when the server has no attempt, the attempt ran out or is already taken,
   * or the `state` is not the attempt's. Fails with `Validation` when the
   * client sent a whole address that is not the attempt's redirect address,
   * and then leaves the attempt as it is, so the user may paste the right one.
   */
  const claimAttempt = (
    server: Pick<SignInTarget, "id">,
    callback: ParsedCallback,
  ): Effect.Effect<Attempt, InvalidState | Validation> =>
    Effect.gen(function* () {
      sweepExpired(yield* Clock.currentTimeMillis);
      const attempt = attempts.get(server.id);
      if (
        attempt?._tag !== "Waiting" ||
        attempt.claimed ||
        !isSameSecret(attempt.state, callback.state)
      ) {
        return yield* createExpiredSignInError(server);
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
    });

  /**
   * Checks the answer's `iss` parameter against the issuer the attempt started
   * with (RFC 9207). It must be present when the authorization server's
   * metadata promised it, and it must equal the issuer whenever it is present.
   * An answer from another authorization server could otherwise be mixed up
   * with this one's. Fails with `InvalidState` (`sign-in-refused`).
   */
  const checkIssuer = (
    attempt: Attempt,
    callback: ParsedCallback,
  ): Effect.Effect<void, InvalidState> =>
    (callback.iss === undefined && attempt.discovery.sendsIssuer) ||
    (callback.iss !== undefined && callback.iss !== attempt.discovery.issuer)
      ? Effect.fail(
          createRefusedSignInError(
            "The answer does not come from the authorization server that the sign-in started with, so it was refused.",
          ),
        )
      : Effect.void;

  /**
   * Exchanges the code for tokens and returns them. Fails with
   * `InvalidState`: `sign-in-refused` when the authorization server refuses the
   * code, `sign-in-unsupported` when it answers with an access token that
   * cannot be used as a bearer token (this server cannot be signed in to by
   * OAuth, and a pasted token may work), and `source-unreadable` when it cannot
   * be reached. The messages name only a standard error code, never provider
   * text.
   */
  const exchangeForTokens = (
    attempt: Attempt,
    code: string,
  ): Effect.Effect<TokenSet, InvalidState> =>
    exchange(attempt, code).pipe(
      Effect.catchTag("ProviderRefused", (error: ProviderRefused) =>
        Effect.suspend(() => {
          if (error.code === "invalid_client") forgetClient(attempt);
          return Effect.fail(
            createRefusedSignInError(
              error.code === undefined
                ? "The authorization server refused the code."
                : `The authorization server refused the code (${error.code}).`,
            ),
          );
        }),
      ),
      Effect.catchTag("ProviderTokenUnusable", () =>
        Effect.fail(
          createInvalidStateError(
            `The authorization server issued an access token that is not a bearer token, so this server cannot be signed in to through the browser. Paste a token instead: hercule mcp-server set-token ${attempt.serverId}`,
            { reason: "sign-in-unsupported" },
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
    );

  /**
   * Stores the sign-in in one transaction when the attempt is still the
   * server's current one, it has not run out, the server still exists and is a
   * server added by URL, and its `sign_in_generation` is the attempt's.
   * Otherwise it writes nothing and fails with `InvalidState`
   * (`sign-in-expired`): the user pasted a token, replaced the server, or
   * started another sign-in while the browser and the token endpoint were
   * busy. The server goes back to `checking`, as `setToken` does, and the
   * audit entry records only that the sign-in is now OAuth.
   *
   * When the attempt lost, the tokens that the exchange already obtained are
   * dropped without being revoked: OAuth and MCP require no revocation
   * endpoint, and a server that has one is not asked for it.
   *
   * It takes no lock. A start that takes the server's place during the
   * transaction cannot publish, because its own `sign_in_generation` check
   * fails once this transaction has written.
   */
  const commit = (
    attempt: Attempt,
    tokens: TokenSet,
  ): Effect.Effect<void, InvalidState | SqlError> =>
    Effect.gen(function* () {
      const { serverId } = attempt;
      const nowMillis = yield* Clock.currentTimeMillis;
      if (attempts.get(serverId) !== attempt || attempt.expiresAtMillis <= nowMillis) {
        return yield* createExpiredSignInError({ id: serverId });
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
              ...(client.secretExpiresAtMillis === undefined
                ? {}
                : { secretExpiresAtMillis: client.secretExpiresAtMillis }),
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
      forgetEntry(serverId, attempt);
      if (!stored) return yield* createExpiredSignInError({ id: serverId });
      unstoredClients.delete(serverId);
    });

  return {
    /**
     * Starts a sign-in for a server added by URL and returns the address to
     * open in a browser, and when the sign-in runs out. It discovers the
     * server's authorization server, finds a client for it (the one the
     * server's last start registered, the one its sign-in holds, or a new
     * registration, tried in this order by `findReusableClient`), and keeps the
     * attempt in memory, replacing any attempt the server had. It writes
     * nothing to the database, so a start that is slow cannot bring back a
     * secret that a delete, a Replace or a pasted token removed meanwhile.
     * `signInGeneration` is the server's `sign_in_generation`, read before this
     * call.
     *
     * The start takes the server's place when it begins, which voids the
     * older attempt, and publishes its own attempt only if nothing took that
     * place since and the server is still a server added by URL with the
     * `sign_in_generation` it was given. A start that fails or loses leaves
     * the server with no attempt, or with the newer start's.
     *
     * Fails with `InvalidState`: `sign-in-unsupported` when the server offers
     * no sign-in through the browser that Hercule can use, `source-unreadable`
     * when the server or its authorization server cannot be reached or answers
     * what OAuth does not allow, and `sign-in-expired` when the start was voided
     * or lost, as described above.
     */
    start: (
      server: SignInTarget,
      signInGeneration: number,
      redirectUri: string,
    ): Effect.Effect<McpServerSignInStart, InvalidState | SqlError> =>
      Effect.suspend(() => {
        const starting: StartingAttempt = { _tag: "Starting" };
        attempts.set(server.id, starting);
        return Effect.gen(function* () {
          const discovery = yield* provideOutboundHttp(discoverAuthorization(server.url));
          const reuseMillis = yield* Clock.currentTimeMillis;
          sweepExpired(reuseMillis);
          const reused = yield* findReusableClient(server.id, discovery, reuseMillis);
          const client = reused ?? (yield* provideOutboundHttp(registerClient(discovery)));
          if (reused === undefined) {
            unstoredClients.set(server.id, { discovery, client, lastUsedAtMillis: reuseMillis });
          }
          const codeVerifier = buildRandomToken();
          const state = buildRandomToken();
          const isSameSignIn = yield* isStillSameSignIn(server.id, signInGeneration);
          const nowMillis = yield* Clock.currentTimeMillis;
          // From here to the `set` nothing waits, so the placeholder cannot be replaced in between.
          if (!isSameSignIn || attempts.get(server.id) !== starting) {
            return yield* createExpiredSignInError(server);
          }
          sweepExpired(nowMillis);
          const expiresAtMillis = nowMillis + SIGN_IN_LIFETIME_MILLIS;
          attempts.set(server.id, {
            _tag: "Waiting",
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
          yield* Effect.forkIn(forgetAttemptAtDeadline(server.id, state), serviceScope);
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
        }).pipe(Effect.onError(() => Effect.sync(() => forgetEntry(server.id, starting))));
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
     * 1. the text is a redirect answer (`readCallback`), and a whole
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
        const callback = yield* readCallback(callbackQuery);
        const attempt = yield* claimAttempt(server, callback);
        // The attempt is taken, so whatever fails from here on uses it up.
        yield* Effect.gen(function* () {
          yield* checkIssuer(attempt, callback);
          if (callback.code === undefined) {
            const { error } = callback;
            // The authorization server does not accept the client, so the next start registers another.
            if (error === "invalid_client" || error === "unauthorized_client")
              forgetClient(attempt);
            return yield* createRefusedSignInError(
              error !== undefined && STANDARD_AUTHORIZATION_ERRORS.has(error)
                ? `The authorization server did not sign you in (${error}).`
                : "The authorization server did not sign you in.",
            );
          }
          // A pasted token, a Replace or another sign-in that landed since the
          // start makes the attempt void, and then the code and the verifier
          // must not leave this process.
          if (!(yield* isStillSameSignIn(attempt.serverId, attempt.signInGeneration))) {
            return yield* createExpiredSignInError({ id: attempt.serverId });
          }
          const tokens = yield* exchangeForTokens(attempt, callback.code);
          yield* commit(attempt, tokens);
        }).pipe(Effect.onError(() => Effect.sync(() => forgetEntry(attempt.serverId, attempt))));
      }),
  };
});

/** The OAuth sign-in of an MCP Server added by URL. */
export const mcpServerOAuthSignIn = make;

export type McpServerOAuthSignIn = Effect.Success<typeof make>;
