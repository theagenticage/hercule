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
 * The feed also keeps the notification behind each mention and assignment
 * while its signal may be open (`RaisingNotification`). It looks the mentions
 * up for Done in Linear, and the `issues` feed reads both to decide when a
 * followed issue's signal ends.
 *
 * The outbox works as in the `issues` feed: events and state are written in
 * one write before the events are emitted (`commitPoll`).
 */
import { Clock, Effect, Option, Schema } from "effect";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import {
  PluginError,
  type AuthError,
  type EmittedEvent,
  type IngestContext,
  type PollResult,
} from "@hercule/plugin-host";
import { callLinear, MAX_PAGE_SIZE, readPages, type LinearRateLimited } from "../api";
import type { WorkspaceBlock } from "../kinds";
import {
  ApiNotification,
  buildDescription,
  buildIssueBlock,
  buildMentionComment,
  buildUser,
  normalizeTimestamp,
  NOTIFICATION_FRAGMENT,
  VIEWER_FIELDS,
  ViewerFields,
} from "../linear-objects";
import { buildNotificationEvent, buildNotificationTopic } from "./events";
import {
  ASSIGNED_SIGNAL_KIND,
  commitPoll,
  emitStoredOutbox,
  MENTION_SIGNAL_KIND,
  NOTIFICATIONS_STATE,
  readFeedState,
  type NotificationsState,
  type RaisingNotification,
} from "./state";

/**
 * How long a recorded notification is kept while no poll has seen its signal
 * open. The core raises a signal after it stores the event, not at once, so
 * a notification emitted by one poll may have no signal yet at the next. One
 * whose signal no poll saw in this time will never get one, and is dropped.
 */
const RECORD_WITHOUT_SIGNAL_MILLIS = 24 * 60 * 60_000;

/**
 * The most pages of the inbox a poll reads: 2,000 notifications, the most
 * Linear keeps in one inbox. More than that since the cursor means Linear
 * does not behave as recorded, and the poll fails rather than diff a part.
 */
const MAX_INBOX_PAGES = 8;

/** The most new notifications one poll emits. The rest wait for the next poll. */
const MAX_NEW_PER_POLL = 250;

/** The query that reads the workspace and the signed-in user. */
const IDENTITY_QUERY = `query LinearIdentity { ${VIEWER_FIELDS} }`;

const IdentityAnswer = Schema.Struct(ViewerFields);

/** The query the first poll reads where the inbox stands with: the newest notifications, ids and times only. */
const INBOX_START_QUERY = `query LinearInboxStart($first: Int) {
  notifications(first: $first) { nodes { id createdAt } }
}`;

const InboxStartAnswer = Schema.Struct({
  notifications: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ id: Schema.String, createdAt: Schema.String })),
  }),
});

/** The query that reads the inbox page by page, newest first. */
const INBOX_QUERY = `query LinearInbox($filter: NotificationFilter, $first: Int, $after: String) {
  notifications(filter: $filter, first: $first, after: $after) {
    nodes { ...NotificationFields }
    pageInfo { hasNextPage endCursor }
  }
}
${NOTIFICATION_FRAGMENT}`;

/** The query that reads notifications by id, archived ones included. */
const MENTION_LOOKUP_QUERY = `query LinearMentionLookup($filter: NotificationFilter, $first: Int, $after: String) {
  notifications(filter: $filter, first: $first, after: $after, includeArchived: true) {
    nodes { ...NotificationFields }
    pageInfo { hasNextPage endCursor }
  }
}
${NOTIFICATION_FRAGMENT}`;

/** A notification as the cursor needs it: its id and when it was created. */
interface NotificationTime {
  readonly id: string;
  readonly createdAt: string;
}

/**
 * Returns the notifications sorted oldest first, by `createdAt`, and by id
 * among those created at the same time, so the order is the same at every
 * poll.
 */
