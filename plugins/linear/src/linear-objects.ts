/**
 * The Linear objects this plugin reads, as the API returns them, the GraphQL
 * fragments that select them, and the payload blocks built from them. The
 * schemas name only the fields the plugin reads; decoding ignores the rest.
 */
import { Schema } from "effect";
import type { ClosedHow, CommentBlock, IssueBlock, LinearUser, MentionComment } from "./kinds";
import { cutName, cutText, MAX_BODY_LENGTH, MAX_TITLE_LENGTH } from "./text";

/** A user as Linear returns one: an assignee, a creator, an actor or a comment's author. */
export const ApiUser = Schema.Struct({ id: Schema.String, name: Schema.String });

/** Something Linear names by id: a label, a project, a project milestone. */
const ApiNamed = Schema.Struct({ id: Schema.String, name: Schema.String });

/** The fields of an issue every query reads, as one fragment. */
export const ISSUE_FRAGMENT = `fragment IssueFields on Issue {
  id identifier title url description priority priorityLabel dueDate estimate
  createdAt updatedAt archivedAt trashed
  state { id name type }
  assignee { id name }
  creator { id name }
  labels(first: 250) { nodes { id name } }
  project { id name }
  projectMilestone { id name }
  team { id key name }
}`;

/** An issue as `ISSUE_FRAGMENT` selects it. */
export const ApiIssue = Schema.Struct({
  id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  description: Schema.NullOr(Schema.String),
  priority: Schema.Number,
  priorityLabel: Schema.String,
  dueDate: Schema.NullOr(Schema.String),
  estimate: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  trashed: Schema.NullOr(Schema.Boolean),
  state: Schema.Struct({ id: Schema.String, name: Schema.String, type: Schema.String }),
  assignee: Schema.NullOr(ApiUser),
  creator: Schema.NullOr(ApiUser),
  labels: Schema.Struct({ nodes: Schema.Array(ApiNamed) }),
  project: Schema.NullOr(ApiNamed),
  projectMilestone: Schema.NullOr(ApiNamed),
  team: Schema.Struct({ id: Schema.String, key: Schema.String, name: Schema.String }),
});

export type ApiIssue = Schema.Schema.Type<typeof ApiIssue>;

/** The workspace and the signed-in user, which the feeds read beside their lists. */
export const VIEWER_FIELDS = "viewer { id } organization { id urlKey }";

/** What `VIEWER_FIELDS` selects. */
export const ViewerFields = {
  viewer: Schema.Struct({ id: Schema.String }),
  organization: Schema.Struct({ id: Schema.String, urlKey: Schema.String }),
};

/** Returns a user block, its name cut to the host's limit. */
export const buildUser = (user: Schema.Schema.Type<typeof ApiUser>): LinearUser => ({
  id: user.id,
  name: cutName(user.name),
});

/** Returns a named block (a label, a project, a milestone), its name cut. */
const buildNamed = (named: Schema.Schema.Type<typeof ApiNamed>) => ({
  id: named.id,
  name: cutName(named.name),
});

/** Builds the `issue` block of a payload, with every string cut to the plugin's limits. */
export const buildIssueBlock = (issue: ApiIssue): IssueBlock => ({
  id: issue.id,
  identifier: cutName(issue.identifier),
  title: cutText(issue.title, MAX_TITLE_LENGTH),
  url: issue.url,
  state: { id: issue.state.id, name: cutName(issue.state.name), type: issue.state.type },
  priority: issue.priority,
  priorityLabel: cutName(issue.priorityLabel),
  assignee: issue.assignee === null ? null : buildUser(issue.assignee),
  labels: issue.labels.nodes.map(buildNamed),
  project: issue.project === null ? null : buildNamed(issue.project),
  projectMilestone: issue.projectMilestone === null ? null : buildNamed(issue.projectMilestone),
  team: { id: issue.team.id, key: cutName(issue.team.key), name: cutName(issue.team.name) },
  dueDate: issue.dueDate,
  estimate: issue.estimate,
  createdAt: issue.createdAt,
  updatedAt: issue.updatedAt,
});

