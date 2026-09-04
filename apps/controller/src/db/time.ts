/**
 * The one clock read.
 *
 * Every timestamp the store writes is an ISO 8601 instant in UTC, taken from
 * `Clock` rather than from `Date.now` so a test can hold time still. An
 * operation reads it once and stamps every row and every event of that
 * operation with the same value: two reads inside one operation are separated
 * by whatever the writes in between took, and rows that describe the same
 * change would then disagree about when it happened.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

/** The current instant, as the timestamp every column and payload carries. */
export const nowIso: Effect.Effect<string> = Effect.map(Clock.currentTimeMillis, (millis) =>
  new Date(millis).toISOString(),
);
