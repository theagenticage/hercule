import { Schema } from "effect";
import type { ParseUsageBody, Timestamp, UsageReading } from "@hercule/plugin-host";

/**
 * One entry of the quota answer's `data.limits`. Only `type` is required:
 * Z.ai sends other kinds of entry (MCP time, credit) with fewer fields, and an
 * entry we do not read must not fail the whole answer.
 */
const QuotaLimit = Schema.Struct({
  type: Schema.String,
  /** The unit of the window length: 3 hours, 5 months, 6 weeks. */
  unit: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  /** How many `unit`s the window lasts. */
  number: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  /** The share of the window used, in percent. */
  percentage: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  /** When the window resets, in milliseconds since the epoch. */
  nextResetTime: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
});

/**
 * The answer of Z.ai's quota endpoint. Errors come back as HTTP 200 with
 * `success: false` and a business `code`, so the same shape holds both.
 */
const QuotaBody = Schema.Struct({
  code: Schema.Number,
  msg: Schema.optionalKey(Schema.String),
  success: Schema.Boolean,
  data: Schema.optionalKey(Schema.Struct({ limits: Schema.Array(QuotaLimit) })),
});

const decodeQuotaBody = Schema.decodeUnknownSync(QuotaBody);

/**
 * The business codes that mean Z.ai refused the key. Z.ai answers a refused
 * key with HTTP 200 and `success: false` (checked live with a bogus key on
 * 2026-10-31): `401` "token expired or incorrect" for a key that does not
 * work, and from the documented list (https://docs.z.ai/api-reference/api-code)
 * `1000` "Authentication Failed" and `1003` "Authentication Token expired".
 *
 * Not here:
 *
 * - `1001`, "Authentication parameter not received in Header". The request had
 *   no `Authorization` header, which is Hercule's own defect, so it must never
 *   mark a good key as failed.
 * - `1005`, two-factor authentication needed. The key is not refused.
 */
const KEY_REFUSED_CODES: ReadonlySet<number> = new Set([401, 1000, 1003]);

const UNIT_HOURS = 3;
const UNIT_WEEKS = 6;

/** Returns which window a `TOKENS_LIMIT` entry is, or `undefined` for a length Hercule does not show. */
const findWindow = (unit: number | null | undefined, number: number | null | undefined) => {
  if (unit === UNIT_HOURS && number === 5) return "five-hour" as const;
  if (unit === UNIT_WEEKS) return "weekly" as const;
  return undefined;
};

/** Converts milliseconds since the epoch to a timestamp, or `null` when there is none or it is out of range. */
const convertResetTime = (millis: number | null | undefined): Timestamp | null => {
  if (millis === null || millis === undefined) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Turns the JSON answer of Z.ai's quota endpoint
 * (`GET /api/monitor/usage/quota/limit`) into readings, stamping each with
 * `takenAt`.
 *
 * - `TOKENS_LIMIT` with unit 3 (hours) and number 5 is the five-hour window,
 *   and `TOKENS_LIMIT` with unit 6 (weeks) is the weekly window.
 * - Every other entry is dropped: the MCP time limit (`TIME_LIMIT`) and the
 *   Team plan's `CREDIT_LIMIT` are not shown yet.
 * - An entry with no `percentage` gives no reading, because a missing number
 *   must not show as an empty window.
 * - `usedPercent` is `percentage` limited to 0-100, `hit` is 100 or more, and
 *   `resetsAt` is `nextResetTime`, or `null` when Z.ai sent none.
 *
 * Returns `{ refused }` with Z.ai's own message when the answer says the key
 * is refused (see `KEY_REFUSED_CODES`). Throws when the answer is not the documented shape,
 * or is a failure that says nothing about the key (a rate limit, or code 1001): the
 * caller logs that and leaves the account as it is.
 */
export const parseQuotaBody: ParseUsageBody = (body, takenAt) => {
  const quota = decodeQuotaBody(body);
  if (!quota.success) {
    if (KEY_REFUSED_CODES.has(quota.code)) {
      return { refused: quota.msg ?? "Authentication Failed" };
    }
    throw new Error(
      `the Z.ai quota endpoint answered code ${quota.code}${quota.msg === undefined ? "" : `: ${quota.msg}`}`,
    );
  }
  if (quota.data === undefined) {
    throw new Error("the Z.ai quota endpoint answered success without data");
  }
  const readings: Array<UsageReading> = [];
  for (const limit of quota.data.limits) {
    if (limit.type !== "TOKENS_LIMIT") continue;
    const window = findWindow(limit.unit, limit.number);
    if (window === undefined || limit.percentage === null || limit.percentage === undefined) {
      continue;
    }
    const usedPercent = Math.min(100, Math.max(0, limit.percentage));
    readings.push({
      kind: "window",
      window,
      usedPercent,
      resetsAt: convertResetTime(limit.nextResetTime),
      hit: limit.percentage >= 100,
      takenAt,
    });
  }
  return { readings };
};
