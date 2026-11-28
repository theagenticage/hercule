/**
 * How long a failed read of an outside thing waits before it is tried again.
 * A ref that could not be read and a pending claim that could not be placed
 * share the same wait: 120 seconds, doubling with each failure, at most 6 hours.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

/** How long a failed read waits before the first retry. Each failure doubles it. */
const RETRY_BASE_SECONDS = 120;

/** The longest a failed read waits before a retry. */
const RETRY_CAP_SECONDS = 6 * 60 * 60;

/**
 * Returns the seconds a ref waits before it may be read again, after
 * `attemptCount` failed reads: 120 seconds, doubling, at most 6 hours.
 */
export const computeRetryDelaySeconds = (attemptCount: number): number =>
  Math.min(RETRY_CAP_SECONDS, RETRY_BASE_SECONDS * 2 ** Math.min(attemptCount, 16));

/**
 * Records that pending claims could not be placed this time, and when each
 * may be tried again, in one statement. Each claim waits as long as its own
 * attempts say. Joins the caller's transaction.
 */
export const postponeClaims = (
  sql: SqlClient.SqlClient,
  postponed: ReadonlyArray<{ readonly id: number; readonly resolve_attempts: number }>,
  now: string,
): Effect.Effect<void, SqlError> =>
  postponed.length === 0
    ? Effect.void
    : Effect.asVoid(sql`
        UPDATE external_entity_relation_claims
        SET resolve_attempts = u.attempts, next_resolve_at = u.next_resolve_at
        FROM (
          SELECT json_extract(value, '$.id') AS id,
                 json_extract(value, '$.attempts') AS attempts,
                 json_extract(value, '$.nextResolveAt') AS next_resolve_at
          FROM json_each(${JSON.stringify(
            postponed.map((claim) => ({
              id: claim.id,
              attempts: claim.resolve_attempts + 1,
              nextResolveAt: new Date(
                Date.parse(now) + computeRetryDelaySeconds(claim.resolve_attempts) * 1000,
              ).toISOString(),
            })),
          )})
        ) AS u
        WHERE external_entity_relation_claims.id = u.id`);
