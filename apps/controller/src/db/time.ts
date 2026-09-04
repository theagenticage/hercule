/**
 * The one clock read.
 *
 * Every timestamp the store writes is an ISO 8601 instant in UTC, taken from
 * `Clock` rather than from `Date.now` so a test can hold time still, and
 * spelled here rather than by hand at each call site.
 *
 * An operation that stamps a row and then records that row reads the clock once
 * and passes the value to both: two reads inside one operation are separated by
 * whatever the write in between took, and rows that describe the same change
 * would then disagree about when it happened. That is what the task and the
 * project operations do, by passing `at` to `AuditLog.append`.
 *
 * It is not yet what every operation does. A settings, profile, secret,
 * credential, user or setup mutation lets its audit entry time itself, so its
 * `received_at` can land a millisecond after the row it records. Both reads sit
 * inside the transaction, so the gap is the write's own duration and never a
 * queue wait; closing it is passing the row's stamp down, one call site at a
 * time. An entry for a change with no timestamp of its own - a delete, a login
 * - times itself here and has nothing to disagree with.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

/** The current instant, as the timestamp every column and payload carries. */
export const nowIso: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, (millis) =>
  new Date(millis).toISOString(),
);
