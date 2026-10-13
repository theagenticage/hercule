/**
 * Builds the events both feeds emit. An event about an issue has the issue's
 * identifier and title, its ref and its link. A notification about something
 * else has the subject's title, ref and link instead. Nothing here reads
 * Linear.
 */
import {
  MAX_EVENT_AUTHOR_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  MAX_EVENT_URL_LENGTH,
  type EmittedEvent,
} from "@hercule/plugin-host";
import type { IssueBlock, SubjectBlock, WorkspaceBlock } from "../kinds";
import {
  buildIssueBlock,
  normalizeTimestamp,
  type ApiIssue,
  type ApiNotification,
} from "../linear-objects";
import { cutText, MAX_TITLE_LENGTH } from "../text";

/** The `system` of every event this plugin emits. */
const LINEAR_SYSTEM = "linear";

/** Returns an issue's External Ref, `linear:issue:<workspace id>/<issue id>`, which is also its thread. */
export const buildIssueRef = (workspace: WorkspaceBlock, issueId: string): string =>
  `linear:issue:${workspace.id}/${issueId}`;

/** Returns the `url` field of an event: the link, or nothing when it is empty or too long for the host. */
const buildUrlField = (url: string): { readonly url?: string } =>
  url === "" || url.length > MAX_EVENT_URL_LENGTH ? {} : { url };

/** Returns an issue event's title, `<identifier> <title>`, cut to the host's limit. */
const buildIssueTitle = (issue: IssueBlock): string =>
  cutText(`${issue.identifier} ${issue.title}`, MAX_EVENT_TITLE_LENGTH);

/** The kinds about an issue that the `issues` feed emits. */
export type IssueKind =
  | "linear.issue.entered"
  | "linear.issue.changed"
  | "linear.issue.left"
  | "linear.issue.closed"
  | "linear.issue.unassigned";

/** What one event of the `issues` feed is built from. */
export interface IssueEventInput {
  readonly kind: IssueKind;
  readonly workspace: WorkspaceBlock;
  readonly issue: IssueBlock;
  /** The signed-in user's id, which decides `toYou`. */
  readonly userId: string;
  /** The payload fields the kind has beside `workspace`, `issue` and `toYou`. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** The ISO time of the poll that found the change. It is part of the dedup key. */
  readonly pollTime: string;
}

/**
 * Builds one event of the `issues` feed. Its dedup key is `<issue id>:<kind>:
 * <poll time>`: it is fixed when the event is written to the outbox, so the
 * event emitted again repeats it, and an issue that leaves and comes back
 * gets a new one.
 */
export const buildIssueEvent = (input: IssueEventInput): EmittedEvent => {
  const { workspace, issue } = input;
  return {
    kind: input.kind,
    dedupKey: `${issue.id}:${input.kind}:${input.pollTime}`,
    occurredAt: normalizeTimestamp(issue.updatedAt, input.pollTime),
    refs: [buildIssueRef(workspace, issue.id)],
    ...buildUrlField(issue.url),
    system: LINEAR_SYSTEM,
    title: buildIssueTitle(issue),
    author: null,
    payload: {
      workspace,
      issue,
      toYou: issue.assignee?.id === input.userId,
      ...input.fields,
    },
  };
};

/**
 * What a notification is about: the issue, or the subject when it is about
 * something else, with the thread's External Ref, the link and the title.
 */
export interface NotificationTopic {
  /** The `issue` and `toYou` fields of the payload, or its `subject` field. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** The issue as Linear returned it, when the notification is about one. */
  readonly issue?: ApiIssue;
  readonly ref: string;
  readonly url: string;
  readonly title: string;
}

/**
 * Works out what a notification is about:
 *
 * - an issue, for an issue notification;
 * - its project, for a project notification;
 * - the document, for a document notification, named by the notification's
 *   own title and link, because Linear returns only the document's id;
 * - otherwise the notification itself, as a subject of type `other`.
 */
export const buildNotificationTopic = (
  workspace: WorkspaceBlock,
  notification: ApiNotification,
  userId: string,
): NotificationTopic => {
  if (notification.issue !== undefined) {
    const issue = buildIssueBlock(notification.issue);
    return {
      fields: { issue, toYou: issue.assignee?.id === userId },
      issue: notification.issue,
      ref: buildIssueRef(workspace, issue.id),
      url: issue.url,
      title: buildIssueTitle(issue),
    };
  }
  const subject: SubjectBlock =
    notification.project !== undefined
      ? {
          type: "project",
          id: notification.project.id,
          title: cutText(notification.project.name, MAX_TITLE_LENGTH),
          url: notification.project.url,
        }
      : notification.documentId !== undefined
        ? {
            type: "document",
            id: notification.documentId,
            title: cutText(notification.title, MAX_TITLE_LENGTH),
            url: notification.url,
          }
        : {
            type: "other",
            id: notification.id,
            title: cutText(notification.title, MAX_TITLE_LENGTH),
            url: notification.url,
          };
  const refType = subject.type === "other" ? "notification" : subject.type;
  return {
    fields: { subject },
    ref: `linear:${refType}:${workspace.id}/${subject.id}`,
    url: subject.url,
    // The host requires a title, and a subject's title can be empty.
    title: cutText(
      subject.title === "" ? notification.type : subject.title,
      MAX_EVENT_TITLE_LENGTH,
    ),
  };
};

/** The kinds the `notifications` feed emits. */
export type NotificationKind =
  | "linear.mentioned"
  | "linear.assigned"
  | "linear.notification"
  | "linear.notification.archived";

/**
 * Builds one event of the `notifications` feed. Its dedup key is the
 * notification's id, with `:archived` for `linear.notification.archived`.
 * `occurredAt` is when the notification was created, and `author` is the
 * actor's name, or null when Linear names none.
 */
export const buildNotificationEvent = (input: {
  readonly kind: NotificationKind;
  readonly workspace: WorkspaceBlock;
  readonly notification: ApiNotification;
  readonly topic: NotificationTopic;
  /** The payload fields the kind has beside `workspace` and the topic. */
  readonly fields: Readonly<Record<string, unknown>>;
  /** The ISO time of the poll, which stands in for a `createdAt` that cannot be read. */
  readonly pollTime: string;
}): EmittedEvent => {
  const { notification, topic } = input;
  const actorName = notification.actor?.name ?? "";
  return {
    kind: input.kind,
    dedupKey:
      input.kind === "linear.notification.archived"
        ? `${notification.id}:archived`
        : notification.id,
    occurredAt: normalizeTimestamp(notification.createdAt, input.pollTime),
    refs: [topic.ref],
    ...buildUrlField(topic.url),
    system: LINEAR_SYSTEM,
    title: topic.title,
    author: actorName === "" ? null : cutText(actorName, MAX_EVENT_AUTHOR_LENGTH),
    payload: { workspace: input.workspace, ...topic.fields, ...input.fields },
  };
};
