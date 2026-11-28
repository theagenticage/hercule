/**
 * Reads the blocks the Inbox pane draws for one Sentry issue: the events of
 * the last 14 days, a few facts about the issue, and the stack trace of its
 * newest event. Three requests, sent together when the pane opens. Nothing is
 * stored.
 */
import { Clock, Effect, Schema } from "effect";
import type * as HttpClient from "effect/http/HttpClient";
import { PluginError, type EntityBlockDraft } from "@hercule/plugin-host";
import type { SentryFailure } from "./api";
import { buildIssuePath, readOrganizationResource, type OrganizationAccess } from "./organization";
import { parseIssueRef } from "./refs";
import {
  ApiIssueDetail,
  ApiLatestEvent,
  ApiStackFrame,
  ApiTagValues,
  readLastException,
} from "./sentry-objects";
import { cutText } from "./text";

type IssueDetail = Schema.Schema.Type<typeof ApiIssueDetail>;
type TagValues = Schema.Schema.Type<typeof ApiTagValues>;

const TREND_DAYS = 14;
const MAX_STACK_LINES = 20;
const MAX_FIELD_VALUE_LENGTH = 200;
// 20 lines of at most about 300 characters stay far below the code block's 8 KiB.
const MAX_FUNCTION_LENGTH = 120;
const MAX_FILE_LENGTH = 160;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
/** The latest time a JavaScript Date can hold, in milliseconds from the epoch. */
const MAX_DATE_MILLIS = 8.64e15;

const RESOLVE_ACTIVITY_TYPES = ["set_resolved", "set_resolved_in_release", "set_resolved_by_age"];

/**
 * Describes how long ago `at` was, in whole units of the largest size that
 * fits: "just now", "4 minutes ago", "1 hour ago", "yesterday", "6 days ago",
 * "3 weeks ago", "2 months ago", "1 year ago". Both arguments are epoch
 * milliseconds. A time in the future reads as "just now".
 */
const describeTimeSince = (at: number, now: number): string => {
  const plural = (count: number, unit: string): string =>
    `${String(count)} ${unit}${count === 1 ? "" : "s"} ago`;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  // The drawing reads "8 days ago", so days run up to two weeks.
  if (days < 14) return plural(days, "day");
  if (days < 30) return plural(Math.floor(days / 7), "week");
  // 360 to 364 days stay at 11 months: 12 months would read as a year too early.
  if (days < 365) return plural(Math.min(11, Math.floor(days / 30)), "month");
  return plural(Math.floor(days / 365), "year");
};

/**
 * Returns the events of each of the last 14 UTC days, today last. Ignores a
 * bucket whose time is not a date or whose count is not a finite number of
 * zero or more, so one odd value does not fail the pane. Returns undefined
 * when no valid bucket is left.
 */
const buildTrendBlock = (detail: IssueDetail, now: number): EntityBlockDraft | undefined => {
  const buckets = (detail.stats?.["30d"] ?? []).filter(
    ([seconds, count]) =>
      Number.isFinite(seconds) &&
      Math.abs(seconds * 1000) <= MAX_DATE_MILLIS &&
      Number.isFinite(count) &&
      count >= 0,
  );
  if (buckets.length === 0) return undefined;
  const countByDay = new Map(
    buckets.map(([seconds, count]) => [new Date(seconds * 1000).toISOString().slice(0, 10), count]),
  );
  const today = Math.floor(now / MILLIS_PER_DAY) * MILLIS_PER_DAY;
  const points = Array.from({ length: TREND_DAYS }, (_, index) => {
    const start = new Date(today - (TREND_DAYS - 1 - index) * MILLIS_PER_DAY).toISOString();
    return { at: start, value: countByDay.get(start.slice(0, 10)) ?? 0 };
  });
  return { type: "trend", caption: "Events, last 14 days", points };
};

/** Appends ", in <release>" to a time, when the release is known. */
const appendRelease = (when: string, release: string | null | undefined): string =>
  release == null || release === "" ? when : `${when}, in ${release}`;

/** Builds the rows about when the issue appeared, went away and came back. */
const buildTimeRows = (
  detail: IssueDetail,
  now: number,
): ReadonlyArray<{ label: string; value: string }> => {
  const since = (time: string): string => describeTimeSince(Date.parse(time), now);
  const activity = detail.activity ?? [];
  const regressionIndex = activity.findIndex((item) => item.type === "set_regression");
  if (detail.substatus === "regressed" && regressionIndex >= 0) {
    const regression = activity[regressionIndex]!;
    // Activity is newest first, so what resolved the issue comes after the regression.
    const resolution = activity
      .slice(regressionIndex + 1)
      .find((item) => RESOLVE_ACTIVITY_TYPES.includes(item.type));
    const resolvedRelease = regression.data?.resolved_in_version || resolution?.data?.version;
    return [
      ...(resolution === undefined
        ? []
        : [
            {
              label: "Resolved",
              value: appendRelease(since(resolution.dateCreated), resolvedRelease),
            },
          ]),
      {
        label: "Came back",
        value: appendRelease(since(regression.dateCreated), regression.data?.version),
      },
    ];
  }
  return [
    {
      label: "First seen",
      value: appendRelease(since(detail.firstSeen), detail.firstRelease?.version),
    },
    { label: "Last seen", value: since(detail.lastSeen) },
  ];
};

