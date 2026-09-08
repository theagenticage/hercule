/**
 * What the controller holds for the clients watching a Live Topic, and what it
 * pushes to them once a transaction has committed.
 *
 * One queue per subscription, grouped by topic. A subscription is taken out for
 * the length of the caller's scope and given back when that scope closes, which
 * is what the client ending its stream and the socket dropping both come down
 * to, so a connection that goes away leaves nothing behind.
 *
 * The two topic families are pushed differently. A mutable topic carries no
 * records, only the news that some changed, so a burst is collected for a short
 * window and announced as one message per way of changing: a screen refetches
 * once for three creates rather than three times, and the window is short enough
 * that nobody sees it.
 *
 * The log carries the records themselves, and a committed transaction only ever
 * says that the log grew - never which rows. Each follower then reads forward
 * from its own position, so the log's own order is the only order there is:
 * nothing can arrive out of order, nothing can be delivered twice, and the
 * replay a subscription opens with is the same read as every push after it. Its
 * first message positions the client whether or not it missed anything; after
 * that it gets one delta per entry.
 *
 * A subscriber that stops reading is ended rather than queued for without
 * bound; the cursor it was last told is enough to come back on.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import {
  capExceeded,
  internal,
  notFound,
  sessionStreamTopic,
  sessionTapTopic,
  validation,
  type CapExceeded,
  type Delta,
  type Event,
  type Internal,
  type InvalidateKind,
  type LiveMessage,
  type LiveTopic,
  type MutableLiveTopic,
  type NotFound,
  type TapItem,
  type TranscriptRow,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { AfterCommit, type Change } from "../db";
import { eventsAfter, headOfLog } from "../events";
import { headOfTranscript, sessionExists, transcriptRowsAfter } from "../sessions";

/**
 * How long a burst of record changes is collected before it is announced, in
 * milliseconds. Long enough that a workflow touching a dozen tasks costs one
 * refetch, short enough that a person clicking a button sees the result as
 * immediate. Exported because a test that watches a push has to outwait it, and
 * a number written twice is a test that goes flaky when this one moves.
 */
export const COALESCE_WINDOW_MS = 50;

const COALESCE_WINDOW = Duration.millis(COALESCE_WINDOW_MS);

/**
 * How many messages may wait for one subscriber before the controller gives up
 * on it. A client that stops reading is either gone or too slow to catch up,
 * and either way holding the log for it costs the controller memory it cannot
 * reclaim. The subscription ends and the client comes back on its cursor.
 */
const SUBSCRIPTION_CAP = 1000;

/** How much of the log one read walks forward at a time. */
const REPLAY_PAGE = 500;

/** The ways a subscription ends other than the client letting it go. */
export type LiveFailure = CapExceeded | Unauthenticated | Internal;

/** One subscription's queue, which is also how it is ended. */
export type LiveQueue = Queue.Queue<LiveMessage, LiveFailure>;

interface Watcher {
  readonly topic: LiveTopic;
  readonly queue: LiveQueue;
  /** Rings when the log has grown. Log subscriptions only. */
  readonly doorbell: Queue.Queue<void> | undefined;
  /** How far down the log this subscription has read. Log subscriptions only. */
  cursor: number;
}

/** The log's own topic: the one that carries records rather than news of them. */
const LOG_TOPIC: LiveTopic = "event";

const TOO_SLOW = "this subscription was not being read; open it again to start over";

const LOG_UNREADABLE = "the event log could not be read";

const SESSION_UNREADABLE = "the session could not be read";

