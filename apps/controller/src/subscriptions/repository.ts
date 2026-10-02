/**
 * Subscription rows. This module only reads and writes them. Who may write,
 * what a target means and when a subscription may be ended are decided by the
 * service.
 *
 * A listing pages with a keyset over `created_at` and the id, filtered to one
 * holder, which the `subscriptions_holder` index serves. Only live rows are
 * read here: a listing shows what a session is still waiting for, and the
 * event router evaluates only what is still waiting.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SortDirection, SubscriptionHolder, SubscriptionTarget } from "@hercule/contract";
import {
  decodeCursor,
  encodeCursor,
  buildKeyset,
  mintUuid,
  buildPage,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

/** A subscription as it is stored. */
export interface StoredSubscription {
  readonly id: string;
  readonly holder: SubscriptionHolder;
  readonly target: SubscriptionTarget;
  readonly condition: string;
  /** The evaluator's error message for a condition it could not evaluate, or null. */
  readonly healthErrorMessage: string | null;
  /** When the evaluation error began, or null. */
  readonly healthErrorAt: string | null;
  /** The event of the wake-up a restart cancelled, or null. */
  readonly lostWakeUpEventId: number | null;
  /** When the restart cancelled it, or null. */
  readonly lostWakeUpAt: string | null;
  readonly createdAt: string;
}

/** The fields of a new subscription row. The repository generates the id. */
export interface NewSubscription {
  readonly holder: SubscriptionHolder;
  readonly target: SubscriptionTarget;
  readonly condition: string;
  /** The instant the row is created, which is its `createdAt`. */
  readonly at: string;
  readonly actor: string;
}

/** The fields needed to end one subscription. */
export interface SubscriptionEnd {
  readonly id: string;
  /** The instant it stopped waiting. */
  readonly at: string;
  /** Why it ended, as the row records it. */
  readonly reason: string;
  /** Who ended it: an actor stamp, or the system for a sweep. */
  readonly actor: string;
  /**
   * If set, ends the subscription only if this holder holds it. If absent,
   * ends it whoever holds it.
   */
  readonly heldBy?: SubscriptionHolder;
}

export interface SubscriptionPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  /** Whose subscriptions to list. A listing always covers one holder. */
  readonly holder: SubscriptionHolder;
}

interface SubscriptionRow {
  readonly id: Uint8Array;
  readonly holder_kind: string;
  readonly holder_id: Uint8Array;
  readonly target: string;
  readonly condition: string;
  readonly health_error_message: string | null;
  readonly health_error_at: string | null;
  readonly lost_wake_up_event_id: number | null;
  readonly lost_wake_up_at: string | null;
  readonly created_at: string;
}

const COLUMNS =
  "id, holder_kind, holder_id, target, condition, health_error_message, health_error_at, " +
  "lost_wake_up_event_id, lost_wake_up_at, created_at";

const toSubscription = (row: SubscriptionRow): StoredSubscription => ({
  id: uuidToString(row.id),
  holder: { kind: row.holder_kind as "session", id: uuidToString(row.holder_id) },
  target: JSON.parse(row.target) as SubscriptionTarget,
  condition: row.condition,
  healthErrorMessage: row.health_error_message,
  healthErrorAt: row.health_error_at,
  lostWakeUpEventId: row.lost_wake_up_event_id,
  lostWakeUpAt: row.lost_wake_up_at,
  createdAt: row.created_at,
});

