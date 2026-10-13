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
 * of an issue while a signal it raised may be open (`RaisingNotification`),
 * so the `issues` feed can end the signal of an issue Linear deleted.
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
  type OpenSignal,
  type PollResult,
} from "@hercule/plugin-host";
import {
  callLinear,
  MAX_PAGE_SIZE,
  readPages,
  type LinearFailure,
  type LinearRateLimited,
} from "../api";
import type { WorkspaceBlock } from "../kinds";
import {
  ApiNotification,
  buildDescription,
  buildIssueBlock,
  buildMentionComment,
  buildUser,
  NOTIFICATION_FRAGMENT,
  VIEWER_FIELDS,
  ViewerFields,
} from "../linear-objects";
import { buildNotificationEvent, buildNotificationTopic } from "./events";
import {
  commitPoll,
  emitStoredOutbox,
  MENTION_SIGNAL_KIND,
  NOTIFICATIONS_STATE,
  readFeedState,
  type NotificationsState,
  type RaisingNotification,
} from "./state";

/**
 * How long a recorded notification is kept when no open signal belongs to
 * it. The core raises a signal after it stores the event, not at once, so a
 * notification emitted by one poll may have no signal yet at the next. A
 * day is far longer than a raise takes, so a record whose signal is still
 * on its way is not dropped.
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
const INBOX_START_QUERY = `query LinearInboxStart($first: Int, $after: String) {
  notifications(first: $first, after: $after) {
    nodes { id createdAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

const InboxStartAnswer = Schema.Struct({
  notifications: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ id: Schema.String, createdAt: Schema.String })),
    pageInfo: Schema.Struct({
      hasNextPage: Schema.Boolean,
      endCursor: Schema.NullOr(Schema.String),
    }),
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
 * Returns the recorded notifications to keep: each one an open signal was
 * raised from, found by the dedup key of the signal's event, and each one recorded
 * less than `RECORD_WITHOUT_SIGNAL_MILLIS` before the poll, whose signal may
 * still be on its way.
 */
const keepRaisingNotifications = (
  raising: Readonly<Record<string, RaisingNotification>>,
  openSignals: ReadonlyArray<OpenSignal>,
  pollMillis: number,
): Record<string, RaisingNotification> => {
  const raisedFrom = new Set(openSignals.map((signal) => signal.event.dedupKey));
  return Object.fromEntries(
    Object.entries(raising).filter(
      ([id, record]) =>
        raisedFrom.has(id) ||
        Date.parse(record.recordedAt) > pollMillis - RECORD_WITHOUT_SIGNAL_MILLIS,
    ),
  );
};

/**
 * Reads where the inbox stands, for the first poll: the newest notifications,
 * ids and times only. Linear lists newest first, so the first page holds the
 * newest time. More pages are read while a page ends at that time, so the
 * cursor holds every id created at it and the next poll emits none of them.
 * Fails with a `PluginError` past `MAX_INBOX_PAGES` pages, and as
 * `callLinear` does otherwise.
 */
const readInboxStart = (
  authorization: string,
): Effect.Effect<ReadonlyArray<NotificationTime>, LinearFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const read: Array<NotificationTime> = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_INBOX_PAGES; page += 1) {
      const answer: typeof InboxStartAnswer.Type = yield* callLinear(
        authorization,
        {
          name: "LinearInboxStart",
          text: INBOX_START_QUERY,
          variables: { first: MAX_PAGE_SIZE, after },
        },
        InboxStartAnswer,
      );
      const { nodes, pageInfo } = answer.notifications;
      read.push(...nodes);
      const newest = read[0];
      const last = nodes.at(-1);
      const endsAtNewest =
        newest !== undefined &&
        last !== undefined &&
        Date.parse(last.createdAt) === Date.parse(newest.createdAt);
      if (!endsAtNewest || !pageInfo.hasNextPage || pageInfo.endCursor === null) return read;
      after = pageInfo.endCursor;
    }
    return yield* new PluginError({
      message: `Linear listed more than ${String(MAX_INBOX_PAGES * MAX_PAGE_SIZE)} notifications created at one time, more than an inbox keeps.`,
    });
  });

/**
 * What one new notification turns into: its event, and for a mention or an
 * assignment on an issue, the notification to record.
 */
interface NotificationOutcome {
  readonly event: EmittedEvent;
  readonly raised?: RaisingNotification;
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
  const raised: RaisingNotification | undefined =
    topic.issue === undefined
      ? undefined
      : { issue: buildIssueBlock(topic.issue), recordedAt: pollTime };
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
      ...(raised === undefined ? {} : { raised }),
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
      ...(raised === undefined ? {} : { raised }),
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
 * - Each poll also reads, in one query, the notifications that raised the
 *   open `linear/mention` signals, and emits `linear.notification.archived`
 *   for each one that was archived.
 *
 * Fails with an `AuthError` when Linear refuses the credential, with
 * `LinearRateLimited` when it rate limits the poll, and with a `PluginError`
 * when:
 *
 * - more than 2,000 notifications were created since the cursor, or at the
 *   newest time on the first poll;
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
      const start = yield* readInboxStart(authorization);
      yield* commitPoll(
        context,
        NOTIFICATIONS_STATE,
        stored,
        { cursor: advanceCursor(null, sortOldestFirst(start)), raising: {} },
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
    const raising = keepRaisingNotifications(state.raising, openSignals, pollMillis);

    // Check the notifications that raised the open mention signals for Done
    // in Linear. A mention's dedup key is its notification's id.
    const checkedIds = [
      ...new Set(
        openSignals
          .filter((signal) => signal.kind === MENTION_SIGNAL_KIND)
          .map((signal) => signal.event.dedupKey),
      ),
    ];
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
      // so it ends nothing. An archived one is found again at each poll until
      // the core ends its signal, and the dedup key absorbs the repeats.
      for (const notification of checked.items) {
        if (notification.archivedAt === null) continue;
        archivedEvents.push(
          buildNotificationEvent({
            kind: "linear.notification.archived",
            workspace,
            notification,
            topic: buildNotificationTopic(workspace, notification, userId),
            fields: { notificationId: notification.id },
            pollTime,
          }),
        );
      }
    }

    const newEvents: Array<EmittedEvent> = [];
    for (const notification of taken) {
      const outcome = decideNotificationEvent(workspace, userId, notification, pollTime);
      if (outcome === undefined) continue;
      newEvents.push(outcome.event);
      if (outcome.raised !== undefined) raising[notification.id] = outcome.raised;
    }

    yield* commitPoll(
      context,
      NOTIFICATIONS_STATE,
      stored,
      { cursor: advanceCursor(state.cursor, taken), raising },
      [...archivedEvents, ...newEvents],
    );
    return {};
  });