/** Returns an issue's description cut to the plugin's limit, or null when it has none. */
export const buildDescription = (issue: ApiIssue): string | null =>
  issue.description === null ? null : cutText(issue.description, MAX_BODY_LENGTH);

/** The workflow state types of a closed issue, which are also the ways it can close. */
const CLOSED_STATE_TYPES: ReadonlyArray<string> = ["completed", "canceled", "duplicate"];

/**
 * Returns how an issue counts as closed, or undefined when it is open:
 *
 * - `deleted` when Linear no longer returns it (`issue` is undefined);
 * - `archived` when it is archived or in the trash;
 * - its state type when that is `completed`, `canceled` or `duplicate`.
 */
export const decideClosedHow = (issue: ApiIssue | undefined): ClosedHow | undefined => {
  if (issue === undefined) return "deleted";
  if (issue.archivedAt !== null || issue.trashed === true) return "archived";
  return CLOSED_STATE_TYPES.includes(issue.state.type)
    ? (issue.state.type as ClosedHow)
    : undefined;
};

/** The fields of a comment, as one fragment. */
const COMMENT_FIELDS = "id body url createdAt user { id name }";

/** A comment as `COMMENT_FIELDS` selects it. */
const ApiComment = Schema.Struct({
  id: Schema.String,
  body: Schema.String,
  url: Schema.String,
  createdAt: Schema.String,
  user: Schema.NullOr(ApiUser),
});

type ApiComment = Schema.Schema.Type<typeof ApiComment>;

/**
 * The fields of a notification every query reads, as one fragment, with the
 * issue fragment it needs. A project notification names its project; a
 * document notification names only the document's id, so its title and link
 * are the notification's own.
 */
export const NOTIFICATION_FRAGMENT = `fragment NotificationFields on Notification {
  id type category createdAt archivedAt title url
  actor { id name }
  ... on IssueNotification {
    issue { ...IssueFields }
    comment { ${COMMENT_FIELDS} parent { ${COMMENT_FIELDS} } }
  }
  ... on ProjectNotification {
    project { id name url }
    comment { ${COMMENT_FIELDS} parent { ${COMMENT_FIELDS} } }
  }
  ... on DocumentNotification { documentId }
}
${ISSUE_FRAGMENT}`;

/** A notification as `NOTIFICATION_FRAGMENT` selects it. The type-specific fields are absent on other types. */
export const ApiNotification = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
  category: Schema.String,
  createdAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  title: Schema.String,
  url: Schema.String,
  actor: Schema.NullOr(ApiUser),
  issue: Schema.optionalKey(ApiIssue),
  project: Schema.optionalKey(
    Schema.Struct({ id: Schema.String, name: Schema.String, url: Schema.String }),
  ),
  documentId: Schema.optionalKey(Schema.String),
  comment: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ ...ApiComment.fields, parent: Schema.NullOr(ApiComment) })),
  ),
});

export type ApiNotification = Schema.Schema.Type<typeof ApiNotification>;

/** Builds a comment block, its body cut to the plugin's limit. */
const buildCommentBlock = (comment: ApiComment): CommentBlock => ({
  id: comment.id,
  body: cutText(comment.body, MAX_BODY_LENGTH),
  url: comment.url,
  createdAt: comment.createdAt,
  author: comment.user === null ? null : buildUser(comment.user),
});

/** Builds the comment of a mention, with the comment it replies to. Returns null when the notification has no comment. */
export const buildMentionComment = (notification: ApiNotification): MentionComment | null => {
  const comment = notification.comment;
  if (comment === undefined || comment === null) return null;
  return {
    ...buildCommentBlock(comment),
    parent: comment.parent === null ? null : buildCommentBlock(comment.parent),
  };
};
