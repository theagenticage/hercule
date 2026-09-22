/**
 * The routes the sessions domain owns: one per live subscription, and the
 * delivery of the rows they write.
 *
 * This is the only module that imports both subscriptions and sessions, which
 * is what keeps either of them from importing the other. It holds no rule
 * about a session and no rule about a subscription: every decision here is a
 * call to the service or the repository that owns it, and this file is the
 * order those calls are made in.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Event } from "@hercule/contract";
import { SYSTEM_ACTOR } from "../../actor";
import { nowIso } from "../../db";
import { SessionService, sessionRepository } from "../../sessions";
import {
  buildHolderEndedReason,
  EvaluationErrorNotifier,
  subscriptionRepository,
  type StoredSubscription,
} from "../../subscriptions";
import type { Delivery, Route, RoutingTable } from "../event-router";
import { forking } from "../absorbing";
import { Live } from "../live";
import { renderEventInput } from "./render-event-input";

/** One route per live subscription, held by the session that registered it. */
export const sessionRoutingTable: Effect.Effect<
  RoutingTable,
  never,
  SqlClient.SqlClient | SessionService | EvaluationErrorNotifier
> = Effect.gen(function* () {
  const sessions = yield* SessionService;
  const sessionRows = yield* sessionRepository;
  const subscriptions = yield* subscriptionRepository;
  const notifier = yield* EvaluationErrorNotifier;

  /**
   * Ends every subscription whose holder session has ended for good.
   *
   * It is the first thing a pass does, so an event is never evaluated against
   * a claim nobody is left to answer. A process that merely exited ends
   * nothing: a session whose transcript can still be picked up is woken by a
   * match like an idle one.
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
        // Nobody asked for this end, so the system is what stamps it.
        yield* subscriptions.end({
          id: subscription.id,
          at: yield* nowIso,
          reason,
          actor: SYSTEM_ACTOR,
        });
        // An input this subscription produced that nothing has delivered
        // yet is waiting for a session that will never take it.
        yield* sessions.cancelMatchedInputs(subscription.id, reason);
        swept.add(subscription.id);
      }
      return swept;
    });

  const recordEvaluationFailure = (
    subscriptionId: string,
    message: string,
  ): Effect.Effect<boolean, SqlError> =>
    Effect.flatMap(nowIso, (at) =>
      subscriptions.recordEvaluationFailure(subscriptionId, message, at),
    );

  /**
   * The subscriptions still waiting, as routes. The condition is handed over
   * as it is stored: the router compiles it, and a source that no longer
   * compiles is a failure of that one subscription, recorded the same way as
   * one that fails while it runs.
   */
  const prepare = (): Effect.Effect<ReadonlyArray<Route>, SqlError> =>
    Effect.gen(function* () {
      const live = yield* subscriptions.listLive();
      const swept = yield* sweepEndedHolders(live);
      return live
        .filter((subscription) => !swept.has(subscription.id))
        .map((subscription) => ({
          id: subscription.id,
          condition: subscription.condition,
          inEvaluationError: subscription.healthErrorMessage !== null,
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
              // A lost wake-up says one event never reached this holder. A
              // matched input written after it is what makes that out of date, so
              // the error goes here and nowhere else. Nothing is written for
              // an event this subscription already has a row for, and nothing
              // about its health has changed either.
              if (Option.isSome(written)) yield* subscriptions.clearLostWakeUp(subscription.id);
            }),
        }));
    });

  return {
    prepare,
    recordEvaluationFailure,
    clearEvaluationFailure: subscriptions.clearEvaluationFailure,
    notifyEvaluationError: notifier.notifyEvaluationError,
  };
});

/**
 * The delivery of the inputs the table above wrote: every input a match has
 * produced and nothing has sent yet to the session it was stored for.
 *
 * It reads the rows rather than remembering what a pass just wrote, so a row
 * that outlived the attempt to deliver it - a controller killed between the
 * commit and the send, a machine that refused the frame, a session that was
 * busy and whose transition to idle was missed - is picked up by the next tick
 * instead of waiting for ever.
 *
 * One fiber per session: a delivery waits on a machine, and a machine that is
 * slow to answer must not hold up the sessions behind it or the next tick. The
 * fibers are children of the pipeline's own driver, which lives as long as the
 * controller does.
 */
export const queuedInputDelivery: Effect.Effect<Delivery, never, SessionService | Live> =
  Effect.gen(function* () {
    const sessions = yield* SessionService;
    const live = yield* Live;

    return {
      name: "queued matched inputs",
      deliverWaiting: (): Effect.Effect<void, SqlError> =>
        Effect.gen(function* () {
          for (const sessionId of yield* sessions.listSessionsAwaitingMatchedInput()) {
            yield* forking(
              "A session could not be given what it was waiting for",
              live.deliverQueuedInput(sessionId),
            );
          }
        }),
    };
  });
