/**
 * The events this plugin can emit, and what each one carries.
 *
 * Every payload starts with the `workspace` block. An event about an issue
 * then carries the `issue` block and `toYou`, so a reader gets the issue the
 * same way from any kind. A notification about something other than an
 * issue, such as a project or a document, carries a `subject` block instead.
 * A kind has a field of its own only when it needs one: what changed, why an
 * issue closed, who mentioned the user.
 *
 * Nothing here polls. Declaring the kinds lets a subscription and a workflow
 * filter refer to them, and gives the schemas emitted payloads are validated
 * against. The feeds in `ingest/` emit them.
 */
import { Schema } from "effect";
import type { EventKindDeclaration } from "@hercule/plugin-host";

/** The Linear workspace a Connection watches, as every payload names it. */
export const WorkspaceBlock = Schema.Struct({ id: Schema.String, urlKey: Schema.String }).annotate({
  identifier: "LinearWorkspace",
});

export type WorkspaceBlock = Schema.Schema.Type<typeof WorkspaceBlock>;

/** A Linear user: an assignee, the creator of an issue, or the actor of a notification. */
export const LinearUser = Schema.Struct({ id: Schema.String, name: Schema.String });

export type LinearUser = Schema.Schema.Type<typeof LinearUser>;

/** Something Linear names by id: a label, a project, a project milestone. */
const NamedRecord = Schema.Struct({ id: Schema.String, name: Schema.String });

/** A workflow state. `type` is Linear's state type, such as `started` or `completed`. */
const WorkflowState = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: Schema.String,
});

/**
 * An issue as Linear listed it when the event was raised.
 *
 * - `priority` is Linear's number: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
 *   `priorityLabel` is its name.
 * - `labels` holds every label on the issue, in the order Linear lists them.
 * - `dueDate` is a date without a time, such as `2026-10-20`.
 */
export const IssueBlock = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  state: WorkflowState,
  priority: Schema.Number,
  priorityLabel: Schema.String,
  assignee: Schema.NullOr(LinearUser),
  labels: Schema.Array(NamedRecord),
  project: Schema.NullOr(NamedRecord),
  projectMilestone: Schema.NullOr(NamedRecord),
  team: Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String }),
  dueDate: Schema.NullOr(Schema.String),
  estimate: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
}).annotate({ identifier: "LinearIssue" });

export type IssueBlock = Schema.Schema.Type<typeof IssueBlock>;

/** What a notification is about when it is not an issue. */
export const SubjectBlock = Schema.Struct({
  type: Schema.Literals(["project", "document", "other"]),
  id: Schema.String,
  title: Schema.String,
  url: Schema.String,
}).annotate({ identifier: "LinearSubject" });

export type SubjectBlock = Schema.Schema.Type<typeof SubjectBlock>;

/** Returns the schema of one compared field's change: its value before and after. */
const declareChange = <S extends Schema.Top>(value: S) => Schema.Struct({ from: value, to: value });

/**
 * The compared fields of an issue that changed between two polls, each with
 * its value before and after. A field that did not change is left out. The
 * feed emits `linear.issue.changed` only when at least one field differs.
 */
export const IssueChanges = Schema.Struct({
  title: Schema.optionalKey(declareChange(IssueBlock.fields.title)),
  state: Schema.optionalKey(declareChange(IssueBlock.fields.state)),
  assignee: Schema.optionalKey(declareChange(IssueBlock.fields.assignee)),
  priority: Schema.optionalKey(declareChange(IssueBlock.fields.priority)),
  labels: Schema.optionalKey(declareChange(IssueBlock.fields.labels)),
  project: Schema.optionalKey(declareChange(IssueBlock.fields.project)),
  projectMilestone: Schema.optionalKey(declareChange(IssueBlock.fields.projectMilestone)),
  dueDate: Schema.optionalKey(declareChange(IssueBlock.fields.dueDate)),
}).annotate({ identifier: "LinearIssueChanges" });

export type IssueChanges = Schema.Schema.Type<typeof IssueChanges>;

/**
 * Why an issue that left the watched set, or a followed issue, counts as
 * closed: its state type, or that it was archived (trashed included) or is
 * gone from Linear.
 */
export const ClosedHow = Schema.Literals([
  "completed",
  "canceled",
  "duplicate",
  "archived",
  "deleted",
]);

export type ClosedHow = Schema.Schema.Type<typeof ClosedHow>;

