/**
 * What the `issues` feed remembers between polls, in the Connection's
 * key-value store, under one key. The host deletes it when the Connection is
 * deleted or the plugin's state is reset, and a feed with no state baselines
 * again, so deleting it is always safe.
 */
import { Effect, Option, Schema } from "effect";
import { PluginError, type KeyValueStore } from "@hercule/plugin-host";
import { IssueBlock } from "../kinds";

/** The key the feed's whole state is stored under. */
const STATE_KEY = "watched";

/**
 * One issue in the watched set.
 *
 * `issue` is the issue as the last poll listed it. It holds the `substatus`
 * and `lastSeen` the next poll compares with. It also holds everything an
 * event about the issue needs, so that an issue Sentry deleted, which can no
 * longer be read, still gets a `left` event with its title and link.
 *
 * `regressionActivityId` is the id of the newest `set_regression` activity
 * the plugin has seen on the issue. It is absent until the plugin reads the
 * issue's detail.
 *
 * `since` is the ISO time of the poll that added the issue to the set. It
 * stays the same while the issue stays in the set, and the events that end the
 * issue's signals are keyed by it: one key per stay.
 *
 * `recheck` is true when the read budget deferred the issue's regression
 * check. The entry then keeps its old `lastSeen`, and the next poll reads the
 * issue's detail whatever its substatus has become since, so a regression is
 * not lost when Sentry has moved the issue on to `ongoing`.
 */
export const WatchedIssue = Schema.Struct({
  issue: IssueBlock,
  regressionActivityId: Schema.optionalKey(Schema.String),
  since: Schema.String,
  recheck: Schema.optionalKey(Schema.Boolean),
});

export type WatchedIssue = Schema.Schema.Type<typeof WatchedIssue>;

/**
 * An issue that left the watched set as resolved or archived, and when.
 * `lastSeen` and `regressionActivityId` are what the last poll stored for the
 * issue before it left. They tell a later regression from an older one.
 */
export const LeftIssue = Schema.Struct({
  as: Schema.Literals(["resolved", "archived"]),
  /** An ISO timestamp: the poll that saw the issue leave. */
  leftAt: Schema.String,
  lastSeen: Schema.String,
  regressionActivityId: Schema.optionalKey(Schema.String),
});

export type LeftIssue = Schema.Schema.Type<typeof LeftIssue>;

/**
 * An event as it is stored in the outbox: the same fields as the
 * `EmittedEvent` the poll passes to `emit`, all of them JSON.
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

/** The whole state of the feed. */
export const WatchState = Schema.Struct({
  /** A fingerprint of the filter the set was listed with. */
  filter: Schema.String,
  /** The watched set, by issue id. */
  issues: Schema.Record(Schema.String, WatchedIssue),
  /** The issues that left as resolved or archived in the last 90 days, by issue id. */
  left: Schema.Record(Schema.String, LeftIssue),
  /**
   * The events the last poll computed and has not finished emitting. A poll
   * writes them here together with the new set, then emits them, then empties
   * this list. The next poll emits whatever is still here first, and the
   * dedup keys absorb the ones that were already emitted.
   */
  outbox: Schema.Array(OutboxEvent),
});

export type WatchState = Schema.Schema.Type<typeof WatchState>;

/**
 * Reads the feed's state and decodes it. Returns `Option.none()` when there
 * is none. Fails with a `PluginError` when the stored value has another
 * shape, which only a different version of this plugin could have written:
 * the feed stops rather than guess, and the message tells the user how to
 * start it afresh.
 */
export const readWatchState = (
  store: KeyValueStore,
): Effect.Effect<Option.Option<WatchState>, PluginError> =>
  Effect.flatMap(store.get(STATE_KEY), (stored) => {
    if (Option.isNone(stored)) return Effect.succeed(Option.none());
    return Schema.decodeUnknownEffect(WatchState)(stored.value).pipe(
      Effect.map(Option.some),
      Effect.mapError(
        (error) =>
          new PluginError({
            message:
              `The Sentry plugin could not read its stored state: ${error.message}. ` +
              "Reset the plugin's state in Settings to start the issues feed again from now.",
          }),
      ),
    );
  });

/** Stores the feed's state. */
export const writeWatchState = (
  store: KeyValueStore,
  state: WatchState,
): Effect.Effect<void, PluginError> =>
  Effect.flatMap(
    Schema.encodeEffect(WatchState)(state).pipe(
      Effect.mapError((error) => new PluginError({ message: error.message })),
    ),
    (encoded) => store.set(STATE_KEY, encoded as Schema.Json),
  );
