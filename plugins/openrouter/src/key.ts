import { Schema } from "effect";
import type { ParseUsageBody, Timestamp, UsageReading } from "@hercule/plugin-host";

/**
 * The answer of OpenRouter's key endpoint (`GET /api/v1/key`), reduced to the
 * fields read here. The endpoint documents more (usage per day, per week, the
 * budgets, the rate limit) and Hercule shows none of it. Money is in US
 * dollars: `limit` is the most the key may spend, `limit_remaining` what is
 * left of it, and `usage` all it has spent.
 */
const KeyBody = Schema.Struct({
  data: Schema.Struct({
    /** The key's spending limit, or `null` for a key with none. */
    limit: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
    limit_remaining: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
    usage: Schema.Finite,
    /** When the key stops working, as an ISO-8601 date and time, or `null` or absent for a key that does not expire. */
    expires_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
});

const decodeKeyBody = Schema.decodeUnknownSync(KeyBody);

/** Converts the ISO-8601 date and time OpenRouter sends to a timestamp, or throws when it is not a date. */
const convertExpiry = (expiresAt: string): Timestamp => {
  const date = new Date(expiresAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `the OpenRouter key endpoint answered an expiry that is not a date: ${expiresAt}`,
    );
  }
  return date.toISOString();
};

/**
 * Turns the JSON answer of OpenRouter's key endpoint into a credit reading and
 * the key's expiry, stamping the reading with `takenAt`.
 *
 * - A key with a spending limit above zero gives one `credit` reading: `limit`
 *   is the spending limit, and `remaining` is `limit_remaining`, or the limit
 *   minus the usage when OpenRouter sends no remaining amount. `remaining` is
 *   never below zero, because a key may overspend its limit slightly.
 * - A key with no limit gives no reading. OpenRouter's account balance is not
 *   on this endpoint, and nothing is estimated in its place.
 * - `expiresAt` is `expires_at` as a timestamp, or `null` for a key that does
 *   not expire.
 *
 * Throws when the answer is not the documented shape. A refused key answers
 * HTTP 401 before this runs, so it never gives `{ refused }`.
 */
export const parseKeyBody: ParseUsageBody = (body, takenAt) => {
  const { data } = decodeKeyBody(body);
  const expiresAt =
    data.expires_at === null || data.expires_at === undefined
      ? null
      : convertExpiry(data.expires_at);
  const readings: Array<UsageReading> = [];
  if (data.limit !== null && data.limit !== undefined && data.limit > 0) {
    const remaining = data.limit_remaining ?? data.limit - data.usage;
    readings.push({
      kind: "credit",
      remaining: Math.max(0, remaining),
      limit: data.limit,
      takenAt,
    });
  }
  return { readings, expiresAt };
};
