/**
 * The objects Sentry's REST API returns, cut to the fields this plugin reads.
 * Sentry sends many more, and decoding drops them. A field Sentry may leave
 * out or send as null is optional here, so an older issue never fails a poll.
 */
import { Option, Schema } from "effect";
import { MAX_BLOCK_URL_LENGTH } from "@hercule/plugin-host";
import { MAX_STACK_FRAMES, type IssueBlock, type LatestEvent, type StackFrame } from "./kinds";
import { cutName, cutText, MAX_EXCEPTION_VALUE_LENGTH, MAX_TITLE_LENGTH } from "./text";

/**
 * The most characters of an id. Sentry's ids are numbers of up to about 20
 * digits. The limit is generous but finite, because an id goes into dedup
 * keys and refs, which the host bounds.
 */
const MAX_ID_LENGTH = 32;

/** The most characters of a slug or a short id, such as `acme` or `WEBSHOP-1A`. */
const MAX_SLUG_LENGTH = 128;

/** The most characters of an event id. Sentry's are 32 hexadecimal digits. */
const MAX_EVENT_ID_LENGTH = 64;

/** The most characters of a time. Sentry sends at most microseconds and a zone. */
const MAX_TIME_LENGTH = 64;

/** An id of an organization, project, issue, user, team or activity: digits. */
const SentryId = Schema.String.check(Schema.isPattern(/^\d+$/), Schema.isMaxLength(MAX_ID_LENGTH));

/** A slug or short id: letters, digits, dash, underscore and dot. A slug is part of a URL path, so nothing else may pass. */
const SentrySlug = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  Schema.isMaxLength(MAX_SLUG_LENGTH),
);

/** The id of an event: hexadecimal digits. */
const SentryEventId = Schema.String.check(
  Schema.isPattern(/^[0-9a-fA-F]+$/),
  Schema.isMaxLength(MAX_EVENT_ID_LENGTH),
);

/** An ISO 8601 date and time with an explicit time zone, which the host requires of `occurredAt`. */
export const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** A time as an ISO 8601 date and time with a zone, such as `2026-10-12T09:00:00.123456Z`. */
const SentryTime = Schema.String.check(
  Schema.isMaxLength(MAX_TIME_LENGTH),
  Schema.isPattern(ISO_TIMESTAMP_PATTERN),
  Schema.makeFilter((time) =>
    Number.isNaN(Date.parse(time)) ? "Expected a real date" : undefined,
  ),
);

/** An organization, as `GET /api/0/organizations/` lists it. */
export const ApiOrganization = Schema.Struct({
  id: SentryId,
  slug: SentrySlug,
  name: Schema.String,
  links: Schema.Struct({
    /** The host that serves the organization's data, such as `https://us.sentry.io`. */
    regionUrl: Schema.String,
  }),
});

/** A team. */
export const ApiTeam = Schema.Struct({ id: Schema.String, slug: Schema.String });

/** A project and the teams that own it. */
export const ApiProject = Schema.Struct({
  id: Schema.String,
  slug: Schema.String,
  name: Schema.String,
  teams: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.String }))),
});

/** An environment. */
export const ApiEnvironment = Schema.Struct({ name: Schema.String });

/**
 * A member of the organization. `user` is the Sentry account behind the
 * membership, and null for an invitation nobody accepted. An issue is
 * assigned to `user.id`, never to the membership's own `id`.
 */
export const ApiMember = Schema.Struct({
  email: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  user: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        username: Schema.String,
      }),
    ),
  ),
});

/** Returns the name to show for a member: the name, else the email, else the username. */
export const buildMemberLabel = (member: Schema.Schema.Type<typeof ApiMember>): string => {
  const name = member.name?.trim() ?? "";
  if (name !== "") return name;
  const email = member.email?.trim() ?? "";
  return email === "" ? (member.user?.username ?? "") : email;
};

/** The issue's assignee. */
const ApiAssignee = Schema.Struct({
  type: Schema.Literals(["user", "team"]),
  id: SentryId,
  name: Schema.String,
});

