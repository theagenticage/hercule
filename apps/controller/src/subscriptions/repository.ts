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

/** A subscription as it is stored. */
export interface StoredSubscription {
  readonly id: string;
  readonly holder: SubscriptionHolder;
  readonly target: SubscriptionTarget;
  readonly condition: string;
  /** The message of the run of evaluation failures this subscription is in, or null. */
  readonly healthErrorMessage: string | null;
  /** When that run of failures began, or null. */
  readonly healthErrorAt: string | null;
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
  readonly created_at: string;
}

const COLUMNS =
  "id, holder_kind, holder_id, target, condition, health_error_message, health_error_at, " +
  "created_at";

const toSubscription = (row: SubscriptionRow): StoredSubscription => ({
  id: uuidToString(row.id),
  holder: { kind: row.holder_kind as "session", id: uuidToString(row.holder_id) },
  target: JSON.parse(row.target) as SubscriptionTarget,
  condition: row.condition,
  healthErrorMessage: row.health_error_message,
  healthErrorAt: row.health_error_at,
  createdAt: row.created_at,
});

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
     * answers whether this failure began the run of failures it is in.
     *
     * Two writes rather than one: the first lands only while no failure is
     * recorded, so exactly one caller can be told it began the run, and the
     * second refreshes the message of a run that was already under way while
     * leaving the instant the run began where it is.
     */
    recordEvaluationFailure: (
      id: string,
      message: string,
      at: string,
    ): Effect.Effect<boolean, SqlError> =>
      Effect.gen(function* () {
        const began = yield* sql<{ readonly id: Uint8Array }>`
          UPDATE subscriptions SET health_error_message = ${message}, health_error_at = ${at}
          WHERE id = ${uuidFromString(id)} AND ended_at IS NULL AND health_error_message IS NULL
          RETURNING id`;
        if (began.length > 0) return true;
        yield* sql`
          UPDATE subscriptions SET health_error_message = ${message}
          WHERE id = ${uuidFromString(id)} AND ended_at IS NULL`;
        return false;
      }),

    /** Takes the recorded run of failures off a subscription that evaluated cleanly. */
    clearEvaluationFailure: (id: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`UPDATE subscriptions SET health_error_message = NULL, health_error_at = NULL
            WHERE id = ${uuidFromString(id)}`,
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
