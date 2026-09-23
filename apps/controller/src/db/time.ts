/**
 * Reads the current time for everything the database stores.
 *
 * Every timestamp the database stores is an ISO 8601 instant in UTC. It comes
 * from `Clock` rather than from `Date.now`, so a test can hold time still, and
 * it is formatted here rather than by hand at each call site.
 *
 * An operation that stamps a row and then writes an audit entry for that row
 * should read the clock once and pass the value to both. Two reads inside one
 * operation are separated by however long the write in between took, so rows
 * that describe the same change would disagree about when it happened. The
 * task and project operations do this, by passing `at` to `AuditLog.append`.
 *
 * Not every operation does this yet. A settings, profile, secret, credential,
 * user or setup mutation lets its audit entry read the clock itself, so the
 * entry's `received_at` can be a millisecond after the row it records. Both
 * reads happen inside the transaction, so the gap is only the write's own
 * duration, never a queue wait. The fix is to pass the row's timestamp down,
 * one call site at a time. An entry for a change with no timestamp of its own,
 * such as a delete or a login, reads the clock here and has nothing to
 * disagree with.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

/** Returns the current time as an ISO 8601 string, the format every column and payload uses. */
export const nowIso: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, (millis) =>
  new Date(millis).toISOString(),
);