/** An issue, as the list and the detail endpoint return it. */
export const ApiIssue = Schema.Struct({
  id: SentryId,
  shortId: SentrySlug,
  title: Schema.String,
  culprit: Schema.optionalKey(Schema.NullOr(Schema.String)),
  permalink: Schema.String,
  level: Schema.String,
  status: Schema.String,
  substatus: Schema.optionalKey(Schema.NullOr(Schema.String)),
  priority: Schema.optionalKey(Schema.NullOr(Schema.String)),
  assignedTo: Schema.optionalKey(Schema.NullOr(ApiAssignee)),
  project: Schema.Struct({ id: SentryId, slug: SentrySlug, name: Schema.String }),
  firstSeen: SentryTime,
  lastSeen: SentryTime,
  count: Schema.String,
  userCount: Schema.Number,
  metadata: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ type: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
  ),
  statusDetails: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        actor: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: SentryId }))),
      }),
    ),
  ),
});

export type ApiIssue = Schema.Schema.Type<typeof ApiIssue>;

/**
 * Converts an issue as Sentry returns it into the block the events carry.
 * Every text Sentry sets is cut to a length the host accepts, and an empty
 * title becomes the short id, because a title is what the event is named by.
 * A link that is too long becomes empty.
 */
export const buildIssueBlock = (issue: ApiIssue): IssueBlock => ({
  id: issue.id,
  shortId: cutName(issue.shortId),
  title: cutText(issue.title.trim() === "" ? issue.shortId : issue.title, MAX_TITLE_LENGTH),
  culprit: cutText(issue.culprit ?? "", MAX_TITLE_LENGTH),
  type: issue.metadata?.type == null ? null : cutName(issue.metadata.type),
  level: cutName(issue.level),
  priority: issue.priority == null ? null : cutName(issue.priority),
  status: cutName(issue.status),
  substatus: issue.substatus == null ? null : cutName(issue.substatus),
  project: {
    id: issue.project.id,
    slug: cutName(issue.project.slug),
    name: cutName(issue.project.name),
  },
  assignedTo:
    issue.assignedTo == null
      ? null
      : {
          type: issue.assignedTo.type,
          id: issue.assignedTo.id,
          name: cutName(issue.assignedTo.name),
        },
  firstSeen: issue.firstSeen,
  lastSeen: issue.lastSeen,
  count: cutName(issue.count),
  userCount: issue.userCount,
  // A cut link would point nowhere, so a link that is too long is left out.
  permalink: issue.permalink.length > MAX_BLOCK_URL_LENGTH ? "" : issue.permalink,
});

/** Returns true when the issue is assigned to the user themselves, not to one of their teams. */
export const isAssignedToUser = (issue: IssueBlock, userId: string): boolean =>
  issue.assignedTo?.type === "user" && issue.assignedTo.id === userId;

/** Returns the id of the user who changed the issue's status, or undefined when Sentry names nobody. */
export const readStatusActorId = (issue: ApiIssue): string | undefined =>
  issue.statusDetails?.actor?.id;

/** One entry of an issue's activity, such as a regression. */
const ApiActivity = Schema.Struct({
  id: SentryId,
  type: Schema.String,
  dateCreated: SentryTime,
  data: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ version: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
  ),
});

/** An issue's detail, cut to its activity. */
export const ApiIssueDetail = Schema.Struct({
  activity: Schema.optionalKey(Schema.Array(ApiActivity)),
});

/** One time an issue came back after it was resolved. */
export interface Regression {
  readonly activityId: string;
  readonly dateCreated: string;
  /** The release it came back in, when Sentry knows it. */
  readonly release?: string;
}

/** Compares two ids made of digits, as numbers, without a limit on their size. */
export const compareNumericIds = (first: string, second: string): number =>
  first.length === second.length
    ? first < second
      ? -1
      : first > second
        ? 1
        : 0
    : first.length - second.length;

/** Returns the regressions in an issue's detail, oldest first. */
export const listRegressions = (
  detail: Schema.Schema.Type<typeof ApiIssueDetail>,
): ReadonlyArray<Regression> =>
  (detail.activity ?? [])
    .filter((activity) => activity.type === "set_regression")
    .map((activity) => ({
      activityId: activity.id,
      dateCreated: activity.dateCreated,
      ...(activity.data?.version ? { release: cutName(activity.data.version) } : {}),
    }))
    .sort((first, second) => compareNumericIds(first.activityId, second.activityId));

