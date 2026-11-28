import { Schema } from "effect";
import type { ParseUsageBody, Timestamp, UsageReading } from "@hercule/plugin-host";

const OptionalNumber = Schema.optionalKey(Schema.NullOr(Schema.Finite));

/**
 * One entry of the answer's `model_remains`: the plan's limits for one model
 * family. Every field but the name is optional, because newer plans send
 * different fields than older ones and a field we do not read must not fail
 * the answer.
 */
const ModelRemain = Schema.Struct({
  model_name: Schema.String,
  /** When the five-hour window ends, in milliseconds since the epoch. */
  end_time: OptionalNumber,
  /** Newer plans send this instead of `end_time`: the milliseconds left in the window. */
  remains_time: OptionalNumber,
  current_interval_total_count: OptionalNumber,
  /** Despite its name, the count that is left in the window, not the count used. */
  current_interval_usage_count: OptionalNumber,
  current_interval_remaining_percent: OptionalNumber,
  /** 1 is normal, 2 is exhausted, 3 is unlimited. */
  current_interval_status: OptionalNumber,
  /** When the weekly window ends, in milliseconds since the epoch. */
  weekly_end_time: OptionalNumber,
  /** Newer plans send this instead of `weekly_end_time`: the milliseconds left in the weekly window. */
  weekly_remains_time: OptionalNumber,
  current_weekly_total_count: OptionalNumber,
  /** Despite its name, the count that is left in the window, not the count used. */
  current_weekly_usage_count: OptionalNumber,
  current_weekly_remaining_percent: OptionalNumber,
  /** 1 is normal, 2 is exhausted, 3 is unlimited. */
  current_weekly_status: OptionalNumber,
});

type ModelRemain = Schema.Schema.Type<typeof ModelRemain>;

/** The answer of MiniMax's plan usage endpoint. Errors are HTTP 200 with a non-zero `status_code`. */
const PlanUsageBody = Schema.Struct({
  base_resp: Schema.Struct({
    status_code: Schema.Number,
    status_msg: Schema.optionalKey(Schema.String),
  }),
  model_remains: Schema.optionalKey(Schema.Array(ModelRemain)),
});

const decodePlanUsageBody = Schema.decodeUnknownSync(PlanUsageBody);

/**
 * The status codes that mean MiniMax refused the key, from its error code list
 * (https://platform.minimax.io/docs/api-reference/errorcode): `1004` (not
 * authorized) and `2049` (invalid API key). `2057` is handled on its own.
 *
 * Not here: `2062`, "no active M Plan subscription". The key may be fine and the
 * subscription lapsed or not started, which is not told apart yet, so it is
 * thrown like any other failure and the account keeps its last readings.
 */
const KEY_REFUSED_CODES: ReadonlySet<number> = new Set([1004, 2049]);

/** Code 2057, "not token plan token": the key is a pay-as-you-go key, which this endpoint refuses. */
const PAY_AS_YOU_GO_KEY_CODE = 2057;

/** What the user reads for code 2057. MiniMax's own words do not say what to do. */
const PAY_AS_YOU_GO_KEY_REFUSAL =
  "This is a pay-as-you-go key, not a plan key. Add it to MiniMax as a pay-as-you-go key.";

const STATUS_EXHAUSTED = 2;
const STATUS_UNLIMITED = 3;

/** The row name newer plans use for the text models. */
const GENERAL_MODEL_NAME = "general";

/** The row names older plans use for the text models: `MiniMax-M*`. */
const TEXT_MODEL_PREFIX = "MiniMax-M";

/** Converts milliseconds since the epoch to a timestamp, or `null` when there is none or it is out of range. */
const convertEpochMillis = (millis: number | null | undefined): Timestamp | null => {
  if (millis === null || millis === undefined) return null;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/**
 * Returns when a window resets: `endTime` when MiniMax sent it, otherwise
 * `takenAt` plus `remainingMillis`, otherwise `null`.
 */
const readResetTime = (
  endTime: number | null | undefined,
  remainingMillis: number | null | undefined,
  takenAt: Timestamp,
): Timestamp | null => {
  if (endTime !== null && endTime !== undefined) return convertEpochMillis(endTime);
  if (remainingMillis === null || remainingMillis === undefined) return null;
  return convertEpochMillis(Date.parse(takenAt) + remainingMillis);
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
    readonly remainingMillis: number | null | undefined;
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
    resetsAt: readResetTime(fields.endTime, fields.remainingMillis, takenAt),
    hit: usedPercent >= 100,
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
        remainingMillis: row.remains_time,
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
        remainingMillis: row.weekly_remains_time,
      },
      takenAt,
    ),
  ].filter((reading) => reading !== undefined);

/**
 * Turns the JSON answer of MiniMax's plan usage endpoint into readings,
 * stamping each with `takenAt`.
 *
 * - Only the text model row is read: `general` on newer plans, `MiniMax-M*` on
 *   older ones, and `general` wins when both are present. The image, speech and
 *   video rows have limits of their own and are not shown.
 * - The two windows are the five-hour and the weekly one.
 * - `*_usage_count` holds the count that is LEFT, despite its name. A
 *   `*_remaining_percent` is preferred over the counts.
 * - Status 3 (unlimited) gives no reading. Status 2 (exhausted) is 100 percent
 *   and hit.
 * - `resetsAt` is the end time, or `takenAt` plus the milliseconds left on
 *   newer plans, or `null` when neither is sent.
 *
 * Returns `{ refused }` for a key MiniMax refuses (see `KEY_REFUSED_CODES`),
 * with MiniMax's message, or with our own text for a pay-as-you-go key. Throws
 * on an unexpected shape or a failure that says nothing about the key, such as
 * 2062: the account then keeps its last readings.
 */
export const parsePlanUsageBody: ParseUsageBody = (body, takenAt) => {
  const answer = decodePlanUsageBody(body);
  const { status_code: code, status_msg: message } = answer.base_resp;
  if (code !== 0) {
    if (code === PAY_AS_YOU_GO_KEY_CODE) return { refused: PAY_AS_YOU_GO_KEY_REFUSAL };
    if (KEY_REFUSED_CODES.has(code)) return { refused: message ?? "Not authorized" };
    throw new Error(
      `the MiniMax usage endpoint answered status_code ${code}${message === undefined ? "" : `: ${message}`}`,
    );
  }
  if (answer.model_remains === undefined) {
    throw new Error("the MiniMax usage endpoint answered success without model_remains");
  }
  const textRow =
    answer.model_remains.find((row) => row.model_name === GENERAL_MODEL_NAME) ??
    answer.model_remains.find((row) => row.model_name.startsWith(TEXT_MODEL_PREFIX));
  return { readings: textRow === undefined ? [] : readTextModelWindows(textRow, takenAt) };
};