const sortOldestFirst = <N extends NotificationTime>(
  notifications: ReadonlyArray<N>,
): ReadonlyArray<N> =>
  [...notifications].sort(
    (a, b) =>
      Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

/**
 * Returns the cursor after reading `read`, sorted oldest first: the newest
 * `createdAt` and every id read at that time, with the cursor's own ids when
 * the time is the cursor's. Returns `cursor` unchanged when nothing was read.
 */
const advanceCursor = (
  cursor: NotificationsState["cursor"],
  read: ReadonlyArray<NotificationTime>,
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

/**
 * Returns the recorded notifications to keep, by thread, given the threads
 * that have an open signal of their kind now:
 *
 * - one whose signal is open is kept, and marked as seen open;
 * - one whose signal was seen open and is gone now is dropped;
 * - one whose signal no poll has seen is kept for
 *   `RECORD_WITHOUT_SIGNAL_MILLIS` after it was recorded.
 */
const keepRaisingNotifications = (
  records: Readonly<Record<string, RaisingNotification>>,
  openThreads: ReadonlySet<string>,
  pollMillis: number,
): Record<string, RaisingNotification> => {
  const kept: Record<string, RaisingNotification> = {};
  for (const [ref, record] of Object.entries(records)) {
    if (openThreads.has(ref)) {
      kept[ref] = { ...record, signalSeen: true };
    } else if (
      !record.signalSeen &&
      Date.parse(record.recordedAt) > pollMillis - RECORD_WITHOUT_SIGNAL_MILLIS
    ) {
      kept[ref] = record;
    }
  }
  return kept;
};

/**
 * What one new notification turns into: its event, and for a mention or an
 * assignment, the notification to record under the thread's ref.
 */
interface NotificationOutcome {
  readonly event: EmittedEvent;
  readonly raised?: {
    readonly records: "mentions" | "assignments";
    readonly ref: string;
    readonly record: RaisingNotification;
  };
}

/**
 * Decides the event one new notification becomes. Returns undefined for a
 * notification the user caused, because assigning yourself is your own move,
 * and Linear does not document whether mentioning yourself notifies you.
 *
 * A mention or an assignment with no actor (an integration, or Linear
 * itself) becomes a plain `linear.notification`, because those kinds name
 * who mentioned or assigned the user.
 */
const decideNotificationEvent = (
  workspace: WorkspaceBlock,
  userId: string,
  notification: ApiNotification,
  pollTime: string,
): NotificationOutcome | undefined => {
  const { actor } = notification;
  if (actor?.id === userId) return undefined;
  const topic = buildNotificationTopic(workspace, notification, userId);
  const base = { workspace, notification, topic, pollTime };
  const record: RaisingNotification = {
    notificationId: notification.id,
    createdAt: normalizeTimestamp(notification.createdAt, pollTime),
    issue: topic.issue === undefined ? null : buildIssueBlock(topic.issue),
    recordedAt: pollTime,
    signalSeen: false,
  };
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
      raised: { records: "mentions", ref: topic.ref, record },
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
      raised: { records: "assignments", ref: topic.ref, record },
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
 * - A later poll reads every notification created at or after the cursor's
 *   time, newest first, page by page, and drops the ids the cursor has read.
 *   It emits the oldest 250 of the rest; the others wait for the next poll.
 * - Each poll also reads, in one query, the notifications of the recorded
 *   mentions whose thread has an open `linear/mention` signal, and emits
 *   `linear.notification.archived` for each one that was archived.
 *
 * Fails with an `AuthError` when Linear refuses the credential, with
 * `LinearRateLimited` when it rate limits the poll, and with a `PluginError`
 * when:
 *
 * - more than 2,000 notifications were created since the cursor;
 * - Linear fails or answers in a shape the plugin does not know;
 * - the stored state cannot be read, an event fails the host's limits, or an
 *   event cannot be emitted.
 */
export const pollLinearNotifications = (
  authorization: string,
  context: IngestContext,
): Effect.Effect<PollResult, AuthError | PluginError | LinearRateLimited, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const pollMillis = yield* Clock.currentTimeMillis;
    const pollTime = new Date(pollMillis).toISOString();
    const stored = yield* readFeedState(context.state, NOTIFICATIONS_STATE);
    yield* emitStoredOutbox(context, stored);
    if (Option.isNone(stored)) {
      // Linear lists the inbox newest first, so the first page holds where it stands.
      const start = yield* callLinear(
        authorization,
        { name: "LinearInboxStart", text: INBOX_START_QUERY, variables: { first: MAX_PAGE_SIZE } },
        InboxStartAnswer,
      );
      yield* commitPoll(
        context,
        NOTIFICATIONS_STATE,
        stored,
        {
          cursor: advanceCursor(null, sortOldestFirst(start.notifications.nodes)),
          mentions: {},
          assignments: {},
        },
        [],
      );
      return {};
    }
    const state = stored.value;
    const identity = yield* callLinear(
      authorization,
      { name: "LinearIdentity", text: IDENTITY_QUERY },
      IdentityAnswer,
    );
    const workspace = identity.organization;
    const userId = identity.viewer.id;
    const inbox = yield* readPages(
      authorization,
      {
        name: "LinearInbox",
        text: INBOX_QUERY,
        variables: {
          filter: state.cursor === null ? null : { createdAt: { gte: state.cursor.createdAt } },
        },
      },
      "notifications",
      ApiNotification,
      MAX_INBOX_PAGES,
    );
    if (inbox.hasMore) {
      return yield* new PluginError({
        message:
          "Linear listed more than 2,000 notifications created since the last poll, more than an inbox keeps. Reset the plugin's state in Settings to start the feed again from now.",
      });
    }
    const seen = new Set(state.cursor?.ids ?? []);
    const taken = sortOldestFirst(
      inbox.items.filter((notification) => !seen.has(notification.id)),
    ).slice(0, MAX_NEW_PER_POLL);

    const openSignals = yield* context.openSignals();
    const openThreads = (kind: string) =>
      new Set(
        openSignals.filter((signal) => signal.kind === kind).map((signal) => signal.threadRef),
      );
    const mentionThreads = openThreads(MENTION_SIGNAL_KIND);
    const mentions = keepRaisingNotifications(state.mentions, mentionThreads, pollMillis);
    const assignments = keepRaisingNotifications(
      state.assignments,
      openThreads(ASSIGNED_SIGNAL_KIND),
      pollMillis,
    );

    // Check the recorded mentions whose thread has an open signal for Done in Linear.
    const checkedIds = Object.entries(mentions)
      .filter(([ref]) => mentionThreads.has(ref))
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
      if (checked.hasMore) {
        return yield* new PluginError({
          message: `Linear answered the lookup of ${String(checkedIds.length)} notifications by id with more pages than it should need.`,
        });
      }
      // A notification missing from the answer was deleted, not marked Done,
      // so it ends nothing; its record stays while the signal is open.
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

    // A newer mention or assignment on a thread replaces the recorded one,
    // as its signal replaces the open one.
    const records = { mentions, assignments };
    const newEvents: Array<EmittedEvent> = [];
    for (const notification of taken) {
      const outcome = decideNotificationEvent(workspace, userId, notification, pollTime);
      if (outcome === undefined) continue;
      newEvents.push(outcome.event);
      if (outcome.raised !== undefined) {
        records[outcome.raised.records][outcome.raised.ref] = outcome.raised.record;
      }
    }

    yield* commitPoll(
      context,
      NOTIFICATIONS_STATE,
      stored,
      { cursor: advanceCursor(state.cursor, taken), mentions, assignments },
      [...archivedEvents, ...newEvents],
    );
    return {};
  });
