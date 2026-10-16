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
 * conversation goes through `ConversationDelivery`, the one rule for where a
 * conversation's input goes, so it reaches whichever session the conversation
 * has by then.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError } from "effect/unstable/sql/SqlError";
import type { Event } from "@hercule/contract";
import { SYSTEM_ACTOR } from "../../../actor";
import { ConversationDelivery, type DeliveryError } from "../../../assistants";
import { conversationRepository } from "../../../conversations";
import { nowIso } from "../../../db";
import { inputRepository, SessionService, sessionRepository } from "../../../sessions";
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
  SqlClient.SqlClient | SessionService | ConversationDelivery | Notifier
> = Effect.gen(function* () {
  const sessions = yield* SessionService;
  const sessionRows = yield* sessionRepository;
  const inputs = yield* inputRepository;
  const conversations = yield* conversationRepository;
  const delivery = yield* ConversationDelivery;
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
      const idsHeldBy = (kind: StoredSubscription["holder"]["kind"]) => [
        ...new Set(live.filter((one) => one.holder.kind === kind).map((one) => one.holder.id)),
      ];
      const endedSessionIds = new Set(yield* sessionRows.listEndedForGood(idsHeldBy("session")));
      const deletedConversationIds = new Set(
        yield* subscriptions.listDeletedConversations(idsHeldBy("conversation")),
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
   * Stores the match as an input of the session that holds the subscription.
   * Returns the stored input, or `none` when the subscription already has one
   * for this event.
   */
  const storeOnSession = (subscription: StoredSubscription, event: Event) =>
    Effect.gen(function* () {
      return yield* sessions.storeMatchedInput({
        sessionId: subscription.holder.id,
        subscriptionId: subscription.id,
        eventId: event.id,
        actor: SYSTEM_ACTOR,
        text: renderEventInput(event),
        at: yield* nowIso,
      });
    });

  /**
   * Gives the match to the conversation that holds the subscription, by the
   * rule of where a conversation's input goes. Returns whether this call
   * stored an input: it does not when the subscription already has one for
   * this event, or when the conversation is gone, which the next pass's sweep
   * ends.
   *
   * A conversation that cannot take the input, for example because no runner
   * can start a session, loses this wake-up. That is recorded on the
   * subscription, and the pass goes on: failing the pass would retry the same
   * event forever. A database error does fail the pass, so it is retried.
   */
  const giveToConversation = (
    subscription: StoredSubscription,
    event: Event,
  ): Effect.Effect<boolean, SqlError> =>
    Effect.gen(function* () {
      const match = { subscriptionId: subscription.id, eventId: event.id };
      if (yield* inputs.hasMatchedInput(match)) return false;
      const conversation = yield* conversations.read(subscription.holder.id);
      if (Option.isNone(conversation)) return false;
      return yield* delivery
        .deliver({
          conversationId: conversation.value.id,
          assistantId: conversation.value.assistantId,
          source: "subscription",
          text: renderEventInput(event),
          match,
        })
        .pipe(
          Effect.as(true),
          Effect.catchIf(
            (error): error is Exclude<DeliveryError, SqlError> => !(error instanceof SqlError),
            (error) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("A subscription's wake-up could not be delivered", {
                  subscriptionId: subscription.id,
                  conversationId: subscription.holder.id,
                  eventId: event.id,
                  error,
                });
                yield* subscriptions.recordLostWakeUp(subscription.id, event.id, yield* nowIso);
                return false;
              }),
          ),
        );
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
              const stored =
                subscription.holder.kind === "conversation"
                  ? yield* giveToConversation(subscription, event)
                  : Option.isSome(yield* storeOnSession(subscription, event));
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
