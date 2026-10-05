/**
 * Live Topics: the subscriptions of the clients watching each topic, and the
 * messages pushed to them after a transaction commits.
 *
 * Each subscription has one queue, grouped by topic. A subscription lasts as
 * long as the caller's scope, and is removed when that scope closes. That
 * happens both when the client ends its stream and when the socket drops, so
 * a closed connection leaves nothing behind.
 *
 * The two kinds of topic are pushed differently:
 *
 * - A mutable topic carries no records, only the news that some records
 *   changed. A burst of changes is collected for a short window and sent as
 *   one message per kind of change. So a screen refetches once for three
 *   creates instead of three times, and the window is too short for anyone
 *   to notice. Changes that come in a steady stream while an agent works, a
 *   subagent's progress and a session's Token Usage, are collected for a
 *   longer window instead, so a busy session costs each client at most one
 *   refetch per record per second.
 * - A log topic carries the records themselves. A commit only signals that
 *   the log grew, never which rows. Each follower then reads forward from its
 *   own position, so records arrive in log order, never twice, and the replay
 *   at the start is the same read as every push after it. The first message
 *   sets the client's position, even when it missed nothing; after that it
 *   gets one delta per entry.
 *
 * A subscriber that stops reading is ended instead of queued for without
 * limit. It can subscribe again, and a log subscriber can pass the last
 * cursor it received to continue where it stopped.
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
  createCapExceededError,
  createInternalError,
  createNotFoundError,
  createValidationError,
  buildSessionStreamTopic,
  buildSessionTapTopic,
  buildSubagentStreamTopic,
  buildSubagentTapTopic,
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
} from "@hercule/contract";
import type { SubagentId } from "@hercule/protocol";
import { AfterCommit, type Change } from "../db";
import { readEventsAfter, readLogHead } from "../events";
import { agentExists, readTranscriptHead, readTranscriptRowsAfter } from "../sessions";

/**
 * How long a burst of record changes is collected before it is sent, in
 * milliseconds. Long enough that a workflow touching a dozen tasks causes one
 * refetch, short enough that a person clicking a button sees the result as
 * immediate. Exported because tests that watch a push have to wait longer than
 * this, and a copy of the number would make them flaky when this one changes.
 */
export const COALESCE_WINDOW_MS = 50;

/**
 * How long the changes of a slow-paced record are collected before they are
 * sent, in milliseconds: the `subagent` topic, and a session whose only
 * change is its Token Usage. Both change with almost every event a working
 * agent reports, and a client that refetched each time would read the same
 * record many times a second. Exported for the same reason as
 * `COALESCE_WINDOW_MS`.
 */
export const SLOW_COALESCE_WINDOW_MS = 1000;

/**
 * How many messages may wait for one subscriber before the controller ends
 * the subscription. A client that stops reading is either gone or too slow to
 * catch up, and either way buffering for it costs memory the controller cannot
 * reclaim. The subscription ends, and the client can subscribe again. For a
 * log topic it passes the last cursor it received, so it misses nothing.
 */
const SUBSCRIPTION_CAP = 1000;

/** How many entries one read of the log returns at most. */
const REPLAY_PAGE = 500;

/** The errors a subscription can end with, other than the client closing it. */
export type LiveFailure = CapExceeded | Unauthenticated | Internal;

/** One subscription's queue. Failing the queue ends the subscription. */
export type LiveQueue = Queue.Queue<LiveMessage, LiveFailure>;

interface Watcher {
  readonly topic: LiveTopic;
  readonly queue: LiveQueue;
  /** Receives a signal when the log has grown. Log subscriptions only. */
  readonly doorbell: Queue.Queue<void> | undefined;
  /** The last log position this subscription has read. Log subscriptions only. */
  cursor: number;
}

/** The event log's topic, which carries records rather than news of changes. */
const LOG_TOPIC: LiveTopic = "event";

const TOO_SLOW =
  "this subscription fell too far behind because it was not being read; subscribe again, and for a log topic pass the last cursor you received";

const LOG_UNREADABLE = "the event log could not be read";

const SESSION_UNREADABLE = "the session could not be read";

const NO_SUCH_SESSION = "no such session";

const NO_SUCH_SUBAGENT = "no such subagent on that session";

/**
 * Builds the topic of one agent's transcript: the session's own agent's when
 * `subagentId` is `undefined`, otherwise that subagent's.
 */