const NO_SUCH_SESSION = "no such session";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const watchers = new Map<LiveTopic, Set<Watcher>>();
  /** Which records changed since the last announcement, by topic and by kind. */
  const pending = new Map<MutableLiveTopic, Map<InvalidateKind, Set<string>>>();
  /** Rings once whenever there is something pending; holds no more than that. */
  const wake = yield* Queue.dropping<void>(1);

  const watchersOf = (topic: LiveTopic): ReadonlySet<Watcher> => watchers.get(topic) ?? new Set();

  const drop = (watcher: Watcher): void => {
    const set = watchers.get(watcher.topic);
    if (set === undefined) return;
    set.delete(watcher);
    if (set.size === 0) watchers.delete(watcher.topic);
  };

  /**
   * Hands one message to one subscriber, and answers whether it is still there
   * to hand the next one to. A subscriber that has stopped taking them is ended
   * rather than queued for: the alternative is a queue that grows for a client
   * that will never read it.
   */
  const offerTo = (watcher: Watcher, message: LiveMessage): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const waiting = yield* Queue.size(watcher.queue);
      if (waiting >= SUBSCRIPTION_CAP) {
        drop(watcher);
        yield* Queue.fail(
          watcher.queue,
          capExceeded({ count: waiting, cap: SUBSCRIPTION_CAP }, TOO_SLOW),
        );
        return false;
      }
      return yield* Queue.offer(watcher.queue, message);
    });

  /** Announces everything collected during the window, one message per kind. */
  const flush = Effect.gen(function* () {
    const collected = [...pending];
    pending.clear();
    for (const [topic, kinds] of collected) {
      const subscribers = watchers.get(topic);
      if (subscribers === undefined) continue;
      for (const [kind, ids] of kinds) {
        const message: LiveMessage = { _tag: "invalidate", ids: [...ids], kind };
        yield* Effect.forEach(subscribers, (watcher) => offerTo(watcher, message), {
          discard: true,
        });
      }
    }
  });

  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(wake);
        yield* Effect.sleep(COALESCE_WINDOW);
        // Emptied before the window's contents are read, so a change recorded
        // while this runs rings again rather than being announced by nobody.
        yield* Queue.clear(wake);
        yield* flush;
        // The loop is the only thing that announces a record change, so it has
        // to survive whatever one flush ran into, and say what that was.
      }).pipe(Effect.catchCause((cause) => Effect.logError("a live announcement failed", cause))),
    ),
  );

  /**
   * A log a subscription can be pumped from: the event log for `event`, one
   * session's transcript for `session:<id>:stream`. Each has its own table and
   * its own position column, so a follower is built from one of these rather
   * than a table name, and the two follow - and refuse a cursor past their
   * head - identically once each has one.
   */
  interface LogSource<A> {
    readonly after: (position: number, limit: number) => Effect.Effect<ReadonlyArray<A>, SqlError>;
    readonly positionOf: (item: A) => number;
    readonly head: Effect.Effect<number, SqlError>;
    /** What this log is called in a refused cursor's message: "log", "transcript". */
    readonly noun: string;
    readonly unreadable: string;
  }

  /**
   * Reads a log forward for one follower, for as long as it is subscribed. The
   * first read is the client's replay, handed over as one message; every read
   * after it carries the entries one at a time, each naming its own position,
   * because that position is what the client comes back on.
   */
  const pump = <A extends Delta["items"][number]>(
    source: LogSource<A>,
    watcher: Watcher,
    doorbell: Queue.Queue<void>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      // The one message that positions the client carries whatever it missed,
      // up to a page of it; everything after that is one entry at a time, so
      // what the controller holds for a client that has stopped reading is
      // counted in entries and not in pages of them.
      let positioning = true;
      while (true) {
        let more = true;
        while (more) {
          const page = yield* source.after(watcher.cursor, REPLAY_PAGE);
          const last = page[page.length - 1];
          if (last !== undefined) watcher.cursor = source.positionOf(last);
          if (positioning) {
            const positioned: LiveMessage = {
              _tag: "delta",
              cursor: String(watcher.cursor),
              items: page,
            };
            if (!(yield* offerTo(watcher, positioned))) return;
            positioning = false;
          } else {
            for (const item of page) {
              const delta: LiveMessage = {
                _tag: "delta",
                cursor: String(source.positionOf(item)),
                items: [item],
              };
              if (!(yield* offerTo(watcher, delta))) return;
            }
          }
          more = page.length === REPLAY_PAGE;
        }
        yield* Queue.take(doorbell);
      }
    }).pipe(
      // Whatever stopped it - the database, a row that will not decode - this
      // fiber is the only thing feeding the subscription, so the client is told
      // rather than left holding a stream that has quietly stopped.
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError("a live subscription could not read its log", cause);
          drop(watcher);
          yield* Queue.fail(watcher.queue, internal(source.unreadable));
        }),
      ),
    );

  const eventSource: LogSource<Event> = {
    after: (position, limit) => eventsAfter(sql, position, limit),
    positionOf: (item) => item.id,
    head: headOfLog(sql),
    noun: "log",
    unreadable: LOG_UNREADABLE,
  };

  const transcriptSource = (sessionId: string): LogSource<TranscriptRow> => ({
    after: (position, limit) => transcriptRowsAfter(sql, sessionId, position, limit),
    positionOf: (item) => item.position,
    head: headOfTranscript(sql, sessionId),
    noun: "transcript",
    unreadable: SESSION_UNREADABLE,
  });

  /**
   * A subscription to a log, replayed from `after` and followed from there.
   * With no position given it starts at the head, because a client that names
   * none is asking for what happens next. A position the log has not reached
   * is refused rather than accepted into silence: it belongs to a different
   * log, and honouring it would leave the client subscribed to nothing.
   * Shared by `follow` and `followSession`, whose only difference is which log
   * and whether a session behind it has to exist first.
   */
  const followLog = <A extends Delta["items"][number]>(
    topic: LiveTopic,
    source: LogSource<A>,
    after: number | undefined,
  ): Effect.Effect<LiveQueue, Validation | Internal, Scope.Scope> =>
    Effect.gen(function* () {
      const head = yield* Effect.mapError(source.head, () => internal(source.unreadable));
      if (after !== undefined && after > head) {
        return yield* Effect.fail(
          validation([
            {
              path: ["cursor"],
              message: `this ${source.noun} has reached ${String(head)}, no further`,
            },
          ]),
        );
      }
      const doorbell = yield* Queue.dropping<void>(1);
      const watcher = yield* hold(topic, after ?? head, doorbell);
      // Forked, so the client is handed its queue before the replay runs and
      // reads what it is being sent while the rest of it is still being read.
      yield* Effect.forkScoped(pump(source, watcher, doorbell));
      return watcher.queue;
    });

  /** Takes out a subscription for the length of the current scope. */
  const hold = (
    topic: LiveTopic,
    cursor: number,
    doorbell: Queue.Queue<void> | undefined,
  ): Effect.Effect<Watcher, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.map(Queue.make<LiveMessage, LiveFailure>(), (queue) => {
        const watcher: Watcher = { topic, queue, doorbell, cursor };
        const set = watchers.get(topic) ?? new Set<Watcher>();
        watchers.set(topic, set);
        set.add(watcher);
        return watcher;
      }),
      (watcher) =>
        Effect.andThen(
          Effect.sync(() => {
            drop(watcher);
          }),
          Queue.shutdown(watcher.queue),
        ),
    );

  return {
    /** A subscription to a mutable topic, which carries news and no records. */
    subscribe: (topic: MutableLiveTopic): Effect.Effect<LiveQueue, never, Scope.Scope> =>
      Effect.map(hold(topic, 0, undefined), (watcher) => watcher.queue),

    /** A subscription to the event log, replayed from `after` and followed from there. */
    follow: (
      after: number | undefined,
    ): Effect.Effect<LiveQueue, Validation | Internal, Scope.Scope> =>
      followLog(LOG_TOPIC, eventSource, after),

    /**
     * A subscription to one session's transcript, replayed from `after` and
     * followed from there - `follow` above, mirrored at the session's own
     * table. Refused `not_found` for a session that was never written, so a
     * stale sidebar tab cannot open a watcher for nothing.
     */
    followSession: (
      topic: LiveTopic,
      sessionId: string,
      after: number | undefined,
    ): Effect.Effect<LiveQueue, Validation | NotFound | Internal, Scope.Scope> =>
      Effect.gen(function* () {
        if (
          !(yield* Effect.mapError(sessionExists(sql, sessionId), () =>
            internal(SESSION_UNREADABLE),
          ))
        ) {
          return yield* Effect.fail(notFound(NO_SUCH_SESSION));
        }
        return yield* followLog(topic, transcriptSource(sessionId), after);
      }),

    /**
     * A subscription to one session's ephemeral token taps: held exactly as a
     * mutable topic is, since there is nothing to replay, but refused
     * `not_found` the same way `followSession` is.
     */
    tapSession: (
      topic: LiveTopic,
      sessionId: string,
    ): Effect.Effect<LiveQueue, NotFound | Internal, Scope.Scope> =>
      Effect.gen(function* () {
        if (
          !(yield* Effect.mapError(sessionExists(sql, sessionId), () =>
            internal(SESSION_UNREADABLE),
          ))
        ) {
          return yield* Effect.fail(notFound(NO_SUCH_SESSION));
        }
        return yield* Effect.map(hold(topic, 0, undefined), (watcher) => watcher.queue);
      }),

    /** How many subscriptions this controller is holding for a topic. */
    subscriberCount: (topic: LiveTopic): Effect.Effect<number> =>
      Effect.sync(() => watchers.get(topic)?.size ?? 0),

    /**
     * Ends one subscription with a reason of the caller's. The subscription
     * gives itself back when its own scope closes over the failure, so there is
     * nothing to forget here.
     */
    end: (queue: LiveQueue, reason: LiveFailure): Effect.Effect<void> =>
      Effect.asVoid(Queue.fail(queue, reason)),

    /**
     * What the last committed transaction changed, told to whoever is watching
     * - and, for `tap`, what was never a transaction at all. Nothing here reads
     * the database for a log topic: a follower is only told that it grew, and
     * reads it for itself. `tap` is the one exception, because there is
     * nothing stored for a follower to read: the item is the whole of what
     * happened, so it rides the announcement directly, to every current
     * subscriber, with no coalescing window - a token feels live or it does not.
     */
    publish: (changes: ReadonlyArray<Change>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const grown = new Set<LiveTopic>();
        const taps: Array<{ readonly sessionId: string; readonly item: TapItem }> = [];
        let collected = false;
        for (const change of changes) {
          if (change._tag === "event") {
            grown.add(LOG_TOPIC);
            continue;
          }
          if (change._tag === "transcript") {
            grown.add(sessionStreamTopic(change.sessionId));
            continue;
          }
          if (change._tag === "tap") {
            taps.push(change);
            continue;
          }
          const kinds = pending.get(change.topic) ?? new Map<InvalidateKind, Set<string>>();
          pending.set(change.topic, kinds);
          const ids = kinds.get(change.kind) ?? new Set<string>();
          kinds.set(change.kind, ids);
          ids.add(change.id);
          collected = true;
        }
        if (collected) yield* Queue.offer(wake, undefined);
        for (const topic of grown) {
          yield* Effect.forEach(
            watchersOf(topic),
            (watcher) =>
              watcher.doorbell === undefined
                ? Effect.void
                : Effect.asVoid(Queue.offer(watcher.doorbell, undefined)),
            { discard: true },
          );
        }
        for (const tap of taps) {
          const message: LiveMessage = { _tag: "delta", items: [tap.item] };
          yield* Effect.forEach(
            watchersOf(sessionTapTopic(tap.sessionId)),
            (watcher) => offerTo(watcher, message),
            { discard: true },
          );
        }
      }),
  };
});

/** The Live Topics this controller is serving. */
export class LiveTopics extends Context.Service<LiveTopics, Effect.Success<typeof make>>()(
  "hydra/controller/live/LiveTopics",
) {}

/**
 * The topics, and the controller's ear for what a transaction committed. They
 * are one layer because they are one object: what a mutation announces is what
 * a subscriber is told, and a controller holding subscriptions but hearing
 * nothing would be a socket that never pushes.
 */
export const LiveTopicsLayer: Layer.Layer<LiveTopics | AfterCommit, never, SqlClient.SqlClient> =
  Layer.effect(AfterCommit)(
    Effect.gen(function* () {
      const topics = yield* LiveTopics;
      return { publish: topics.publish };
    }),
  ).pipe(Layer.provideMerge(Layer.effect(LiveTopics)(make)));
