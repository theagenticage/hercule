/**
 * The routing table for sessions: one route per live subscription a session
 * holds. The subscriptions a run holds have a routing table of their own.
 *
 * This is the only module that imports both subscriptions and sessions, so
 * neither of them has to import the other. It holds no rules of its own about
 * sessions or subscriptions. Every decision is a call to the service or
 * repository that owns it, and this file only sets the order of those calls.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Event } from "@hercule/contract";
import { SYSTEM_ACTOR } from "../../../actor";
import { nowIso } from "../../../db";
import { SessionService, sessionRepository } from "../../../sessions";
import { Notifier } from "../../../notifications";
import {
  buildHolderEndedReason,
  subscriptionRepository,
  type StoredSubscription,
} from "../../../subscriptions";
import type { Route, RoutingTable } from "../event-router";
import { renderEventInput } from "./render-event-input";

/** One route per live session-held subscription. */
export const sessionRoutingTable: Effect.Effect<
  RoutingTable,
  never,
  SqlClient.SqlClient | SessionService | Notifier
> = Effect.gen(function* () {
  const sessions = yield* SessionService;
  const sessionRows = yield* sessionRepository;
  const subscriptions = yield* subscriptionRepository;
  const notifier = yield* Notifier;

  /**
   * Ends every subscription whose holder session has ended for good. Returns
   * the ids of the subscriptions it ended.
   *
   * A pass runs this first, so no event is evaluated against a subscription
   * whose holder is gone. A session whose process merely exited still counts
   * as a holder: its transcript can still be resumed, so a match wakes it like
   * an idle session.
   */
  const sweepEndedHolders = (
    live: ReadonlyArray<StoredSubscription>,
  ): Effect.Effect<ReadonlySet<string>, SqlError> =>
    Effect.gen(function* () {
      const holderIds = [...new Set(live.map((subscription) => subscription.holder.id))];
      const endedHolderIds = new Set(yield* sessionRows.listEndedForGood(holderIds));
      const swept = new Set<string>();
      for (const subscription of live.filter((one) => endedHolderIds.has(one.holder.id))) {
        const reason = buildHolderEndedReason(subscription.holder.id);
        // No user or session asked for this end, so the system is the actor.
        yield* subscriptions.end({
          id: subscription.id,
          at: yield* nowIso,
          reason,
          actor: SYSTEM_ACTOR,
        });
        // Any input from this subscription that is not delivered yet would
        // wait forever for a session that will never take it.
        yield* sessions.cancelMatchedInputs(subscription.id, reason);
        swept.add(subscription.id);
      }
      return swept;
    });

  /**
   * Records a failed evaluation on the subscription's health. A failure that
   * turns the health from ok to error also raises one notification, in the
   * same write, so the user hears about a broken condition once and not once
   * per event.
   */
  const recordEvaluationFailure = (
    subscriptionId: string,
    message: string,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const began = yield* subscriptions.recordEvaluationFailure(
        subscriptionId,
        message,
        yield* nowIso,
      );
      if (!began) return;
      yield* notifier.createCoreNotification({
        kind: "core.subscription-condition-error",
        title: "A subscription's condition could not be evaluated",
        body: message,
        subject: [{ kind: "subscription", id: subscriptionId }],
      });
    });

  /**
   * Ends the subscriptions whose holder session is gone, then returns the
   * live session-held subscriptions as routes. A subscription admits every event: its condition
   * is its only test. The condition is passed on as stored: the router
   * parses it, and a condition that no longer parses is recorded as an error
   * of that one subscription, like one that fails while it runs.
   */
  const prepare = (): Effect.Effect<ReadonlyArray<Route>, SqlError> =>
    Effect.gen(function* () {
      const live = yield* subscriptions.listLive("session");
      const swept = yield* sweepEndedHolders(live);
      return live
        .filter((subscription) => !swept.has(subscription.id))
        .map((subscription): Route => ({
          admits: () => true,
          condition: subscription.condition,
          hasEvaluationError: subscription.healthErrorMessage !== null,
          writeOnMatch: (event: Event): Effect.Effect<void, SqlError> =>
            Effect.gen(function* () {
              const written = yield* sessions.storeMatchedInput({
                sessionId: subscription.holder.id,
                subscriptionId: subscription.id,
                eventId: event.id,
                actor: SYSTEM_ACTOR,
                text: renderEventInput(event),
                at: yield* nowIso,
              });
              // A lost wake-up records that one event never reached this
              // holder. A matched input written after it makes that record out
              // of date, so this is the one place that clears it. When the
              // subscription already has a row for this event, nothing is
              // written, and its health does not change either.
              if (Option.isSome(written)) yield* subscriptions.clearLostWakeUp(subscription.id);
            }),
          recordEvaluationFailure: (message) => recordEvaluationFailure(subscription.id, message),
          clearEvaluationFailure: () => subscriptions.clearEvaluationFailure(subscription.id),
        }));
    });

  return { prepare };
});
