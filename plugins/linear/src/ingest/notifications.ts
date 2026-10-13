/**
 * One poll of the `notifications` feed: the user's Linear inbox. It reads the
 * notifications created since the newest one it has read, and emits:
 *
 * - `linear.mentioned` for a notification in the category `mentions`;
 * - `linear.assigned` for the type `issueAssignedToYou`;
 * - `linear.notification` for every other notification;
 * - `linear.notification.archived` when the notification of a mention with
 *   an open `linear/mention` signal was marked Done in Linear.
 *
 * The feed pages by `createdAt`, never by `updatedAt`: Linear moves a
 * notification's `updatedAt` about an hour after it was created with no one
 * acting, so an `updatedAt` cursor would bring old notifications back.
 *
 * The outbox works as in the `issues` feed: events and state are written in
 * one write before the events are emitted.
 */
import { Clock, Effect, Option, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {
  checkEmittedEvent,
  type AuthError,
  type EmittedEvent,
  type IngestContext,
  type PluginError,
  type PollResult,
} from "@hercule/plugin-host";
import { callLinear, MAX_PAGE_SIZE, readPages, type LinearRateLimited } from "../api";
import type { WorkspaceBlock } from "../kinds";
import {
  ApiNotification,
  buildDescription,
  buildMentionComment,
  buildUser,
  NOTIFICATION_FRAGMENT,
  VIEWER_FIELDS,
  ViewerFields,
} from "../linear-objects";
import { LINEAR_EVENT_KINDS } from "../kinds";
import { buildNotificationEvent, buildNotificationTopic } from "./events";
import {
  NOTIFICATIONS_STATE,
  readFeedState,
  writeFeedState,
  type NotificationsState,
  type OutboxEvent,
  type RecordedMention,
} from "./state";

/** The signal kind whose notifications the feed checks for Done in Linear. */
const MENTION_SIGNAL_KIND = "linear/mention";

/**
 * How long a recorded mention is kept while its thread has no open signal.
 * The core raises a signal after it stores the event, not at once, so a
 * mention emitted by one poll may have no signal yet at the next. Past this
 * time, a mention with no open signal will never get one, and is forgotten.
 */
const MENTION_GRACE_MILLIS = 10 * 60_000;

/** The query that reads the inbox, with the workspace and the user. */
const INBOX_QUERY = `query LinearInbox($filter: NotificationFilter, $first: Int, $last: Int) {
  ${VIEWER_FIELDS}
  notifications(filter: $filter, first: $first, last: $last) { nodes { ...NotificationFields } }
}
${NOTIFICATION_FRAGMENT}`;

const InboxAnswer = Schema.Struct({
  ...ViewerFields,
  notifications: Schema.Struct({ nodes: Schema.Array(ApiNotification) }),
});

/** The query that reads notifications by id, archived ones included. */
const MENTION_LOOKUP_QUERY = `query LinearMentionLookup($filter: NotificationFilter, $first: Int, $after: String) {
  notifications(filter: $filter, first: $first, after: $after, includeArchived: true) {
    nodes { ...NotificationFields }
    pageInfo { hasNextPage endCursor }
  }
}
${NOTIFICATION_FRAGMENT}`;

/** Returns the notifications sorted oldest first, by `createdAt`. */
const sortOldestFirst = (
  notifications: ReadonlyArray<ApiNotification>,
): ReadonlyArray<ApiNotification> =>
  [...notifications].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

/**
 * Returns the cursor after reading `read`, oldest first: the newest
 * `createdAt` and every id read at that time. Returns `cursor` unchanged when
 * nothing was read.
 */
const advanceCursor = (
  cursor: NotificationsState["cursor"],
  read: ReadonlyArray<ApiNotification>,
): NotificationsState["cursor"] => {
  const newest = read.at(-1);
  if (newest === undefined) return cursor;
  const newestMillis = Date.parse(newest.createdAt);
  const idsAtNewest = read
    .filter((notification) => Date.parse(notification.createdAt) === newestMillis)
    .map((notification) => notification.id);
  const sameTime = cursor !== null && Date.parse(cursor.createdAt) === newestMillis;
  return {
    createdAt: newest.createdAt,
    ids: sameTime ? [...new Set([...cursor.ids, ...idsAtNewest])] : idsAtNewest,
  };
};

/** What turning one new notification into an event gives: the event, and the mention to record. */
interface ReadNotification {
  readonly event: EmittedEvent;
  readonly mention?: { readonly ref: string; readonly notificationId: string };
}

/**
 * Turns one new notification into its event. Returns undefined for a
 * notification the user caused, because assigning yourself is your own move,
 * and Linear does not document whether mentioning yourself notifies you.
 *
 * A mention or an assignment with no actor (an integration, or Linear
 * itself) becomes a plain `linear.notification`, because those kinds name
 * who mentioned or assigned the user.
 */
const readNotification = (
  workspace: WorkspaceBlock,
  userId: string,
  notification: ApiNotification,
  pollTime: string,
): ReadNotification | undefined => {
  const { actor } = notification;
  if (actor?.id === userId) return undefined;
  const topic = buildNotificationTopic(workspace, notification, userId);
  const base = { workspace, notification, topic, pollTime };
  if (notification.category === "mentions" && actor !== null) {
    const comment = buildMentionComment(notification);
    const description =
      comment === null && topic.issue !== undefined ? buildDescription(topic.issue) : null;
    return {
      event: buildNotificationEvent({
        ...base,
        kind: "linear.mentioned",
        fields: {
          notificationId: notification.id,
          type: notification.type,
          actor: buildUser(actor),
          comment,
          ...(description === null ? {} : { description }),
        },
      }),
      mention: { ref: topic.ref, notificationId: notification.id },
    };
  }
  if (notification.type === "issueAssignedToYou" && topic.issue !== undefined && actor !== null) {
    const { creator } = topic.issue;
    return {
      event: buildNotificationEvent({
        ...base,
        kind: "linear.assigned",
        fields: {
          notificationId: notification.id,
          actor: buildUser(actor),
          description: buildDescription(topic.issue),
          creator: creator === null ? null : buildUser(creator),
        },
      }),
    };
  }
  return {
    event: buildNotificationEvent({
      ...base,
      kind: "linear.notification",
      fields: {
        notificationId: notification.id,
        type: notification.type,
        category: notification.category,
        actor: actor === null ? null : buildUser(actor),
      },
    }),
  };
};

/**
 * Polls the `notifications` feed once with the `Authorization` header
 * `authorization`. Returns an empty result.
 *
 * - The first poll records where the inbox stands and emits nothing.
 * - A later poll reads at most 250 notifications created since the newest one
 *   it has read, oldest first; the rest wait for the next poll.
 * - Each poll also reads, in one query, the notifications of the recorded
 *   mentions whose thread has an open `linear/mention` signal, and emits
 *   `linear.notification.archived` for each one that was archived.
 *
 * Fails with an `AuthError` when Linear refuses the credential, with
 * `LinearRateLimited` when it rate limits the poll, and with a `PluginError`
 * when Linear fails or answers in a shape the plugin does not know, or when
 * the stored state cannot be read, an event fails the host's limits, or an
 * event cannot be emitted.
 */
export const pollLinearNotifications = (
  authorization: string,
  context: IngestContext,
): Effect.Effect<PollResult, AuthError | PluginError | LinearRateLimited, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const pollMillis = yield* Clock.currentTimeMillis;
    const pollTime = new Date(pollMillis).toISOString();
    const stored = yield* readFeedState(context.state, NOTIFICATIONS_STATE);
    // What an earlier poll wrote but may not have emitted. The state keeps it
    // until this poll writes its own, so a failure from here on emits it again.
    if (Option.isSome(stored)) {
      yield* Effect.forEach(stored.value.outbox, context.emit, { discard: true });
    }
    if (Option.isNone(stored)) {
      // Linear lists the inbox newest first, so the first page holds where it stands.
      const inbox = yield* callLinear(
        authorization,
        { name: "LinearInbox", text: INBOX_QUERY, variables: { first: MAX_PAGE_SIZE } },
        InboxAnswer,
      );
      yield* writeFeedState(context.state, NOTIFICATIONS_STATE, {
        cursor: advanceCursor(null, sortOldestFirst(inbox.notifications.nodes)),
        mentions: {},
        outbox: [],
      });
      return {};
    }
    const state = stored.value;
    // `last` takes the oldest of the notifications created since the cursor,
    // because Linear lists them newest first.
    const inbox = yield* callLinear(
      authorization,
      {
        name: "LinearInbox",
        text: INBOX_QUERY,
        variables: {
          filter: state.cursor === null ? null : { createdAt: { gte: state.cursor.createdAt } },
          last: MAX_PAGE_SIZE,
        },
      },
      InboxAnswer,
    );
    const workspace = inbox.organization;
    const userId = inbox.viewer.id;
    const seen = new Set(state.cursor?.ids ?? []);
    const unread = sortOldestFirst(inbox.notifications.nodes).filter(
      (notification) => !seen.has(notification.id),
    );

    // Check the recorded mentions whose thread has an open signal for Done in Linear.
    const signalRefs = new Set(
      (yield* context.openSignals())
        .filter((signal) => signal.kind === MENTION_SIGNAL_KIND)
        .map((signal) => signal.threadRef),
    );
    const mentions: Record<string, RecordedMention> = {};
    for (const [ref, mention] of Object.entries(state.mentions)) {
      const inGrace = Date.parse(mention.recordedAt) >= pollMillis - MENTION_GRACE_MILLIS;
      if (signalRefs.has(ref) || inGrace) mentions[ref] = mention;
    }
    const checkedIds = Object.entries(mentions)
      .filter(([ref]) => signalRefs.has(ref))
      .map(([, mention]) => mention.notificationId);
    const archivedEvents: Array<EmittedEvent> = [];
    if (checkedIds.length > 0) {
      const checked = yield* readPages(
        authorization,
        {
          name: "LinearMentionLookup",
          text: MENTION_LOOKUP_QUERY,
          variables: { filter: { id: { in: checkedIds } } },
        },
        "notifications",
        ApiNotification,
        Math.ceil(checkedIds.length / MAX_PAGE_SIZE),
      );
      // A notification missing from the answer was deleted, not marked Done,
      // so it ends nothing; its entry stays while the signal is open.
      for (const notification of checked.items) {
        if (notification.archivedAt === null) continue;
        const topic = buildNotificationTopic(workspace, notification, userId);
        archivedEvents.push(
          buildNotificationEvent({
            kind: "linear.notification.archived",
            workspace,
            notification,
            topic,
            fields: { notificationId: notification.id },
            pollTime,
          }),
        );
        if (mentions[topic.ref]?.notificationId === notification.id) delete mentions[topic.ref];
      }
    }

    // A newer mention on a thread replaces the recorded one, as its signal
    // replaces the open one.
    const newEvents: Array<EmittedEvent> = [];
    for (const notification of unread) {
      const read = readNotification(workspace, userId, notification, pollTime);
      if (read === undefined) continue;
      newEvents.push(read.event);
      if (read.mention !== undefined) {
        mentions[read.mention.ref] = {
          notificationId: read.mention.notificationId,
          recordedAt: pollTime,
        };
      }
    }

    // An event the host would refuse must never reach the outbox, where it
    // would fail every later poll. So nothing is written when one fails.
    const events = [...archivedEvents, ...newEvents];
    yield* Effect.forEach(events, (event) => checkEmittedEvent(LINEAR_EVENT_KINDS, event), {
      discard: true,
    });
    const next = { cursor: advanceCursor(state.cursor, unread), mentions };
    yield* writeFeedState(context.state, NOTIFICATIONS_STATE, {
      ...next,
      outbox: events as ReadonlyArray<OutboxEvent>,
    });
    if (events.length > 0) {
      yield* Effect.forEach(events, context.emit, { discard: true });
      yield* writeFeedState(context.state, NOTIFICATIONS_STATE, { ...next, outbox: [] });
    }
    return {};
  });