const buildAgentStreamTopic = (sessionId: string, subagentId: SubagentId | undefined): LiveTopic =>
  subagentId === undefined
    ? buildSessionStreamTopic(sessionId)
    : buildSubagentStreamTopic(sessionId, subagentId);

/** Builds the topic of one agent's token taps, the same way as `buildAgentStreamTopic`. */
const buildAgentTapTopic = (sessionId: string, subagentId: SubagentId | undefined): LiveTopic =>
  subagentId === undefined
    ? buildSessionTapTopic(sessionId)
    : buildSubagentTapTopic(sessionId, subagentId);

/** Checks whether a record change is collected for the slow window rather than the short one. */
const isSlowPaced = (change: Extract<Change, { readonly _tag: "record" }>): boolean =>
  change.topic === "subagent" || change.usageOnly === true;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const watchers = new Map<LiveTopic, Set<Watcher>>();

  const listWatchers = (topic: LiveTopic): ReadonlySet<Watcher> => watchers.get(topic) ?? new Set();

  const dropWatcher = (watcher: Watcher): void => {
    const set = watchers.get(watcher.topic);
    if (set === undefined) return;
    set.delete(watcher);
    if (set.size === 0) watchers.delete(watcher.topic);
  };

  /**
   * Offers one message to one subscriber. Returns false when the subscription
   * has ended. A subscriber whose queue is full is ended instead of queued
   * for, because otherwise the queue would grow for a client that may never
   * read it.
   */
  const offerTo = (watcher: Watcher, message: LiveMessage): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const waiting = yield* Queue.size(watcher.queue);
      if (waiting >= SUBSCRIPTION_CAP) {
        dropWatcher(watcher);
        yield* Queue.fail(
          watcher.queue,
          createCapExceededError({ count: waiting, cap: SUBSCRIPTION_CAP }, TOO_SLOW),
        );
        return false;
      }
      return yield* Queue.offer(watcher.queue, message);
    });

  /**
   * Starts collecting record changes for a window of `windowMs` and sending
   * them when it closes, one message per topic and kind. Returns the function
   * that adds a change. The first change after a send opens the next window,
   * so an id is sent at most once per window however often it changes.
   */
  const startCoalescing = (windowMs: number) =>
    Effect.gen(function* () {
      /** The ids of the records changed since the last send, by topic and by kind. */
      const pending = new Map<MutableLiveTopic, Map<InvalidateKind, Set<string>>>();
      /** Receives a signal when changes are pending. Holds at most one signal. */
      const wake = yield* Queue.dropping<void>(1);

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
            yield* Effect.sleep(Duration.millis(windowMs));
            // Clear the signal before reading the collected changes, so a change
            // recorded during the flush signals again and is not lost.
            yield* Queue.clear(wake);
            yield* flush;
            // This loop is the only thing that sends these record changes, so
            // it must survive a failed flush, and log what went wrong.
          }).pipe(
            Effect.catchCause((cause) => Effect.logError("a live announcement failed", cause)),
          ),
        ),
      );

      return (topic: MutableLiveTopic, kind: InvalidateKind, id: string): Effect.Effect<void> =>
        Effect.suspend(() => {
          const kinds = pending.get(topic) ?? new Map<InvalidateKind, Set<string>>();
          pending.set(topic, kinds);
          const ids = kinds.get(kind) ?? new Set<string>();
          kinds.set(kind, ids);
          ids.add(id);
          return Effect.asVoid(Queue.offer(wake, undefined));
        });
    });

  const collectChange = yield* startCoalescing(COALESCE_WINDOW_MS);
  const collectSlowChange = yield* startCoalescing(SLOW_COALESCE_WINDOW_MS);

  /**
   * A log a subscription can read from: the event log for `event`, or one
   * session's transcript for `session:<id>:stream`. Each has its own table and
   * position column, so a follower is built from one of these rather than
   * from a table name. With it, both logs are followed the same way, and both
   * reject a cursor past their end the same way.
   */
  interface LogSource<A> {
    readonly after: (position: number, limit: number) => Effect.Effect<ReadonlyArray<A>, SqlError>;
    readonly positionOf: (item: A) => number;
    readonly head: Effect.Effect<number, SqlError>;
    /** The log's name in the error message for an invalid cursor: "log" or "transcript". */
    readonly noun: string;
    readonly unreadable: string;
  }

  /**
   * Reads a log forward for one follower, for as long as it is subscribed. The
   * first read is the client's replay, sent as one message. After that, each
   * entry is sent as its own message with its own position, because that
   * position is the cursor the client resubscribes from.
   */
  const pump = <A extends Delta["items"][number]>(
    source: LogSource<A>,
    watcher: Watcher,
    doorbell: Queue.Queue<void>,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      // The first message carries what the client missed, up to one page.
      // After that each entry is its own message, so the queue limit for a
      // client that stops reading counts entries, not pages.
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
      // Whatever stopped this fiber, such as a database error or a row that
      // fails to decode, it is the only thing feeding the subscription. So the
      // client gets an error instead of a stream that silently stops.
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logError("a live subscription could not read its log", cause);
          dropWatcher(watcher);
          yield* Queue.fail(watcher.queue, createInternalError(source.unreadable));
        }),
      ),
    );

  const eventSource: LogSource<Event> = {
    after: (position, limit) => readEventsAfter(sql, position, limit),
    positionOf: (item) => item.id,
    head: readLogHead(sql),
    noun: "log",
    unreadable: LOG_UNREADABLE,
  };

  const buildTranscriptSource = (
    sessionId: string,
    subagentId: SubagentId | undefined,
  ): LogSource<TranscriptRow> => ({
    after: (position, limit) =>
      readTranscriptRowsAfter(sql, sessionId, subagentId, position, limit),
    positionOf: (item) => item.position,
    head: readTranscriptHead(sql, sessionId, subagentId),
    noun: "transcript",
    unreadable: SESSION_UNREADABLE,
  });

  /**
   * Opens a subscription to a log that replays from `after` and then follows
   * new entries. Without `after`, it starts at the end of the log, because
   * the client wants only what happens next.
   *
   * Fails with a validation error when `after` is past the end of the log.
   * Such a cursor belongs to a different log, and accepting it would leave
   * the client subscribed to nothing. Used by `follow` and `followSession`.
   */
  const followLog = <A extends Delta["items"][number]>(
    topic: LiveTopic,
    source: LogSource<A>,
    after: number | undefined,
  ): Effect.Effect<LiveQueue, Validation | Internal, Scope.Scope> =>
    Effect.gen(function* () {
      const head = yield* Effect.mapError(source.head, () =>
        createInternalError(source.unreadable),
      );
      if (after !== undefined && after > head) {
        return yield* Effect.fail(
          createValidationError([
            {
              path: ["cursor"],
              message: `the cursor is past the end of this ${source.noun}, which is at ${String(head)}`,
            },
          ]),
        );
      }
      const doorbell = yield* Queue.dropping<void>(1);
      const watcher = yield* registerWatcher(topic, after ?? head, doorbell);
      // Forked, so the client gets its queue before the replay runs, and can
      // read the first entries while the rest are still being read.
      yield* Effect.forkScoped(pump(source, watcher, doorbell));
      return watcher.queue;
    });

  /** Registers a subscription for the life of the current scope, and returns it. */
  const registerWatcher = (
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
            dropWatcher(watcher);
          }),
          Queue.shutdown(watcher.queue),
        ),
    );

  /**
   * Checks that a session exists and, for a subagent's topic, that the
   * session has that subagent. Fails with not_found otherwise, so a stale tab
   * cannot open a subscription to nothing.
   */
  const requireAgent = (
    sessionId: string,
    subagentId: SubagentId | undefined,
  ): Effect.Effect<void, NotFound | Internal> =>
    Effect.flatMap(
      Effect.mapError(agentExists(sql, sessionId, subagentId), () =>
        createInternalError(SESSION_UNREADABLE),
      ),
      (exists) =>
        exists
          ? Effect.void
          : Effect.fail(
              createNotFoundError(subagentId === undefined ? NO_SUCH_SESSION : NO_SUCH_SUBAGENT),
            ),
    );

  return {
    /** Opens a subscription to a mutable topic, which carries news of changes and no records. */
    subscribe: (topic: MutableLiveTopic): Effect.Effect<LiveQueue, never, Scope.Scope> =>
      Effect.map(registerWatcher(topic, 0, undefined), (watcher) => watcher.queue),

    /** Opens a subscription to the event log, replayed from `after` and then followed. */
    follow: (
      after: number | undefined,
    ): Effect.Effect<LiveQueue, Validation | Internal, Scope.Scope> =>
      followLog(LOG_TOPIC, eventSource, after),

    /**
     * Opens a subscription to one agent's transcript, replayed from `after`
     * and then followed, like `follow` above. The agent is the session's own
     * when `subagentId` is `undefined`, otherwise that subagent. The topic is
     * built from the ids rather than passed in, so a caller cannot pass a
     * topic and ids that do not match. Fails with not_found for an unknown
     * session or subagent.
     */
    followSession: (
      sessionId: string,
      subagentId: SubagentId | undefined,
      after: number | undefined,
    ): Effect.Effect<LiveQueue, Validation | NotFound | Internal, Scope.Scope> =>
      Effect.gen(function* () {
        yield* requireAgent(sessionId, subagentId);
        return yield* followLog(
          buildAgentStreamTopic(sessionId, subagentId),
          buildTranscriptSource(sessionId, subagentId),
          after,
        );
      }),

    /**
     * Opens a subscription to one agent's token taps. It works like a
     * mutable topic, since there is nothing to replay, and fails with
     * not_found for an unknown session or subagent, like `followSession`.
     */
    tapSession: (
      sessionId: string,
      subagentId: SubagentId | undefined,
    ): Effect.Effect<LiveQueue, NotFound | Internal, Scope.Scope> =>
      Effect.gen(function* () {
        yield* requireAgent(sessionId, subagentId);
        return yield* Effect.map(
          registerWatcher(buildAgentTapTopic(sessionId, subagentId), 0, undefined),
          (watcher) => watcher.queue,
        );
      }),

    /** Returns the number of open subscriptions to a topic. */
    subscriberCount: (topic: LiveTopic): Effect.Effect<number> =>
      Effect.sync(() => watchers.get(topic)?.size ?? 0),

    /**
     * Ends one subscription with the given error. The subscription removes
     * itself when its scope closes on the error, so there is nothing else to
     * clean up here.
     */
    end: (queue: LiveQueue, reason: LiveFailure): Effect.Effect<void> =>
      Effect.asVoid(Queue.fail(queue, reason)),

    /**
     * Publishes the changes of a committed transaction to the subscribers,
     * plus any `tap` changes, which never go through a transaction.
     *
     * - Mutable topic changes are collected and sent after the coalescing
     *   window: the slow one for the `subagent` topic and for a change to a
     *   session's Token Usage alone, the short one for everything else.
     * - For a log topic, nothing here reads the database: each follower is
     *   signalled that the log grew, and reads the new entries itself.
     * - A `tap` item is sent directly to every current subscriber, with no
     *   window. Nothing is stored for a follower to read, and tokens only feel
     *   live when they arrive at once.
     *
     * A transcript change and a tap go to the topic of the agent that
     * produced them: the session's own, or one subagent's.
     */
    publish: (changes: ReadonlyArray<Change>): Effect.Effect<void> =>
      Effect.gen(function* () {
        const grown = new Set<LiveTopic>();
        const taps: Array<{ readonly sessionId: string; readonly item: TapItem }> = [];
        for (const change of changes) {
          if (change._tag === "event") {
            grown.add(LOG_TOPIC);
            continue;
          }
          if (change._tag === "transcript") {
            grown.add(buildAgentStreamTopic(change.sessionId, change.subagentId));
            continue;
          }
          if (change._tag === "tap") {
            taps.push(change);
            continue;
          }
          const collect = isSlowPaced(change) ? collectSlowChange : collectChange;
          yield* collect(change.topic, change.kind, change.id);
        }
        for (const topic of grown) {
          yield* Effect.forEach(
            listWatchers(topic),
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
            listWatchers(buildAgentTapTopic(tap.sessionId, tap.item.subagentId)),
            (watcher) => offerTo(watcher, message),
            { discard: true },
          );
        }
      }),
  };
});

/** The Live Topics this controller is serving. */
export class LiveTopics extends Context.Service<LiveTopics, Effect.Success<typeof make>>()(
  "hercule/controller/live/LiveTopics",
) {}

/**
 * Provides both the Live Topics and the `AfterCommit` hook that feeds them.
 * They are one layer because they are one object: what a commit publishes is
 * what subscribers receive. Wired separately, a controller could hold
 * subscriptions but never hear about commits, and the socket would never
 * push.
 */
export const LiveTopicsLayer: Layer.Layer<LiveTopics | AfterCommit, never, SqlClient.SqlClient> =
  Layer.effect(AfterCommit)(
    Effect.gen(function* () {
      const topics = yield* LiveTopics;
      return { publish: topics.publish };
    }),
  ).pipe(Layer.provideMerge(Layer.effect(LiveTopics)(make)));
