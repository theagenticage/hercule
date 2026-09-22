/**
 * Subscription rows. This module only reads and writes them. Who may write,
 * what a target means and when a subscription may be ended are the service's
 * questions.
 *
 * A listing is one keyset walk over `created_at` and the id, narrowed to one
 * holder, which `subscriptions_holder` serves. Only live rows are read here at
 * all: a listing says what a session is still waiting for, and the event router
 * evaluates what is still waiting.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { SortDirection, SubscriptionHolder, SubscriptionTarget } from "@hercule/contract";
import {
  decodeCursor,
  encodeCursor,
  keysetOver,
  mintUuid,
  pageOf,
  uuidFromString,
  uuidToString,
  type CursorError,
  type CursorScope,
  type Page,
} from "../db";

/**
 * The two errors a subscription can carry. An evaluation error is taken off by
 * the next event that evaluates cleanly; a lost wake-up stands until a wake-up
 * for this subscription is written. The column holds these spellings, so a row
 * is read without a mapping.
 */
export type HealthErrorKind = "evaluation" | "lost-wake-up";

/** A subscription as it is stored. */
export interface StoredSubscription {
  readonly id: string;
  readonly holder: SubscriptionHolder;
  readonly target: SubscriptionTarget;
  readonly condition: string;
  /** What stands between this subscription and its events, or null. */
  readonly healthErrorMessage: string | null;
  /** When that error began, or null. */
  readonly healthErrorAt: string | null;
  /** Which error it is, because the two end differently, or null. */
  readonly healthErrorKind: HealthErrorKind | null;
  readonly createdAt: string;
}

/** Everything a new subscription row holds; the id and the instant are written here. */
export interface NewSubscription {
  readonly holder: SubscriptionHolder;
  readonly target: SubscriptionTarget;
  readonly condition: string;
  /** The instant the row is created, which is its `createdAt`. */
  readonly at: string;
  readonly actor: string;
}

/** What ends one subscription. */
export interface SubscriptionEnd {
  readonly id: string;
  /** The instant it stopped waiting. */
  readonly at: string;
  /** What ended it, as the row records it. */
  readonly reason: string;
  /** Who ended it: an actor stamp, or the system for a sweep. */
  readonly actor: string;
  /** Only end it if this holder holds it; absent ends it whoever holds it. */
  readonly heldBy?: SubscriptionHolder;
}

export interface SubscriptionPageRequest {
  readonly limit: number;
  readonly cursor: string | undefined;
  readonly direction: SortDirection;
  /** Whose subscriptions to walk. A listing is always about one holder. */
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
  readonly health_error_kind: HealthErrorKind | null;
  readonly created_at: string;
}

const COLUMNS =
  "id, holder_kind, holder_id, target, condition, health_error_message, health_error_at, " +
  "health_error_kind, created_at";

const toSubscription = (row: SubscriptionRow): StoredSubscription => ({
  id: uuidToString(row.id),
  holder: { kind: row.holder_kind as "session", id: uuidToString(row.holder_id) },
  target: JSON.parse(row.target) as SubscriptionTarget,
  condition: row.condition,
  healthErrorMessage: row.health_error_message,
  healthErrorAt: row.health_error_at,
  healthErrorKind: row.health_error_kind,
  createdAt: row.created_at,
});

/**
 * Why a subscription is in error after a restart. A wake-up that was sent and
 * never acknowledged is cancelled, and the pair of subscription and event can
 * never be written again, so the event is named: it is the one fact the holder
 * cannot get back from Hercule.
 */
const buildLostWakeUpReason = (eventId: number): string =>
  `the wake-up for event ${String(eventId)} was sent but not acknowledged before a restart ` +
  `and was cancelled; the event will not be delivered again`;