const buildBrowserRow = (
  tag: TagValues | undefined,
): ReadonlyArray<{ label: string; value: string }> => {
  const top = tag?.topValues?.[0];
  const name = top?.name || top?.value;
  if (tag === undefined || top === undefined || !name) return [];
  // A count above the total, or a total of zero or less, is not a share.
  if (!(tag.totalValues > 0) || !Number.isFinite(top.count) || top.count > tag.totalValues)
    return [];
  const percent = Math.round((top.count / tag.totalValues) * 100);
  return [
    {
      label: "Browser",
      value: `${cutText(name, MAX_FIELD_VALUE_LENGTH - 10)} · ${String(percent)}%`,
    },
  ];
};

/** Builds the facts about the issue. A row with an empty value is left out, since the pane refuses an empty value. */
const buildFieldsBlock = (
  detail: IssueDetail,
  tag: TagValues | undefined,
  now: number,
): EntityBlockDraft => ({
  type: "fields",
  rows: [
    { label: "Severity", value: cutText(detail.level, MAX_FIELD_VALUE_LENGTH) },
    ...buildTimeRows(detail, now).map((row) => ({
      ...row,
      value: cutText(row.value, MAX_FIELD_VALUE_LENGTH),
    })),
    { label: "Users", value: String(detail.userCount) },
    ...buildBrowserRow(tag),
  ].filter((row) => row.value.trim() !== ""),
});

/**
 * Puts a name or path on one line and cuts it to `maximum` characters. A line
 * break (including U+2028 and U+2029) would break the stack's lines.
 */
const flattenLine = (text: string, maximum: number): string =>
  cutText(text.replace(/[\r\n\u2028\u2029]+/g, " "), maximum);

/** Writes one frame as `at fn (file:line:col)`. */
const describeFrame = (frame: Schema.Schema.Type<typeof ApiStackFrame>): string => {
  const place = frame.filename || frame.absPath || frame.module || "unknown";
  const line = frame.lineNo == null ? "" : `:${String(frame.lineNo)}`;
  const column = frame.lineNo == null || frame.colNo == null ? "" : `:${String(frame.colNo)}`;
  return `at ${flattenLine(frame.function || "<anonymous>", MAX_FUNCTION_LENGTH)} (${flattenLine(place, MAX_FILE_LENGTH)}${line}${column})`;
};

/** Builds the stack trace of the newest event, innermost frame first. Returns undefined when it has no frame. */
const buildStackBlock = (
  event: Schema.Schema.Type<typeof ApiLatestEvent> | undefined,
): EntityBlockDraft | undefined => {
  const frames = (event && readLastException(event)?.stacktrace?.frames) ?? [];
  if (frames.length === 0) return undefined;
  const innermostFirst = frames.toReversed();
  return {
    type: "code",
    title: "Stack trace",
    text: innermostFirst.slice(0, MAX_STACK_LINES).map(describeFrame).join("\n"),
    ...(innermostFirst.length > MAX_STACK_LINES ? { truncated: true } : {}),
  };
};

/**
 * Reads the blocks of one issue: `trend`, `fields` and `code`, in that order.
 * A block whose data Sentry has not got is left out: no daily counts, no
 * browser tag (a row), no stack. Fails with a `PluginError` before any
 * request when `ref` is not an issue ref of the Connection's organization,
 * and when the issue does not exist (Sentry answers 404 for a deleted or
 * merged issue). Any other failure of the three requests fails the read.
 */
export const readIssueBlocks = (
  access: OrganizationAccess,
  ref: string,
): Effect.Effect<ReadonlyArray<EntityBlockDraft>, SentryFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const parsed = parseIssueRef(ref);
    if (parsed === undefined || parsed.organizationId !== access.organization.id) {
      return yield* new PluginError({
        message: `Sentry reads blocks for the issues of ${access.organization.slug}, and ${ref} is not one of their refs.`,
      });
    }
    const base = buildIssuePath(access, parsed.issueId);
    const [detail, tag, event] = yield* Effect.all(
      [
        readOrganizationResource(access, base, ApiIssueDetail),
        readOrganizationResource(access, `${base}tags/browser/`, ApiTagValues),
        readOrganizationResource(access, `${base}events/latest/`, ApiLatestEvent),
      ],
      { concurrency: "unbounded" },
    );
    if (detail === undefined) {
      return yield* new PluginError({
        message: `Sentry has no issue for ${ref}. It may be deleted or merged into another issue.`,
      });
    }
    const now = yield* Clock.currentTimeMillis;
    return [
      buildTrendBlock(detail, now),
      buildFieldsBlock(detail, tag, now),
      buildStackBlock(event),
    ].filter((block) => block !== undefined);
  });
