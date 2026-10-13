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
import {
  checkEmittedEvent,
  PluginError,
  type EmittedEvent,
  type IngestContext,
  type KeyValueStore,
  type OpenSignal,
} from "@hercule/plugin-host";
import { IssueBlock, LINEAR_EVENT_KINDS } from "../kinds";

/**
 * An event as it is stored in the outbox: the same fields as the
 * `EmittedEvent` a poll passes to `emit`, all of them JSON.
 */
const OutboxEvent = Schema.Struct({
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

/** The signal kind a `linear.mentioned` event raises. */
export const MENTION_SIGNAL_KIND = "linear/mention";

/** The signal kind a `linear.assigned` event raises. */
export const ASSIGNED_SIGNAL_KIND = "linear/assigned";

/**
 * For one issue the `issues` feed follows, the `raisedAt` of the newest
 * signal each end event was emitted for. A later poll emits the same end
 * again only for a signal raised after that time, so an end the core has not
 * applied yet is not emitted at every poll.
 */
const EmittedEnds = Schema.Struct({
  closed: Schema.optionalKey(Schema.String),
  unassigned: Schema.optionalKey(Schema.String),
});

export type EmittedEnds = Schema.Schema.Type<typeof EmittedEnds>;

/** The state of the `issues` feed. */
const IssuesState = Schema.Struct({
  /** The fingerprint of the filter the watched set was listed with. */
  filter: Schema.String,
  /** The watched set as the last poll listed it, by issue id. */
  issues: Schema.Record(Schema.String, IssueBlock),
  /** The end events emitted for the followed issues, by issue id. */
  ended: Schema.Record(Schema.String, EmittedEnds),
  outbox: Schema.Array(OutboxEvent),
});

/**
 * The newest notification time the `notifications` feed has read, and the
 * ids it has read at that time, because two notifications can share one.
 */
const NotificationCursor = Schema.Struct({
  createdAt: Schema.String,
  ids: Schema.Array(Schema.String),
});

/**
 * The notification behind one `linear.mentioned` or `linear.assigned` event,
 * kept while a signal it raised may be open. A newer notification on the
 * same thread never replaces it: the newer event's signal may never be
 * raised, for example when an Ignore Rule catches it, and then the older
 * signal stays open and still needs its own notification.
 *
 * - `kind` and `threadRef` are the signal the event raises.
 * - `createdAt` is when Linear created the notification. The `issues` feed
 *   ends a followed issue's signal as closed only when the issue closed
 *   after this time.
 * - `issue` is the issue as the notification showed it, so an issue Linear
 *   deleted still gets a `closed` event with its title. It is null for a
 *   mention on a project or a document.
 * - `recordedAt` is when the poll that emitted the event ran.
 */
const RaisingNotification = Schema.Struct({
  kind: Schema.Literals([MENTION_SIGNAL_KIND, ASSIGNED_SIGNAL_KIND]),
  threadRef: Schema.String,
  createdAt: Schema.String,
  issue: Schema.NullOr(IssueBlock),
  recordedAt: Schema.String,
});

export type RaisingNotification = Schema.Schema.Type<typeof RaisingNotification>;

/** The state of the `notifications` feed. */
const NotificationsState = Schema.Struct({
  /** Null while the inbox was empty at every poll so far. */
  cursor: Schema.NullOr(NotificationCursor),
  /** The notifications behind the mentions and assignments, by notification id. */
  raising: Schema.Record(Schema.String, RaisingNotification),
  outbox: Schema.Array(OutboxEvent),
});

export type NotificationsState = Schema.Schema.Type<typeof NotificationsState>;

/**
 * Finds the notification that raised an open signal: the newest recorded
 * notification of the signal's kind on its thread that Linear created at or
 * before the signal's `raisedAt`. Returns the notification's id and record,
 * or undefined when none is recorded.
 *
 * This holds because of how the core writes signals (`writeSignal` in
 * apps/controller/src/signals/raises.ts), and `raisedAt` is the time the
 * signal was written:
 *
 * - a signal is written after its event is stored, so after the notification
 *   was created;
 * - a newer event's signal replaces the open one, so its `raisedAt` is after
 *   the newer notification;
 * - a newer event an Ignore Rule catches raises nothing, so the open signal
 *   keeps its `raisedAt`, which is before the newer notification.
 *
 * It relies on Linear's clock and the controller's agreeing to within the
 * time between a notification and the poll that reads it.
 */
export const findRaisingNotification = (
  raising: Readonly<Record<string, RaisingNotification>>,
  signal: OpenSignal,
): readonly [string, RaisingNotification] | undefined => {
  const raisedAt = Date.parse(signal.raisedAt);
  let found: readonly [string, RaisingNotification] | undefined;
  for (const [id, record] of Object.entries(raising)) {
    if (record.kind !== signal.kind || record.threadRef !== signal.threadRef) continue;
    const createdAt = Date.parse(record.createdAt);
    if (createdAt > raisedAt) continue;
    if (found === undefined || createdAt > Date.parse(found[1].createdAt)) found = [id, record];
  }
  return found;
};

/** Where one feed keeps its state: the key and the schema. */
interface FeedState<T> {
  readonly key: string;
  readonly schema: Schema.Codec<T, unknown>;
}

export const ISSUES_STATE: FeedState<Schema.Schema.Type<typeof IssuesState>> = {
  key: "issues",
  schema: IssuesState,
};

export const NOTIFICATIONS_STATE: FeedState<NotificationsState> = {
  key: "notifications",
  schema: NotificationsState,
};

/**
 * Reads a feed's state and decodes it. Returns `Option.none()` when there is
 * none. Fails with a `PluginError` when the stored value has another shape,
 * which only a different version of this plugin could have written: the feed
 * stops rather than guess, and the message tells the user how to start it
 * afresh.
 */
export const readFeedState = <T>(
  store: KeyValueStore,
  feed: FeedState<T>,
): Effect.Effect<Option.Option<T>, PluginError> =>
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

/** Stores a feed's state. Fails with a `PluginError` when it cannot be encoded or stored. */
const writeFeedState = <T>(
  store: KeyValueStore,
  feed: FeedState<T>,
  state: T,
): Effect.Effect<void, PluginError> =>
  Effect.flatMap(
    Schema.encodeEffect(feed.schema)(state).pipe(
      Effect.mapError((error) => new PluginError({ message: error.message })),
    ),
    (encoded) => store.set(feed.key, encoded as Schema.Json),
  );

/**
 * Emits the outbox of the stored state: the events an earlier poll wrote but
 * may not have emitted. The state keeps them until this poll writes its own,
 * so a poll that fails after this emits them again, and the dedup keys
 * absorb the repeats. Fails as `emit` does.
 */
export const emitStoredOutbox = (
  context: IngestContext,
  stored: Option.Option<{ readonly outbox: ReadonlyArray<OutboxEvent> }>,
): Effect.Effect<void, PluginError> =>
  Option.isNone(stored)
    ? Effect.void
    : Effect.forEach(stored.value.outbox, context.emit, { discard: true });

/**
 * Ends one poll of a feed: checks its events, stores its new state with the
 * events as the outbox, emits them, and stores the state again with an empty
 * outbox. Writes nothing when there are no events and the state equals the
 * stored one, so an idle feed does not rewrite its state at every poll.
 *
 * Fails with a `PluginError`, before anything is written, when an event
 * fails the host's checks: an event the host refuses must never reach the
 * outbox, where it would fail every later poll. Fails as `emit` and the
 * store do otherwise.
 */
export const commitPoll = <T extends { readonly outbox: ReadonlyArray<OutboxEvent> }>(
  context: IngestContext,
  feed: FeedState<T>,
  stored: Option.Option<T>,
  next: Omit<T, "outbox">,
  events: ReadonlyArray<EmittedEvent>,
): Effect.Effect<void, PluginError> =>
  Effect.gen(function* () {
    yield* Effect.forEach(events, (event) => checkEmittedEvent(LINEAR_EVENT_KINDS, event), {
      discard: true,
    });
    const settled = { ...next, outbox: [] } as unknown as T;
    if (
      events.length === 0 &&
      Option.isSome(stored) &&
      Schema.toEquivalence(feed.schema)(stored.value, settled)
    ) {
      return;
    }
    yield* writeFeedState(context.state, feed, {
      ...next,
      outbox: events as ReadonlyArray<OutboxEvent>,
    } as unknown as T);
    if (events.length === 0) return;
    yield* Effect.forEach(events, context.emit, { discard: true });
    yield* writeFeedState(context.state, feed, settled);
  });
