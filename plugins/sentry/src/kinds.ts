/**
 * The events this plugin can emit, and what each one carries.
 *
 * Every payload starts with the same `org` and `issue` blocks, so a reader
 * gets the issue the same way from any kind. A kind has a field of its own
 * only when it needs one: where a returning issue came back from, whether the
 * user resolved it.
 *
 * Nothing here polls. Declaring the kinds lets a subscription and a workflow
 * filter refer to them, and gives the schemas emitted payloads are validated
 * against. The feed in `ingest/` emits them.
 */
import { Schema } from "effect";
import type { EventKindDeclaration } from "@hercule/plugin-host";

/** The organization a Connection watches, as every payload names it. */
const Organization = Schema.Struct({ id: Schema.String, slug: Schema.String }).annotate({
  identifier: "SentryOrganization",
});

/** Who an issue is assigned to: a user or a team. */
const Assignee = Schema.Struct({
  type: Schema.Literals(["user", "team"]),
  id: Schema.String,
  name: Schema.String,
});

export type SentryAssignee = Schema.Schema.Type<typeof Assignee>;

/**
 * An issue as Sentry listed it when the event was raised. `type` is the error
 * type (`TypeError`), null for an issue that is not an error. `substatus` is
 * null for a resolved issue. `count` is a string, as Sentry sends it.
 */
export const IssueBlock = Schema.Struct({
  id: Schema.String,
  shortId: Schema.String,
  title: Schema.String,
  culprit: Schema.String,
  type: Schema.NullOr(Schema.String),
  level: Schema.String,
  priority: Schema.NullOr(Schema.String),
  status: Schema.String,
  substatus: Schema.NullOr(Schema.String),
  project: Schema.Struct({ id: Schema.String, slug: Schema.String, name: Schema.String }),
  assignedTo: Schema.NullOr(Assignee),
  firstSeen: Schema.String,
  lastSeen: Schema.String,
  count: Schema.String,
  userCount: Schema.Number,
  permalink: Schema.String,
}).annotate({ identifier: "SentryIssue" });

export type IssueBlock = Schema.Schema.Type<typeof IssueBlock>;

/** One stack frame of an exception. Sentry leaves out what it does not know, so each field may be null. */
export const StackFrame = Schema.Struct({
  filename: Schema.NullOr(Schema.String),
  function: Schema.NullOr(Schema.String),
  lineNo: Schema.NullOr(Schema.Number),
  inApp: Schema.Boolean,
});

export type StackFrame = Schema.Schema.Type<typeof StackFrame>;

/** The newest event of an issue: when it happened, where, and the exception it raised. */
export const LatestEvent = Schema.Struct({
  id: Schema.String,
  dateCreated: Schema.String,
  environment: Schema.optionalKey(Schema.String),
  release: Schema.optionalKey(Schema.String),
  exception: Schema.optionalKey(
    Schema.Struct({
      type: Schema.NullOr(Schema.String),
      value: Schema.NullOr(Schema.String),
      /** At most `MAX_STACK_FRAMES`, innermost call last. */
      frames: Schema.Array(StackFrame),
    }),
  ),
}).annotate({ identifier: "SentryLatestEvent" });

export type LatestEvent = Schema.Schema.Type<typeof LatestEvent>;

/** How many stack frames an event carries: the innermost ones, which are the ones that matter. */
export const MAX_STACK_FRAMES = 20;

/** Where a returning issue came back from. */
export const ReturnedFrom = Schema.Literals(["resolved", "archived"]);

export type ReturnedFrom = Schema.Schema.Type<typeof ReturnedFrom>;

/** Why an issue left the watched set without being resolved or archived. */
export const LeftReason = Schema.Literals(["unmatched", "aged-out", "deleted"]);

export type LeftReason = Schema.Schema.Type<typeof LeftReason>;

/** Declares a kind that carries the organization, the issue and the fields of its own. */
const declareIssueKind = (
  description: string,
  availableToTriage: boolean,
  fields: Schema.Struct.Fields,
): EventKindDeclaration => ({
  description,
  schema: Schema.Struct({ org: Organization, issue: IssueBlock, ...fields }),
  availableToTriage,
});

/**
 * Every kind this plugin emits. `availableToTriage` is false for the kinds
 * that matter only because they end a signal: an issue that was resolved,
 * archived or left the watched set.
 */
export const SENTRY_EVENT_KINDS: Record<string, EventKindDeclaration> = {
  "sentry.issue.entered": declareIssueKind("An issue joined the issues the user watches.", true, {
    /** True when the issue is assigned to the user directly, rather than to one of their teams. */
    toYou: Schema.Boolean,
    latestEvent: Schema.optionalKey(LatestEvent),
  }),
  "sentry.issue.regressed": declareIssueKind(
    "A resolved or archived issue had a new event and came back.",
    true,
    {
      after: ReturnedFrom,
      /** The release the issue came back in, when Sentry knows it. */
      release: Schema.optionalKey(Schema.String),
      latestEvent: Schema.optionalKey(LatestEvent),
    },
  ),
  "sentry.issue.escalating": declareIssueKind(
    "Sentry marked an issue escalating: its event rate spiked.",
    true,
    { latestEvent: Schema.optionalKey(LatestEvent) },
  ),
  "sentry.issue.resolved": declareIssueKind("An issue the user watched was resolved.", false, {
    /** True when the user resolved it. False when somebody else did, or Sentry names nobody. */
    byYou: Schema.Boolean,
  }),
  "sentry.issue.archived": declareIssueKind("An issue the user watched was archived.", false, {
    substatus: Schema.NullOr(Schema.String),
    /** True when the user archived it. False when somebody else did, or Sentry names nobody. */
    byYou: Schema.Boolean,
  }),
  "sentry.issue.left": declareIssueKind(
    "An issue the user watched left the watched set without being resolved or archived.",
    false,
    {
      reason: LeftReason,
      /** True when the issue has an assignee that differs from the one the last poll stored. */
      reassigned: Schema.Boolean,
      /** The Connection's window, so a reader can say "No events in 14 days". */
      lastSeenDays: Schema.Int,
    },
  ),
};