const buildCursorScope = (direction: SortDirection): CursorScope => ({
  op: "subscription.query",
  sort: [{ field: "createdAt", direction }],
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    insert: (subscription: NewSubscription): Effect.Effect<string, SqlError> =>
      Effect.gen(function* () {
        const id = mintUuid();
        yield* sql`
          INSERT INTO subscriptions (id, holder_kind, holder_id, target, condition,
                                     created_at, actor)
          VALUES (${id}, ${subscription.holder.kind}, ${uuidFromString(subscription.holder.id)},
                  ${JSON.stringify(subscription.target)}, ${subscription.condition},
                  ${subscription.at}, ${subscription.actor})
        `;
        return uuidToString(id);
      }),

    /**
     * Returns every live subscription, oldest first. One pass of the event
     * router evaluates all of them, so the list is read whole rather than
     * paged: a subscription left out of the read would miss the event.
     */
    listLive: (): Effect.Effect<ReadonlyArray<StoredSubscription>, SqlError> =>
      Effect.map(
        sql<SubscriptionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM subscriptions
          WHERE ended_at IS NULL ORDER BY created_at, id`,
        (rows) => rows.map(toSubscription),
      ),

    /**
     * Records that this subscription's condition could not be evaluated.
     * Returns true if this failure started a new error, and false if an error
     * was already recorded.
     *
     * This takes two writes rather than one:
     *
     * - The first write succeeds only while no evaluation error is recorded,
     *   so exactly one caller learns that it started the error.
     * - The second write updates the message of an existing error and keeps
     *   the time the error began.
     */
    recordEvaluationFailure: (
      id: string,
      message: string,
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const began = yield* sql<{ readonly id: Uint8Array }>`
          UPDATE subscriptions SET health_error_message = ${message}, health_error_at = ${at}
          WHERE id = ${uuidFromString(id)} AND ended_at IS NULL
            AND health_error_message IS NULL
          RETURNING id`;
        if (began.length > 0) return true;
        yield* sql`
          UPDATE subscriptions SET health_error_message = ${message}
          WHERE id = ${uuidFromString(id)} AND ended_at IS NULL
            AND health_error_message IS NOT NULL`;
        return false;
      }),

    /** Clears the recorded evaluation error from a subscription that evaluated cleanly. */
    clearEvaluationFailure: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE subscriptions
            SET health_error_message = NULL, health_error_at = NULL
            WHERE id = ${uuidFromString(id)}`,
      ),

    /**
     * Records that the wake-up this subscription produced for this event was
     * lost, so a reader of the subscription learns why nothing arrived. An
     * older lost wake-up is overwritten, because the holder is still waiting
     * on the newest one.
     *
     * An ended subscription is left unchanged: nobody holds it any more, so
     * there is nobody left to tell.
     */
    recordLostWakeUp: (id: string, eventId: number, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE subscriptions
            SET lost_wake_up_event_id = ${eventId}, lost_wake_up_at = ${at}
            WHERE id = ${uuidFromString(id)} AND ended_at IS NULL`,
      ),

    /**
     * Clears the lost wake-up from a subscription that has just been woken
     * again. The lost wake-up records that one event was lost, and only a
     * later wake-up makes that record out of date.
     */
    clearLostWakeUp: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE subscriptions
            SET lost_wake_up_event_id = NULL, lost_wake_up_at = NULL
            WHERE id = ${uuidFromString(id)}`,
      ),

    /**
     * Ends the subscription, recording why and who ended it. Returns true if
     * there was a live subscription to end.
     *
     * `heldBy` limits the write to one holder's rows. A caller that may end
     * only its own subscriptions passes it, and gets `false` for a
     * subscription another holder holds, the same result as for one that
     * never existed.
     */
    end: (ending: SubscriptionEnd): Effect.Effect<boolean, SqlError> => {
      const clauses = [
        sql`id = ${uuidFromString(ending.id)}`,
        sql`ended_at IS NULL`,
        ...(ending.heldBy === undefined
          ? []
          : [
              sql`holder_kind = ${ending.heldBy.kind}`,
              sql`holder_id = ${uuidFromString(ending.heldBy.id)}`,
            ]),
      ];
      return Effect.map(
        sql<{ readonly id: Uint8Array }>`
          UPDATE subscriptions
          SET ended_at = ${ending.at}, ended_reason = ${ending.reason},
              ended_actor = ${ending.actor}
          WHERE ${sql.and(clauses)} RETURNING id`,
        (rows) => rows.length > 0,
      );
    },

    list: (
      request: SubscriptionPageRequest,
    ): Effect.Effect<Page<StoredSubscription>, CursorError | SqlError> =>
      Effect.gen(function* () {
        const scope = buildCursorScope(request.direction);
        const after =
          request.cursor === undefined
            ? undefined
            : yield* decodeCursor(request.cursor, scope, ["string"]);
        const { keyset, order } = buildKeyset(
          sql,
          [{ column: "created_at", direction: request.direction }],
          ["id"],
          after === undefined ? undefined : [...after.values, uuidFromString(after.id)],
        );
        const rows = yield* sql<SubscriptionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM subscriptions
          WHERE ${keyset} AND ended_at IS NULL
            AND holder_kind = ${request.holder.kind}
            AND holder_id = ${uuidFromString(request.holder.id)}
          ${order} LIMIT ${request.limit + 1}
        `;
        return yield* buildPage(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toSubscription)),
          (last) => encodeCursor(scope, [last.createdAt], last.id),
        );
      }),
  };
});

/** Everything the subscription service reads and writes. */
export const subscriptionRepository = make;
