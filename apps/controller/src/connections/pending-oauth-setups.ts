/**
 * The pending OAuth setups: sign-ins that were started and not finished, each
 * with its row in `oauth_setups` and, when the type's plugin created an OAuth
 * client for it, that client's cleanup.
 *
 * A created client is an app at the provider that only this sign-in can use. If
 * the sign-in ends without a Connection, the app must be deleted, and if a
 * Connection signs in with it, it must never be. One rule decides who does
 * which:
 *
 * **Whoever deletes the setup row in SQLite owns the cleanup.**
 *
 * - A finish whose claim succeeds deletes the row, and takes the cleanup in the
 *   same uninterruptible step (`claim`). It then keeps the client or deletes it,
 *   depending on whether the Connection was written.
 * - The expiry timer deletes the row at the sign-in's deadline, in a short
 *   transaction of its own inside the promotion gate. Only when that delete
 *   removed a row does it take the cleanup and delete the client at the
 *   provider. A finish that comes after finds no row, whatever the clock says.
 * - A claim that is refused leaves the row, and with it the cleanup.
 * - A start that fails before the sign-in is stored deletes the client itself
 *   (`abandon`).
 *
 * The cleanup is a closure in memory, because it keeps the values the user
 * pasted (a configuration token), which are never stored, logged or put in a
 * key. A Hercule that restarts or is promoted loses the closures, and a client
 * whose sign-in is open then stays at the provider, an unused app that the user
 * can delete there. A sealed controller drops its closures without calling the
 * provider, because the new controller owns the rows and may be finishing a
 * sign-in with that client.
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { CreatedOAuthClient } from "@hercule/plugin-host";
import { nowIso, withTransaction } from "../db";
import { PromotionState } from "../promotion";
import { oauthSetupRepository, type NewSetup, type StoredSetup } from "./oauth-setups";

/**
 * How long an expired row stays before the routine purge deletes it. A row
 * whose sign-in created a client is deleted by its timer at the deadline, which
 * the timer may reach late when the controller is frozen, so the purge must not
 * take the row first and leave the timer nothing to own. An hour is far past
 * any wait of the timer.
 */
export const EXPIRED_SETUP_PURGE_DELAY_MS = 60 * 60 * 1000;

/**
 * How long to wait for a plugin to delete an OAuth client it created. The
 * sign-in that needed the client is over, so nothing should wait for long on
 * the provider.
 */
const DELETE_CLIENT_TIMEOUT = Duration.seconds(10);

/**
 * What `claim` found. A claimed setup comes with the cleanup of the client the
 * plugin created for it, which the claimer now owns, or `undefined` when the
 * sign-in created none (a reconnect that reuses the Connection's own client).
 */
