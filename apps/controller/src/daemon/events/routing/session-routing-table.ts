/**
 * The routing table for sessions: one route per live subscription a session
 * or a conversation holds. The subscriptions a run holds have a routing table
 * of their own.
 *
 * This is the only module that imports both subscriptions and sessions, so
 * neither of them has to import the other. It holds no rules of its own about
 * sessions, conversations or subscriptions. Every decision is a call to the
 * service or repository that owns it, and this file only sets the order of
 * those calls. A match for a session is stored on that session. A match for a
 * conversation is stored on the conversation's newest session, and the queued
 * input delivery sends it after the pass commits: it sends the input, resumes
 * the session, or moves the input to a new session when that one is retired.
 * The router never starts a session, because a match that could not start one
 * would be lost, and the pass is not the place to wait for a runner.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Event } from "@hercule/contract";
import { SYSTEM_ACTOR } from "../../../actor";
import { nowIso } from "../../../db";
import { SessionService, sessionRepository } from "../../../sessions";
import type { Notifier } from "../../../notifications";
import {
  buildConversationDeletedReason,
  buildHolderEndedReason,
  permissionRequestSubscriptions,
  subscriptionRepository,
  type StoredSubscription,
} from "../../../subscriptions";
import type { Route, RoutingTable } from "../event-router";
import { renderEventInput } from "./render-event-input";
import { buildSubscriptionFailureRecorder } from "./subscription-health";

/** One route per live subscription a session or a conversation holds. */
export const sessionRoutingTable: Effect.Effect<
  RoutingTable,
  never,
  SqlClient.SqlClient | SessionService | Notifier
> = Effect.gen(function* () {
  const sessions = yield* SessionService;
  const sessionRows = yield* sessionRepository;
  const subscriptions = yield* subscriptionRepository;
  const requestSubscriptions = yield* permissionRequestSubscriptions;
  const recordEvaluationFailure = yield* buildSubscriptionFailureRecorder;

  /**
   * Ends every subscription whose holder is gone, and returns the ids of the
   * subscriptions it ended. A session is gone when it has ended for good and a
   * conversation when it was deleted.
   *
   * A pass runs this first, so no event is evaluated against a subscription
   * whose holder is gone. A session whose process merely exited still counts
   * as a holder: its transcript can still be resumed, so a match wakes it like
   * an idle session. A conversation outlives each of its sessions, so a
   * rotation ends nothing.
   */
  const sweepEndedHolders = (
    live: ReadonlyArray<StoredSubscription>,
  ): Effect.Effect<ReadonlySet<string>, SqlError> =>
    Effect.gen(function* () {
      const listHolderIds = (kind: StoredSubscription["holder"]["kind"]) => [
        ...new Set(live.filter((one) => one.holder.kind === kind).map((one) => one.holder.id)),
      ];
      const endedSessionIds = new Set(
        yield* sessionRows.listEndedForGood(listHolderIds("session")),
      );
      const deletedConversationIds = new Set(
        yield* subscriptions.listDeletedConversations(listHolderIds("conversation")),
      );
      const swept = new Set<string>();
      for (const subscription of live) {
        const { kind, id } = subscription.holder;
        const reason =
          kind === "session" && endedSessionIds.has(id)
            ? buildHolderEndedReason(id)
            : kind === "conversation" && deletedConversationIds.has(id)
              ? buildConversationDeletedReason(id)
              : undefined;
        if (reason === undefined) continue;
        // No user or session asked for this end, so the system is the actor.
        yield* subscriptions.end({
          id: subscription.id,
          at: yield* nowIso,
          reason,
          actor: SYSTEM_ACTOR,
        });
        // Any input from this subscription that is not delivered yet would
        // wait forever for a holder that will never take it.
        yield* sessions.cancelMatchedInputs(subscription.id, reason);
        swept.add(subscription.id);
      }
      return swept;
    });

  /**
   * Stores the match as an input of the session that should receive it: the
   * session that holds the subscription, or for a conversation's subscription
   * the conversation's newest session, whatever its status. The input waits
   * there. A newest session that is retired, or cannot be resumed, hands it to
   * the conversation's next session when the queued input delivery reaches it.
   * Returns the stored input, or `none` when the subscription already has one
   * for this event.
   *
   * Dies when a conversation that holds a subscription has no session. Its
   * subscriptions are made by its sessions, and sessions are never deleted, so
   * this cannot happen. Dropping the match instead would lose the wake-up
   * with nobody told.
   */
  const storeMatch = (subscription: StoredSubscription, event: Event) =>
    Effect.gen(function* () {
      const { kind, id } = subscription.holder;
      const sessionId =
        kind === "conversation"
          ? Option.match(yield* sessionRows.newestInConversation(id), {
              onNone: () => undefined,
              onSome: (newest) => newest.id,
            })
          : id;
      if (sessionId === undefined) {
        return yield* Effect.die("a conversation that holds a subscription has no session");
      }
      return yield* sessions.storeMatchedInput({
        sessionId,
        subscriptionId: subscription.id,
        eventId: event.id,
        actor: SYSTEM_ACTOR,
        text: renderEventInput(event),
        at: yield* nowIso,
      });
    });

  /**
   * Ends the subscriptions whose holder is gone, then returns the live
   * subscriptions of sessions and conversations as routes. A subscription
   * admits every event: its condition is its only test. The condition is
   * passed on as stored: the router parses it, and a condition that no longer
   * parses is recorded as an error of that one subscription, like one that
   * fails while it runs.
   */
  const prepare = (): Effect.Effect<ReadonlyArray<Route>, SqlError> =>
    Effect.gen(function* () {
      const live = [
        ...(yield* subscriptions.listLive("session")),
        ...(yield* subscriptions.listLive("conversation")),
      ];
      const swept = yield* sweepEndedHolders(live);
      return live
        .filter((subscription) => !swept.has(subscription.id))
        .map((subscription): Route => ({
          admits: () => true,
          condition: subscription.condition,
          hasEvaluationError: subscription.healthErrorMessage !== null,
          writeOnMatch: (event: Event): Effect.Effect<void, SqlError> =>
            Effect.gen(function* () {
              const stored = Option.isSome(yield* storeMatch(subscription, event));
              // A lost wake-up records that one event never reached this
              // holder. An input stored after it makes that record out of
              // date, so this is the one place that clears it. When the
              // subscription already has an input for this event, nothing is
              // stored, and its health does not change either.
              if (stored) yield* subscriptions.clearLostWakeUp(subscription.id);
              // A Permission Request is decided once, so its subscription has
              // nothing more to wait for after the decision.
              if (subscription.target.kind === "request") {
                yield* requestSubscriptions.endDelivered(subscription.id);
              }
            }),
          recordEvaluationFailure: (message) => recordEvaluationFailure(subscription.id, message),
          clearEvaluationFailure: () => subscriptions.clearEvaluationFailure(subscription.id),
        }));
    });

  return { prepare };
});
