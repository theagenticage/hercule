/**
 * The two generic halves of refreshing an OAuth token set, shared by every
 * owner of one (a Connection, an MCP Server added by URL):
 *
 * - `KeyedLocks` lets one caller at a time run per key, such as one refresh
 *   per owner.
 * - `renewTokenSet` sends the refresh and stores its answer, so a rotated
 *   refresh token is never lost.
 *
 * The order around them stays the owner's: pass the promotion gate, take the
 * lock, read the stored tokens again under the lock, run the owner's own
 * guard, then call `renewTokenSet`. The owner also decides what a refusal
 * means for its status.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type * as HttpClient from "effect/http/HttpClient";
import {
  ProviderUnreachable,
  refreshAccess,
  type OAuthClient,
  type ProviderRefused,
  type TokenSet,
} from "./client";

/**
 * A set of locks, one per key, so that two callers with the same key never
 * run at the same time. A refresh uses it with the owner's id as the key: two
 * callers that find the same expired token must not both use the refresh
 * token, because some providers invalidate a refresh token once it is used,
 * which would leave the second caller with tokens that no longer work.
 */
export interface KeyedLocks {
  /**
   * Runs `effect` while holding the lock of `key`, and waits first when
   * another caller holds it. Locks of different keys do not wait for each
   * other. Each owner makes its own set, so a key needs no prefix to tell
   * owners apart.
   */
  readonly withPermit: <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/**
 * Creates an empty set of locks. The map is never pruned: it holds at most
 * one entry per key this process has seen, and removing an entry when its
 * owner is deleted could race a caller that still holds it.
 */
export const makeKeyedLocks = (): KeyedLocks => {
  const locks = new Map<string, Semaphore.Semaphore>();
  return {
    withPermit: (key, effect) => {
      // Synchronous on purpose: if an effect ran between the read and the
      // write, two fibers could both pass the read and each create a
      // semaphore of its own.
      let lock = locks.get(key);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(key, lock);
      }
      return lock.withPermits(1)(effect);
    },
  };
};

/**
 * Where and as whom a refresh goes: the token endpoint, the client, the
 * optional RFC 8707 `resource`, and `bearerOnly` (see `exchangeCode`).
 */
export interface RefreshEndpoint {
  readonly tokenUrl: string;
  readonly client: OAuthClient;
  readonly resource?: string;
  readonly bearerOnly?: boolean;
  /** Provider error codes that mean "try again later" and not "refused" (see `postForm`). */
  readonly transientErrors?: ReadonlyArray<string>;
}

/**
 * Exchanges `refreshToken` for a new token set, stores it by calling
 * `writeIfHeld`, and returns it. When the answer has no refresh token, the
 * old one is still valid and the new set keeps it.
 *
 * `writeIfHeld` stores the set only while the owner still holds the set the
 * refresh token was read from. It fails with the owner's own typed error when
 * the owner's set was replaced meanwhile, and then `renewTokenSet` fails with
 * that error and the answer is dropped. The user may sign in again while the
 * provider is called, and the answer is about credentials the owner no longer
 * holds.
 *
 * The request and the write are uninterruptible together. A provider that
 * rotates its refresh token invalidates the old one the moment it answers, so
 * a caller cancelled between the answer and the write (a timeout, a cancelled
 * run) would lose the only tokens that still work. `refreshAccess` bounds the
 * request with its own timeout, so this cannot hold the caller or its permit
 * for long.
 *
 * Fails with `ProviderRefused` or `ProviderUnreachable` as `refreshAccess`
 * does, and with the failure of `writeIfHeld`. A failed refresh writes
 * nothing, so the owner decides what a refusal means for its status.
 *
 * An answer is stored before it is judged. When `endpoint.bearerOnly` is set
 * and the answer cannot be sent as a bearer token, the rotated refresh token
 * is still stored, with an empty access token that is already expired so that
 * the next use renews it; then this fails with `ProviderUnreachable`.
 *
 * Returns the new set even when it is already stale (an `expires_in` of 0): it
 * is the token the provider just issued, and the use that asked for the
 * renewal needs it. A caller that reads the stored set again after a renewal
 * must bound how often it does, or such a provider would make it renew in a
 * loop.
 */
export const renewTokenSet = <WriteFailure>(request: {
  readonly refreshToken: string;
  readonly endpoint: RefreshEndpoint;
  readonly writeIfHeld: (next: TokenSet) => Effect.Effect<void, WriteFailure>;
}): Effect.Effect<
  TokenSet,
  ProviderRefused | ProviderUnreachable | WriteFailure,
  HttpClient.HttpClient
> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const answer = yield* refreshAccess({
        ...request.endpoint,
        refreshToken: request.refreshToken,
      });
      const refreshToken = answer.tokens.refreshToken ?? request.refreshToken;
      const next: TokenSet = { ...answer.tokens, refreshToken };
      if (answer.unusableReason === undefined) {
        yield* request.writeIfHeld(next);
        return next;
      }
      const now = new Date(yield* Clock.currentTimeMillis).toISOString();
      yield* request.writeIfHeld({
        accessToken: "",
        refreshToken,
        expiresAt: now,
        obtainedAt: now,
      });
      return yield* new ProviderUnreachable({ message: answer.unusableReason });
    }),
  );