export type PendingClaim<Reason> =
  | {
      readonly _tag: "claimed";
      readonly setup: StoredSetup;
      readonly cleanup: Effect.Effect<void> | undefined;
    }
  | { readonly _tag: "refused"; readonly reason: Reason }
  | { readonly _tag: "none" };

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const setups = yield* oauthSetupRepository;
  const promotion = yield* PromotionState;
  const scope = yield* Effect.scope;

  /** The cleanup of each created client whose sign-in is open, by the sign-in's `state`. */
  const cleanups = new Map<string, Effect.Effect<void>>();

  /** Removes a sign-in's cleanup from the map and returns it, or `undefined` when there is none. */
  const takeCleanup = (state: string): Effect.Effect<void> | undefined => {
    const cleanup = cleanups.get(state);
    cleanups.delete(state);
    return cleanup;
  };

  /**
   * Deletes the client at the provider. It never fails and never waits long,
   * because the sign-in has already ended.
   */
  const buildCleanup = (deleteClient: CreatedOAuthClient["deleteClient"]): Effect.Effect<void> =>
    deleteClient.pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.timeout(DELETE_CLIENT_TIMEOUT),
      Effect.ignoreCause,
    );

  /**
   * Ends a sign-in whose deadline may have come, inside the promotion gate. In
   * one transaction it deletes the row only if the controller's clock says it
   * has expired, and then answers:
   *
   * - `cleanup`: this call deleted the row and so owns the cleanup. It returns
   *   the cleanup, and does not run it: the caller runs it after the gate,
   *   because a request to the provider can take long, and a promotion waits for
   *   the work inside the gate to finish. Whoever deleted the row owns the
   *   client, so the gate no longer matters to it;
   * - `gone`: whoever deleted the row owns the cleanup, and this call does
   *   nothing;
   * - `early`: the row is there and the clock says its deadline has not come (it
   *   was set back since the timer was set), so nothing is deleted and the
   *   caller waits again.
   *
   * When the delete fails, nothing is deleted at the provider.
   */
  const retire = (
    state: string,
  ): Effect.Effect<
    | { readonly _tag: "early" }
    | { readonly _tag: "gone" }
    | { readonly _tag: "cleanup"; readonly run: Effect.Effect<void> }
  > =>
    Effect.flatMap(
      Effect.orElseSucceed(
        withTransaction(
          sql,
          Effect.flatMap(nowIso, (now) => setups.removeIfExpired(state, now)),
        ),
        () => "gone" as const,
      ),
      (outcome) =>
        Effect.sync(() => {
          if (outcome === "live") return { _tag: "early" } as const;
          if (outcome === "gone") return { _tag: "gone" } as const;
          const run = takeCleanup(state);
          return run === undefined
            ? ({ _tag: "gone" } as const)
            : ({ _tag: "cleanup", run } as const);
        }),
    );

  /**
   * Waits for the deadline by the clock, and then retires the sign-in inside
   * the promotion gate. The clock is asked again inside the gate, after any wait
   * there, so a clock that was set back meanwhile makes the retirement early:
   * the timer then waits for the deadline again. The cleanup, when this call
   * owns it, runs after the gate.
   */
  const retireAtDeadline = (state: string, expiresAt: string): Effect.Effect<void> =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Effect.sleep(Duration.millis(Math.max(0, Date.parse(expiresAt) - now))).pipe(
        Effect.andThen(
          promotion.whenServingOr(retire(state), () =>
            Effect.sync(() => {
              cleanups.delete(state);
              return { _tag: "gone" } as const;
            }),
          ),
        ),
        Effect.flatMap((outcome) => {
          if (outcome._tag === "early") return retireAtDeadline(state, expiresAt);
          return outcome._tag === "cleanup" ? outcome.run : Effect.void;
        }),
      ),
    );

  return {
    /**
     * Keeps the cleanup of the client the plugin created for the sign-in with
     * this `state`. The caller calls it in the same uninterruptible step as the
     * creation, so no interrupt can leave an app at the provider that nothing
     * will delete.
     */
    keepCreatedClient: (
      state: string,
      deleteClient: CreatedOAuthClient["deleteClient"],
    ): Effect.Effect<void> =>
      Effect.sync(() => {
        cleanups.set(state, buildCleanup(deleteClient));
      }),

    /**
     * Stores the sign-in's row, and starts the timer that ends it at
     * `setup.expiresAt` when a created client is kept for it. The rows that
     * expired more than `EXPIRED_SETUP_PURGE_DELAY_MS` ago are purged in the same
     * transaction. The timer is started in the step that follows the commit, which
     * is not interruptible.
     */
    publish: (setup: NewSetup): Effect.Effect<void, SqlError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const cutoff = new Date(
            Date.parse(setup.createdAt) - EXPIRED_SETUP_PURGE_DELAY_MS,
          ).toISOString();
          // Only the wait for the writer can be interrupted. An interrupt then
          // leaves no row, and the caller's `abandon` deletes the client.
          yield* restore(
            withTransaction(
              sql,
              Effect.gen(function* () {
                // A row whose cleanup is still kept has a timer that will end it, and
                // a purge that took it first, after a jump of the clock, would leave
                // the client at the provider.
                yield* setups.deleteExpiredBefore(cutoff, [...cleanups.keys()]);
                yield* setups.insert(setup);
              }),
            ),
          );
          if (cleanups.has(setup.state)) {
            yield* Effect.forkIn(retireAtDeadline(setup.state, setup.expiresAt), scope);
          }
        }),
      ),

    /**
     * Ends a sign-in whose start failed or was interrupted: deletes its row, if
     * it was stored, and deletes its client at the provider. Does nothing for a
     * sign-in that has no client kept.
     */
    abandon: (state: string): Effect.Effect<void> =>
      Effect.uninterruptible(
        Effect.andThen(
          Effect.ignore(withTransaction(sql, setups.remove(state))),
          Effect.suspend(() => takeCleanup(state) ?? Effect.void),
        ),
      ),

    /**
     * Claims the setup for this `state` (see `oauthSetupRepository.consume`),
     * and, when the claim succeeds, takes the cleanup of its created client in
     * the same uninterruptible step. A refused or missing claim takes nothing.
     */
    claim: <Reason>(
      state: string,
      check: (setup: StoredSetup) => Reason | undefined,
    ): Effect.Effect<PendingClaim<Reason>, SqlError> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const claim = yield* withTransaction(
            sql,
            Effect.flatMap(nowIso, (now) => setups.consume(state, now, check)),
          );
          if (claim._tag !== "claimed") return claim;
          return { _tag: "claimed", setup: claim.setup, cleanup: takeCleanup(state) } as const;
        }),
      ),
  };
});

export const pendingOAuthSetups = make;
