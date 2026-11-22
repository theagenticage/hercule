/**
 * The two generic halves of refreshing an OAuth token set, shared by every
 * owner of one (a Connection, an MCP Server added by URL):
 *
 * - `RefreshPermits` lets one refresh at a time run per owner.
 * - `renewTokenSet` sends the refresh and stores its answer, so a rotated
 *   refresh token is never lost.
 *
 * The order around them stays the owner's: pass the promotion gate, take the
 * permit, read the stored tokens again under the permit, run the owner's own
 * guard, then call `renewTokenSet`. The owner also decides what a refusal
 * means for its status.
 */
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import type * as HttpClient from "effect/http/HttpClient";
import {
  refreshAccess,
  type OAuthClient,
  type ProviderRefused,
  type ProviderUnreachable,
  type TokenSet,
} from "./client";

/**
 * One permit per key, so two callers that find the same expired token do not
 * both use the refresh token. Some providers invalidate a refresh token once
 * it is used, which would leave the second caller with tokens that no longer
 * work.
 */
export interface RefreshPermits {
  /**
   * Runs `effect` while holding the permit of `key`, and waits first when
   * another caller holds it. A key names the owner and its id, such as
   * `connection:<id>`, so owners of different kinds never share a permit.
   */
  readonly withPermit: <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}

/**
 * Creates an empty set of permits. The map is never pruned: it holds at most
 * one entry per key this process has seen, and removing an entry when its
 * owner is deleted could race a refresh that still holds it.
 */
export const makeRefreshPermits = (): RefreshPermits => {
  const permits = new Map<string, Semaphore.Semaphore>();
  return {
    withPermit: (key, effect) => {
      // Synchronous on purpose: if an effect ran between the read and the
      // write, two fibers could both pass the read and each create a
      // semaphore of its own.
      let permit = permits.get(key);
      if (permit === undefined) {
        permit = Semaphore.makeUnsafe(1);
        permits.set(key, permit);
      }
      return permit.withPermits(1)(effect);
    },
  };
};

/** Where and as whom a refresh goes: the token endpoint, the client, and the optional RFC 8707 `resource`. */
export interface RefreshEndpoint {
  readonly tokenUrl: string;
  readonly client: OAuthClient;
  readonly resource?: string;
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
      const next: TokenSet = {
        ...answer,
        refreshToken: answer.refreshToken ?? request.refreshToken,
      };
      yield* request.writeIfHeld(next);
      return next;
    }),
  );
