import { Schema } from "effect";
import type { ParseUsageBody, Timestamp, UsageReading } from "@hercule/plugin-host";

const OptionalNumber = Schema.optionalKey(Schema.NullOr(Schema.Finite));

/**
 * One entry of the answer's `model_remains`: the plan's limits for one model
 * family. Every field is optional except the name, because MiniMax adds
 * fields over time (the status and percent fields only exist on newer plans)
 * and a field we do not read must not fail the whole answer.
 */
const ModelRemain = Schema.Struct({
  model_name: Schema.String,
  /** When the short window ends, in milliseconds since the epoch. */
  end_time: OptionalNumber,
  current_interval_total_count: OptionalNumber,
  /** Despite its name, the count that is left in the window, not the count used. */
  current_interval_usage_count: OptionalNumber,
  current_interval_remaining_percent: OptionalNumber,
  /** 1 is normal, 2 is exhausted, 3 is unlimited. */
  current_interval_status: OptionalNumber,
  /** When the weekly window ends, in milliseconds since the epoch. */
  weekly_end_time: OptionalNumber,
  current_weekly_total_count: OptionalNumber,
  /** Despite its name, the count that is left in the window, not the count used. */
  current_weekly_usage_count: OptionalNumber,
  current_weekly_remaining_percent: OptionalNumber,
  /** 1 is normal, 2 is exhausted, 3 is unlimited. */
  current_weekly_status: OptionalNumber,
});

type ModelRemain = Schema.Schema.Type<typeof ModelRemain>;

/**
 * The answer of MiniMax's plan usage endpoint. Errors come back as HTTP 200
 * with a non-zero `base_resp.status_code`, so the same shape holds both.
 */
const RemainsBody = Schema.Struct({
  base_resp: Schema.Struct({
    status_code: Schema.Number,
    status_msg: Schema.optionalKey(Schema.String),
  }),
  model_remains: Schema.optionalKey(Schema.Array(ModelRemain)),
});

const decodeRemainsBody = Schema.decodeUnknownSync(RemainsBody);

/**
 * The status codes that mean MiniMax refused the key, from its error code
 * list (https://platform.minimax.io/docs/api-reference/errorcode):
 *
 * - `1004`, not authorized. A request with a bogus key got exactly this on
 *   2026-10-31, as HTTP 200.
 * - `2049`, invalid API key.
 * - `2057`, "not token plan token": the key is a pay-as-you-go key, and this
 *   endpoint needs a plan key.
 *
 * Not here: `2062`, "no active M Plan subscription when querying usage". The
 * key may be fine and the subscription lapsed or not started, which Hercule
 * does not tell apart yet, so it is thrown like any other failure.
 */
const KEY_REFUSED_CODES: ReadonlySet<number> = new Set([1004, 2049, 2057]);

const STATUS_EXHAUSTED = 2;
const STATUS_UNLIMITED = 3;

/** The model family the text models belong to, which is the only row Hercule shows: `MiniMax-M*`. */
const TEXT_MODEL_PREFIX = "MiniMax-M";