/** One stack frame of an event's exception, as Sentry returns it. */
const ApiStackFrame = Schema.Struct({
  filename: Schema.optionalKey(Schema.NullOr(Schema.String)),
  function: Schema.optionalKey(Schema.NullOr(Schema.String)),
  lineNo: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  inApp: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
});

const ApiException = Schema.Struct({
  values: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          type: Schema.optionalKey(Schema.NullOr(Schema.String)),
          value: Schema.optionalKey(Schema.NullOr(Schema.String)),
          stacktrace: Schema.optionalKey(
            Schema.NullOr(
              Schema.Struct({
                frames: Schema.optionalKey(Schema.NullOr(Schema.Array(ApiStackFrame))),
              }),
            ),
          ),
        }),
      ),
    ),
  ),
});

/**
 * The latest event of an issue, as Sentry returns it. Every field is
 * optional, because the shape of an event depends on its platform and
 * Sentry's documentation names few of them: a part that is not there is left
 * out rather than failing the poll.
 */
export const ApiLatestEvent = Schema.Struct({
  id: Schema.optionalKey(SentryEventId),
  eventID: Schema.optionalKey(SentryEventId),
  dateCreated: Schema.optionalKey(SentryTime),
  release: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ version: Schema.optionalKey(Schema.String) })),
  ),
  tags: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, value: Schema.NullOr(Schema.String) })),
  ),
  entries: Schema.optionalKey(
    Schema.Array(Schema.Struct({ type: Schema.String, data: Schema.optionalKey(Schema.Unknown) })),
  ),
});

const cutOptionalName = (text: string | undefined): string | undefined =>
  text === undefined ? undefined : cutName(text);

const decodeException = Schema.decodeUnknownOption(ApiException);

/** Converts one stack frame, keeping what Sentry knows of it. */
const buildStackFrame = (frame: Schema.Schema.Type<typeof ApiStackFrame>): StackFrame => ({
  filename: frame.filename == null ? null : cutName(frame.filename),
  function: frame.function == null ? null : cutName(frame.function),
  lineNo: frame.lineNo ?? null,
  inApp: frame.inApp ?? false,
});

/**
 * Converts the latest event into the block the events carry. Returns
 * undefined when the event has no id, which means it is not an event.
 * `fallbackDate` stands in for a missing `dateCreated`. The exception is the
 * last one the event lists (the one that was raised last, as Sentry shows
 * it), with its last `MAX_STACK_FRAMES` frames: Sentry lists frames oldest
 * call first, so the last ones are the innermost.
 */
export const buildLatestEvent = (
  event: Schema.Schema.Type<typeof ApiLatestEvent>,
  fallbackDate: string,
): LatestEvent | undefined => {
  const id = event.eventID ?? event.id;
  if (id === undefined) return undefined;
  const readTag = (key: string): string | undefined =>
    event.tags?.find((tag) => tag.key === key)?.value ?? undefined;
  const environment = cutOptionalName(readTag("environment"));
  const release = cutOptionalName(event.release?.version ?? readTag("release"));
  const exceptionEntry = event.entries?.find((entry) => entry.type === "exception");
  const exception = Option.getOrUndefined(decodeException(exceptionEntry?.data))?.values?.at(-1);
  return {
    id,
    dateCreated: event.dateCreated ?? fallbackDate,
    ...(environment === undefined ? {} : { environment }),
    ...(release === undefined ? {} : { release }),
    ...(exception === undefined
      ? {}
      : {
          exception: {
            type: exception.type == null ? null : cutName(exception.type),
            value:
              exception.value == null ? null : cutText(exception.value, MAX_EXCEPTION_VALUE_LENGTH),
            frames: (exception.stacktrace?.frames ?? [])
              .slice(-MAX_STACK_FRAMES)
              .map(buildStackFrame),
          },
        }),
  };
};
