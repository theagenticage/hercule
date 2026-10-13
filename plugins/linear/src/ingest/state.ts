/**
 * What the two feeds remember between polls, in the Connection's key-value
 * store, each feed under its own key. The host deletes the state when the
 * Connection is deleted or the plugin's state is reset, and a feed with no
 * state baselines again, so deleting it is always safe.
 *
 * Both states carry an outbox: the events the last poll computed and has not
 * finished emitting. A poll writes them together with its new state, then
 * emits them, then empties the outbox. The next poll emits whatever is still
 * there first, and the dedup keys absorb the ones already emitted.
 */
import { Effect, Option, Schema } from "effect";
import { PluginError, type KeyValueStore } from "@hercule/plugin-host";
import { IssueBlock } from "../kinds";

/**
 * An event as it is stored in the outbox: the same fields as the
 * `EmittedEvent` a poll passes to `emit`, all of them JSON.
 */
export const OutboxEvent = Schema.Struct({
  kind: Schema.String,
  dedupKey: Schema.String,
  occurredAt: Schema.String,
  payload: Schema.Json,
  refs: Schema.Array(Schema.String),
  url: Schema.optionalKey(Schema.String),
  system: Schema.optionalKey(Schema.String),
  raw: Schema.optionalKey(Schema.JsonObject),
  title: Schema.String,
  author: Schema.NullOr(Schema.String),
});

export type OutboxEvent = Schema.Schema.Type<typeof OutboxEvent>;

/**
 * An issue the `issues` feed follows because the Connection has an open
 * `linear/mention` or `linear/assigned` signal on it, as the last poll saw it.
 * `issue` lets an issue Linear deleted still get a `closed` event with its
 * title. `closed` is whether it was closed then: a followed issue gets a
 * `closed` event only when it closes while followed, so a mention on an issue
 * that is already closed is not ended at once.
 */
export const FollowedIssue = Schema.Struct({ issue: IssueBlock, closed: Schema.Boolean });

export type FollowedIssue = Schema.Schema.Type<typeof FollowedIssue>;

/** The state of the `issues` feed. */
export const IssuesState = Schema.Struct({
  /** The fingerprint of the filter the watched set was listed with. */
  filter: Schema.String,
  /** The watched set as the last poll listed it, by issue id. */
  issues: Schema.Record(Schema.String, IssueBlock),
  /** The followed issues, by issue id. */
  followed: Schema.Record(Schema.String, FollowedIssue),
  outbox: Schema.Array(OutboxEvent),
});

export type IssuesState = Schema.Schema.Type<typeof IssuesState>;

/**
 * The newest notification time the `notifications` feed has read, and the
 * ids it has read at that time, because two notifications can share one.
 */
export const NotificationCursor = Schema.Struct({
  createdAt: Schema.String,
  ids: Schema.Array(Schema.String),
});

/**
 * The notification of the newest mention on one thread, and when the poll
 * that emitted it ran. The feed checks it for Done in Linear while the
 * thread has an open `linear/mention` signal.
 */
export const RecordedMention = Schema.Struct({
  notificationId: Schema.String,
  recordedAt: Schema.String,
});

export type RecordedMention = Schema.Schema.Type<typeof RecordedMention>;

/** The state of the `notifications` feed. */
export const NotificationsState = Schema.Struct({
  /** Null while the inbox was empty at every poll so far. */
  cursor: Schema.NullOr(NotificationCursor),
  /** The newest mention on each thread, by the thread's External Ref. */
  mentions: Schema.Record(Schema.String, RecordedMention),
  outbox: Schema.Array(OutboxEvent),
});

export type NotificationsState = Schema.Schema.Type<typeof NotificationsState>;

/** Where one feed keeps its state: the key and the schema. */
export interface FeedState<S extends Schema.Codec<unknown, unknown>> {
  readonly key: string;
  readonly schema: S;
}

export const ISSUES_STATE = { key: "issues", schema: IssuesState } as const;

export const NOTIFICATIONS_STATE = { key: "notifications", schema: NotificationsState } as const;

/**
 * Reads a feed's state and decodes it. Returns `Option.none()` when there is
 * none. Fails with a `PluginError` when the stored value has another shape,
 * which only a different version of this plugin could have written: the feed
 * stops rather than guess, and the message tells the user how to start it
 * afresh.
 */
export const readFeedState = <S extends Schema.Codec<unknown, unknown>>(
  store: KeyValueStore,
  feed: FeedState<S>,
): Effect.Effect<Option.Option<S["Type"]>, PluginError> =>
  Effect.flatMap(store.get(feed.key), (stored) => {
    if (Option.isNone(stored)) return Effect.succeed(Option.none());
    return Schema.decodeUnknownEffect(feed.schema)(stored.value).pipe(
      Effect.map(Option.some),
      Effect.mapError(
        (error) =>
          new PluginError({
            message:
              `The Linear plugin could not read the stored state of its ${feed.key} feed: ${error.message}. ` +
              "Reset the plugin's state in Settings to start its feeds again from now.",
          }),
      ),
    );
  });

/** Stores a feed's state. */
export const writeFeedState = <S extends Schema.Codec<unknown, unknown>>(
  store: KeyValueStore,
  feed: FeedState<S>,
  state: S["Type"],
): Effect.Effect<void, PluginError> =>
  Effect.flatMap(
    Schema.encodeEffect(feed.schema)(state).pipe(
      Effect.mapError((error) => new PluginError({ message: error.message })),
    ),
    (encoded) => store.set(feed.key, encoded as Schema.Json),
  );
