/**
 * The subscription a session holds on its own Permission Request.
 *
 * `permission.request` opens it inside the transaction that stores the
 * request, so the asking session is told the decision as queued input. It
 * waits for one event, the decision, so it ends in one of two ways:
 *
 * - the session routing table ends it once the decision is written as the
 *   session's input;
 * - ending the session ends it, in the transaction that withdraws the open
 *   request, because no decision will come.
 *
 * Deciding does not end it: the decision is delivered through it after the
 * deciding transaction commits.
 *
 * No grant is checked here: the only caller that opens one is
 * `permission.request`, which needs no grant, because asking is never
 * forbidden.
 */
import * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { currentStamp, SYSTEM_ACTOR } from "../actor";
import { nowIso } from "../db";
import { subscriptionRepository } from "./repository";
import { expandTarget } from "./targets";

/** Why a request's subscription ends once the decision reached the session. */
const DECISION_DELIVERED =
  "the Permission Request was decided, and the decision was queued as the session's input";

/** Why a request's subscription ends when its session ends with the request still open. */
const REQUEST_WITHDRAWN =
  "the session ended before the Permission Request was decided, so the request was withdrawn";

const make = Effect.gen(function* () {
  const subscriptions = yield* subscriptionRepository;

  return {
    /**
     * Opens the session's subscription on the decision of its request, and
     * returns the subscription's id. Joins the caller's transaction.
     */
    open: (sessionId: string, requestId: string, at: string): Effect.Effect<string, SqlError> =>
      Effect.gen(function* () {
        const target = { kind: "request", requestId } as const;
        return yield* subscriptions.insert({
          holder: { kind: "session", id: sessionId },
          target,
          condition: expandTarget(target),
          at,
          actor: yield* currentStamp,
        });
      }),

    /**
     * Ends a request's subscription after its decision was stored as the
     * session's input. Joins the caller's transaction.
     */
    endDelivered: (subscriptionId: string): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        // The event router ends it, on nobody's behalf.
        yield* subscriptions.end({
          id: subscriptionId,
          at: yield* nowIso,
          reason: DECISION_DELIVERED,
          actor: SYSTEM_ACTOR,
        });
      }),

    /**
     * Ends the subscriptions these sessions hold on these withdrawn requests.
     * Joins the caller's transaction. The sessions' other subscriptions stay
     * live, because an exited session can still be resumed.
     */
    endWithdrawn: (
      sessionIds: ReadonlyArray<string>,
      requestIds: ReadonlyArray<string>,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        yield* subscriptions.endWaitingOnRequests(sessionIds, requestIds, {
          at: yield* nowIso,
          reason: REQUEST_WITHDRAWN,
          actor: SYSTEM_ACTOR,
        });
      }),
  };
});

/** Builds the operations on the subscriptions sessions hold on their own Permission Requests. */
export const permissionRequestSubscriptions: Effect.Effect<
  Effect.Success<typeof make>,
  never,
  SqlClient.SqlClient
> = make;