/** A comment on an issue. `author` is null when Linear names nobody, such as for an integration. */
export const CommentBlock = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  author: Schema.NullOr(LinearUser),
});

export type CommentBlock = Schema.Schema.Type<typeof CommentBlock>;

/** The comment that mentions the user, and the comment it replies to when it is a reply. */
export const MentionComment = Schema.Struct({
  ...CommentBlock.fields,
  parent: Schema.NullOr(CommentBlock),
}).annotate({ identifier: "LinearMentionComment" });

export type MentionComment = Schema.Schema.Type<typeof MentionComment>;

/** The fields of a payload about an issue. `toYou` is true when the issue is assigned to the user. */
const issueFields = { issue: IssueBlock, toYou: Schema.Boolean };

/** Declares a kind about an issue, which carries the workspace, the issue and the fields of its own. */
const declareIssueKind = (
  description: string,
  availableToTriage: boolean,
  fields: Schema.Struct.Fields,
): EventKindDeclaration => ({
  description,
  schema: Schema.Struct({ workspace: WorkspaceBlock, ...issueFields, ...fields }),
  availableToTriage,
});

/**
 * Declares a notification kind whose notification may be about an issue or
 * about something else. Its payload carries the `issue` block and `toYou`,
 * or the `subject` block, never both.
 */
const declareNotificationKind = (
  description: string,
  availableToTriage: boolean,
  fields: Schema.Struct.Fields,
): EventKindDeclaration => ({
  description,
  schema: Schema.Union([
    Schema.Struct({ workspace: WorkspaceBlock, ...issueFields, ...fields }),
    Schema.Struct({ workspace: WorkspaceBlock, subject: SubjectBlock, ...fields }),
  ]),
  availableToTriage,
});

/**
 * Every kind this plugin emits. `availableToTriage` is false for the kinds
 * that matter only because they end a signal, and for `linear.notification`,
 * because most of Linear's inbox is updates on issues the user subscribed to.
 */
export const LINEAR_EVENT_KINDS: Record<string, EventKindDeclaration> = {
  "linear.issue.entered": declareIssueKind("An issue joined the issues the user watches.", true, {
    /** Markdown, null when the issue has none. */
    description: Schema.NullOr(Schema.String),
  }),
  "linear.issue.changed": declareIssueKind("An issue the user watches changed.", true, {
    changes: IssueChanges,
  }),
  "linear.issue.left": declareIssueKind(
    "An issue the user watched is still open but no longer matches the Connection's filters.",
    false,
    {
      /** True when the issue's assignee differs from the one the last poll stored. */
      reassigned: Schema.Boolean,
    },
  ),
  "linear.issue.closed": declareIssueKind(
    "An issue the user watched or followed was completed, canceled, marked duplicate, archived or deleted.",
    false,
    { how: ClosedHow },
  ),
  "linear.issue.unassigned": declareIssueKind(
    "An issue assigned to the user is no longer assigned to them.",
    false,
    {},
  ),
  "linear.mentioned": declareNotificationKind("Someone mentioned the user in Linear.", true, {
    notificationId: Schema.String,
    /** Linear's notification type, such as `issueCommentMention`. */
    type: Schema.String,
    actor: LinearUser,
    /** Null for a mention in an issue's description rather than in a comment. */
    comment: Schema.NullOr(MentionComment),
    /** The issue's description in markdown, for a mention in it. Left out for a mention in a comment. */
    description: Schema.optionalKey(Schema.String),
  }),
  "linear.assigned": declareIssueKind("Someone assigned the user an issue in Linear.", true, {
    notificationId: Schema.String,
    actor: LinearUser,
    /** Markdown, null when the issue has none. */
    description: Schema.NullOr(Schema.String),
    /** Who created the issue, which a reader shows as the author of its description. */
    creator: Schema.NullOr(LinearUser),
  }),
  "linear.notification": declareNotificationKind(
    "Any other notification in the user's Linear inbox.",
    false,
    {
      notificationId: Schema.String,
      /** Linear's notification type, such as `issueNewComment`. Linear adds types over time. */
      type: Schema.String,
      /** Linear's notification category, such as `commentsAndReplies`. */
      category: Schema.String,
      /** Null for a notification an integration or Linear itself caused. */
      actor: Schema.NullOr(LinearUser),
    },
  ),
  "linear.notification.archived": declareNotificationKind(
    "A notification of a mention was marked Done in the user's Linear inbox.",
    false,
    { notificationId: Schema.String },
  ),
};