/** Converts milliseconds since the epoch to a timestamp, or `null` when there is none or it is out of range. */
const convertResetTime = (millis: number | null | undefined): Timestamp | null => {
  if (millis === null || millis === undefined) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Returns the reading of one window, or `undefined` when MiniMax gave nothing
 * to show: an unlimited window, or one with neither a remaining percent nor a
 * total to work it out from. A missing number must not show as an empty window.
 *
 * `usedPercent` is 100 minus `remainingPercent` when MiniMax sent it, and
 * otherwise 100 minus `remainingCount` as a share of `total`.
 */
const readWindow = (
  window: "five-hour" | "weekly",
  fields: {
    readonly total: number | null | undefined;
    readonly remainingCount: number | null | undefined;
    readonly remainingPercent: number | null | undefined;
    readonly status: number | null | undefined;
    readonly endTime: number | null | undefined;
  },
  takenAt: Timestamp,
): UsageReading | undefined => {
  if (fields.status === STATUS_UNLIMITED) return undefined;
  let usedPercent: number;
  if (fields.status === STATUS_EXHAUSTED) {
    usedPercent = 100;
  } else if (fields.remainingPercent !== null && fields.remainingPercent !== undefined) {
    usedPercent = 100 - fields.remainingPercent;
  } else if (
    fields.total !== null &&
    fields.total !== undefined &&
    fields.total > 0 &&
    fields.remainingCount !== null &&
    fields.remainingCount !== undefined
  ) {
    usedPercent = 100 - (fields.remainingCount / fields.total) * 100;
  } else {
    return undefined;
  }
  return {
    kind: "window",
    window,
    usedPercent: Math.min(100, Math.max(0, usedPercent)),
    resetsAt: convertResetTime(fields.endTime),
    hit: fields.status === STATUS_EXHAUSTED || usedPercent >= 100,
    takenAt,
  };
};

/** Returns the readings of the five-hour and weekly windows of one row, leaving out a window that has none. */
const readTextModelWindows = (row: ModelRemain, takenAt: Timestamp): Array<UsageReading> =>
  [
    readWindow(
      "five-hour",
      {
        total: row.current_interval_total_count,
        remainingCount: row.current_interval_usage_count,
        remainingPercent: row.current_interval_remaining_percent,
        status: row.current_interval_status,
        endTime: row.end_time,
      },
      takenAt,
    ),
    readWindow(
      "weekly",
      {
        total: row.current_weekly_total_count,
        remainingCount: row.current_weekly_usage_count,
        remainingPercent: row.current_weekly_remaining_percent,
        status: row.current_weekly_status,
        endTime: row.weekly_end_time,
      },
      takenAt,
    ),
  ].filter((reading) => reading !== undefined);

/**
 * Turns the JSON answer of MiniMax's plan usage endpoint
 * (`GET /v1/token_plan/remains`) into readings, stamping each with `takenAt`.
 *
 * - Only the text model row (`MiniMax-M*`) is read. The image, speech and
 *   video rows have limits of their own and are not shown, and counting them
 *   too would count the same plan twice.
 * - The short window is the five-hour window and the long one is the weekly
 *   window. MiniMax's plan FAQ gives them as five hours and seven days, and
 *   the fields of an official sample answer span exactly five hours.
 * - A window with status 3 (unlimited), or with no percent and a total of 0,
 *   gives no reading. Status 2 (exhausted) is a window that is used up and hit.
 * - `*_usage_count` holds the count that is left, in spite of its name, as
 *   MiniMax's own command line tool reads it. The `*_remaining_percent`
 *   fields, where a plan sends them, are preferred over the counts.
 * - `resetsAt` is the window's end time, or `null` when MiniMax sent none.
 *
 * Returns `{ refused }` with MiniMax's own message when the answer says the
 * key is refused (see `KEY_REFUSED_CODES`). Throws when the answer is not the
 * documented shape, or is a failure that says nothing about the key: the
 * caller logs that and leaves the account as it is.
 */
export const parseRemainsBody: ParseUsageBody = (body, takenAt) => {
  const answer = decodeRemainsBody(body);
  const { status_code: code, status_msg: message } = answer.base_resp;
  if (code !== 0) {
    if (KEY_REFUSED_CODES.has(code)) return { refused: message ?? "Not authorized" };
    throw new Error(
      `the MiniMax usage endpoint answered status_code ${code}${message === undefined ? "" : `: ${message}`}`,
    );
  }
  if (answer.model_remains === undefined) {
    throw new Error("the MiniMax usage endpoint answered success without model_remains");
  }
  const textRow = answer.model_remains.find((row) => row.model_name.startsWith(TEXT_MODEL_PREFIX));
  return { readings: textRow === undefined ? [] : readTextModelWindows(textRow, takenAt) };
};