const buildCursorScope = (direction: SortDirection): CursorScope => ({
  op: "subscription.query",
  field: "createdAt",
  direction,
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
     * Every subscription still waiting, oldest first. This is what one pass of
     * the event router evaluates, so it is read whole rather than paged: a
     * subscription left out of the read is an event that reaches nobody.
     */
    listLive: (): Effect.Effect<ReadonlyArray<StoredSubscription>, SqlError> =>
      Effect.map(
        sql<SubscriptionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM subscriptions
          WHERE ended_at IS NULL ORDER BY created_at, id`,
        (rows) => rows.map(toSubscription),
      ),

    /**
     * Records that this subscription's condition could not be evaluated, and
     * answers whether this failure began the error it is in.
     *
     * Two writes rather than one: the first lands only while no evaluation
     * error is recorded, so exactly one caller can be told it began the error,
     * and the second refreshes the message of an error that was already
     * standing while leaving the instant it began where it is.
     *
     * A lost wake-up is written over, and the caller is told the error began.
     * A subscription whose condition cannot be evaluated can wake its holder
     * for nothing at all, so that is the error the holder must act on, and the
     * report of it must go out; the lost wake-up says one event was missed,
     * which is moot until the condition works again.
     */
    recordEvaluationFailure: (
      id: string,
      message: string,
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const began = yield* sql<{ readonly id: Uint8Array }>`
          UPDATE subscriptions SET health_error_message = ${message}, health_error_at = ${at},
                                   health_error_kind = 'evaluation'
          WHERE id = ${uuidFromString(id)} AND ended_at IS NULL
            AND health_error_kind IS NOT 'evaluation'
          RETURNING id`;
        if (began.length > 0) return true;
        yield* sql`
          UPDATE subscriptions SET health_error_message = ${message}
          WHERE id = ${uuidFromString(id)} AND ended_at IS NULL
            AND health_error_kind = 'evaluation'`;
        return false;
      }),

    /**
     * Records that the one wake-up this subscription produced for this event
     * was lost, so a reader of the subscription learns why nothing arrived.
     *
     * A row already ended is left alone: a subscription nobody holds any more
     * has no health to show. A standing evaluation error is left alone too,
     * for the reason `recordEvaluationFailure` gives: a condition that cannot
     * be evaluated is what the holder must act on first, and a missed event is
     * moot while it stands.
     */
    recordLostWakeUp: (id: string, eventId: number, at: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE subscriptions
            SET health_error_message = ${buildLostWakeUpReason(eventId)},
                health_error_at = ${at}, health_error_kind = 'lost-wake-up'
            WHERE id = ${uuidFromString(id)} AND ended_at IS NULL
              AND health_error_kind IS NOT 'evaluation'`,
      ),

    /**
     * Takes the recorded evaluation error off a subscription that evaluated
     * cleanly. A lost wake-up is left where it is: no evaluation says anything
     * about an event that was already taken off the wire.
     */
    clearEvaluationFailure: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE subscriptions
            SET health_error_message = NULL, health_error_at = NULL, health_error_kind = NULL
            WHERE id = ${uuidFromString(id)} AND health_error_kind = 'evaluation'`,
      ),

    /**
     * Takes a lost wake-up off a subscription that has just been woken again.
     * The message says one event was lost; a wake-up written after it is what
     * makes that out of date, and nothing else is.
     */
    clearLostWakeUp: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE subscriptions
            SET health_error_message = NULL, health_error_at = NULL, health_error_kind = NULL
            WHERE id = ${uuidFromString(id)} AND health_error_kind = 'lost-wake-up'`,
      ),

    /**
     * Stops the subscription waiting, naming what ended it and who ended it,
     * and answers whether there was a live subscription to end.
     *
     * `heldBy` narrows the write to one holder's own rows. A caller that may
     * end only what it holds passes it and reads `false` for a subscription
     * that is another holder's, which is the same answer as for one that never
     * existed.
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
            : yield* decodeCursor(request.cursor, scope, "string");
        const { keyset, order } = keysetOver(
          sql,
          ["created_at", "id"],
          after === undefined ? undefined : [after[0], uuidFromString(after[1])],
          request.direction,
        );
        const rows = yield* sql<SubscriptionRow>`
          SELECT ${sql.literal(COLUMNS)} FROM subscriptions
          WHERE ${keyset} AND ended_at IS NULL
            AND holder_kind = ${request.holder.kind}
            AND holder_id = ${uuidFromString(request.holder.id)}
          ${order} LIMIT ${request.limit + 1}
        `;
        return yield* pageOf(
          rows,
          request.limit,
          (page) => Effect.succeed(page.map(toSubscription)),
          (last) => encodeCursor(scope, last.createdAt, last.id),
        );
      }),
  };
});

/** Everything the subscription service reads and writes. */
export const subscriptionRepository = make;
