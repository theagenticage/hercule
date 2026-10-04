/**
 * The ingest loops: one open ingest handle per Connection, and one timer per
 * feed of that handle. The host owns the clock and the plugin owns the
 * numbers (spec 05 §4.3): the plugin declares each feed's interval and does
 * the fetching; this module decides when to poll, retries failures with
 * backoff, and sets the Connection's status.
 *
 * For each Connection a supervisor fiber:
 *
 * - opens the handle, retrying with backoff while `open` fails;
 * - polls every feed right after the open, then once per interval, and never
 *   runs two polls of one handle at a time;
 * - stops a poll that runs longer than 5 minutes, and counts it as a failure;
 * - sets the Connection to `error`, and raises one `core.connection-error`
 *   notification, when one feed or the open has failed five times in a row;
 * - sets an `error` Connection back to `connected` once every feed has polled
 *   successfully since the open. A successful open alone does not, because
 *   it proves nothing about the feeds;
 * - sets it to `needs-reauth` and stops at the first `AuthError`, because
 *   retrying with rejected credentials cannot help.
 *
 * Closing a Connection interrupts its feed timers, waits for them to finish,
 * then calls the handle's `close` once, giving it 10 seconds. The controller
 * daemon decides which Connections are open; this module only opens and
 * closes what it is told.
 */
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MAX_FEED_INTERVAL_SECONDS } from "@hercule/contract";
import {
  AuthError,
  decodeAgainst,
  type FeedDeclaration,
  type IngestHandle,
  PluginError,
} from "@hercule/plugin-host";
import { announce, nowIso, withTransaction } from "../db";
import {
  connectionRepository,
  ConnectionNotIngesting,
  ConnectionTypes,
  type StoredConnection,
} from "../connections";
import { Notifier } from "../notifications";
import { summarizeCause, toPluginError } from "./errors";
import type { RegisteredEventSource } from "./event-sources";
import { ingestContexts } from "./ingest-context";

/** After this many failures in a row, of one feed or of the open, the Connection is set to `error`. */
export const FAILURES_BEFORE_ERROR = 5;

/** The longest wait between two tries of a failing feed, in seconds: 15 minutes. */
const MAX_RETRY_DELAY_SECONDS = 900;

/**
 * How long one poll may run, in seconds: 5 minutes. A poll that hangs, on a
 * request that never returns, would otherwise hold the handle's lock and stop
 * every other feed of the Connection for good.
 */
export const POLL_TIMEOUT_SECONDS = 300;

/**
 * How long a handle's `close` may run, in seconds. A `close` that hangs would
 * otherwise hold up the close of the Connection, the stop of its plugin, and
 * the controller's shutdown.
 */
export const CLOSE_TIMEOUT_SECONDS = 10;

/** The key the open's failures are counted under, beside the feeds' names. */
const OPEN_FAILURES_KEY = Symbol("open-failures");

/** The body of a `core.connection-error` notification. */
const CONNECTION_ERROR_BODY =
  "The last error is shown on the Connection's card on the Connections screen. " +
  "Polling goes on with longer waits, and the Connection returns to connected " +
  "once each of its feeds has polled successfully.";

/**
 * Returns how often a feed is polled, in seconds: the Connection's own
 * interval for the feed, or the feed's default when it has none, but never
 * less than the feed's minimum. A feed without a minimum has its default as
 * its minimum.
 */
export const computeFeedInterval = (
  declaration: FeedDeclaration,
  overrideSeconds: number | undefined,
): number =>
  Math.max(
    overrideSeconds ?? declaration.defaultIntervalSeconds,
    declaration.minIntervalSeconds ?? declaration.defaultIntervalSeconds,
  );

/**
 * Returns the wait before the next try after `failures` failures in a row, in
 * seconds: the interval doubled for each failure, up to 15 minutes. A feed
 * whose interval is longer than 15 minutes waits its own interval instead,
 * so a failing feed is never polled more often than a healthy one.
 */
export const computeRetryDelay = (intervalSeconds: number, failures: number): number =>
  Math.min(intervalSeconds * 2 ** failures, Math.max(intervalSeconds, MAX_RETRY_DELAY_SECONDS));

/**
 * Returns the fingerprint of what a handle was opened with: the Connection's
 * config and its feed intervals. A handle whose fingerprint no longer matches
 * its Connection is closed and opened again.
 */
export const computeIngestFingerprint = (connection: StoredConnection): string =>
  JSON.stringify({ config: connection.config, feedIntervals: connection.feedIntervals });

/** One running ingest, as the controller daemon compares it with what should be open. */
export interface RunningIngest {
  readonly connectionId: string;
  readonly pluginId: string;
  readonly fingerprint: string;
}

/** What failures are counted under: a feed's name, or the open's own key. */
type FailureKey = string | typeof OPEN_FAILURES_KEY;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* connectionRepository;
  const connectionTypes = yield* ConnectionTypes;
  const notifier = yield* Notifier;
  const contexts = yield* ingestContexts;
  const supervisors = yield* FiberMap.make<string>();
  // What each supervisor was opened with: the FiberMap holds only the fibers.
  // A supervisor removes its entry when it ends, and `close` removes it too,
  // in case the fiber was interrupted before it started.
  const runningIngests = yield* Ref.make(new Map<string, RunningIngest>());

  /** Removes the entry of a Connection whose supervisor has ended or is being closed. */
  const forgetRunningIngest = (connectionId: string): Effect.Effect<void> =>
    Ref.update(runningIngests, (all) => {
      const next = new Map(all);
      next.delete(connectionId);
      return next;
    });

  /**
   * Runs one Connection's ingest until it is interrupted or its credentials
   * are rejected. Every status write is conditional, so a loop never
   * overwrites a status the user set while a poll was running, such as
   * `disabled`.
   */
  const superviseConnection = (
    source: RegisteredEventSource,
    connection: StoredConnection,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const type = Option.getOrUndefined(yield* connectionTypes.named(connection.type));
      const typeDisplayName = type?.contribution.displayName ?? connection.type;
      const configSchema = type?.contribution.configSchema;
      const intervals = Object.entries(source.feeds).map(
        ([name, declaration]) =>
          [name, computeFeedInterval(declaration, connection.feedIntervals[name])] as const,
      );
      // Failures in a row, by feed name, and of the open under `OPEN_FAILURES_KEY`.
      const failures = new Map<FailureKey, number>();
      // The feeds whose latest poll since the open succeeded.
      const healthyFeeds = new Set<string>();
      // Whether the Connection may be `error`. It starts from the status the
      // Connection was opened with, so the successful polls of a healthy
      // Connection write nothing.
      let mayBeInError = connection.status === "error";

      const writeStatus = <A>(write: (at: string) => Effect.Effect<A, unknown>): Effect.Effect<A> =>
        Effect.orDie(
          withTransaction(
            sql,
            Effect.flatMap(nowIso, (at) => write(at)),
          ),
        );

      const announceConnection = announce({
        _tag: "record",
        topic: "connection",
        id: connection.id,
        kind: "updated",
      });

      /**
       * Resets the failure count of one feed, and sets an `error` Connection
       * back to `connected` once every feed has succeeded since the open.
       */
      const recordFeedSuccess = (name: string): Effect.Effect<void> =>
        Effect.suspend(() => {
          failures.set(name, 0);
          healthyFeeds.add(name);
          if (!mayBeInError || healthyFeeds.size < intervals.length) return Effect.void;
          return Effect.andThen(
            writeStatus((at) =>
              Effect.gen(function* () {
                if (
                  yield* connections.changeStatusFrom(
                    connection.id,
                    ["error"],
                    "connected",
                    null,
                    at,
                  )
                ) {
                  yield* announceConnection;
                }
              }),
            ),
            Effect.sync(() => {
              mayBeInError = false;
            }),
          );
        });

      /**
       * Counts one more failure of a feed or of the open, and returns the
       * count. The failure that reaches the threshold sets a `connected`
       * Connection to `error` and raises the notification in the same
       * transaction. Gating on that change raises it once per spell of
       * failures, even across a restart.
       */
      const recordFailure = (key: FailureKey, message: string): Effect.Effect<number> =>
        Effect.gen(function* () {
          const count = (failures.get(key) ?? 0) + 1;
          failures.set(key, count);
          if (typeof key === "string") healthyFeeds.delete(key);
          if (count < FAILURES_BEFORE_ERROR) return count;
          mayBeInError = true;
          yield* writeStatus((at) =>
            Effect.gen(function* () {
              if (
                !(yield* connections.changeStatusFrom(
                  connection.id,
                  ["connected"],
                  "error",
                  message,
                  at,
                ))
              ) {
                return;
              }
              yield* announceConnection;
              // The user may have renamed the Connection since it was opened.
              const label = Option.match(yield* connections.one(connection.id), {
                onNone: () => connection.label,
                onSome: (current) => current.label,
              });
              yield* notifier.createCoreNotification({
                kind: "core.connection-error",
                title: `${typeDisplayName} connection '${label}' keeps failing`,
                // The plugin's own error text stays out of the notification:
                // agent profiles read notifications, and the text is the
                // plugin's, so it may carry a credential. The Connection's
                // status detail shows it to the user.
                body: CONNECTION_ERROR_BODY,
                subject: [{ kind: "connection", id: connection.id }],
              });
            }),
          );
          return count;
        });

      /**
       * Sets the Connection to `needs-reauth` after an `AuthError`, unless its
       * credentials changed since the attempt started, and returns whether
       * it did. A reconnect while a poll runs replaces the rejected
       * credentials; marking the Connection then would flag credentials that
       * may well work.
       */
      const markNeedsReauth = (
        credentialsVersion: string,
        cause: Cause.Cause<AuthError | PluginError>,
      ): Effect.Effect<boolean> =>
        writeStatus((at) =>
          Effect.gen(function* () {
            const current = yield* connectionTypes.readCredentialsVersion(connection.id);
            if (current !== credentialsVersion) return false;
            if (
              yield* connections.changeStatusFrom(
                connection.id,
                ["connected", "error"],
                "needs-reauth",
                summarizeCause(cause),
                at,
              )
            ) {
              yield* announceConnection;
            }
            return true;
          }),
        );

      /**
       * Handles one failed open or poll, and returns the wait before the next
       * try, in seconds:
       *
       * - an interruption is passed on;
       * - an `AuthError` sets the Connection to `needs-reauth` and fails. When
       *   the credentials changed during the attempt, it waits one interval
       *   instead, and the next try uses the new credentials;
       * - a write to a Connection that is no longer ingesting is not counted,
       *   because the reconciler closes the handle within seconds;
       * - anything else is counted. A defect is also logged, because it is a
       *   bug in the plugin that its author needs to see.
       */
      const handleFailure = (
        key: FailureKey,
        intervalSeconds: number,
        credentialsVersion: string,
        cause: Cause.Cause<AuthError | PluginError>,
      ): Effect.Effect<number, AuthError> =>
        Effect.gen(function* () {
          if (Cause.hasInterrupts(cause)) return yield* Effect.interrupt;
          const error = Option.getOrUndefined(Cause.findErrorOption(cause));
          if (error instanceof AuthError) {
            if (yield* markNeedsReauth(credentialsVersion, cause)) return yield* Effect.fail(error);
            return intervalSeconds;
          }
          if (error === undefined) {
            const defect = Cause.findDefect(cause);
            if (Result.isSuccess(defect) && defect.success instanceof ConnectionNotIngesting) {
              return intervalSeconds;
            }
            yield* Effect.logError(
              `The event source ${source.id} crashed on the Connection ${connection.id}`,
              cause,
            );
          }
          const count = yield* recordFailure(key, summarizeCause(cause));
          return computeRetryDelay(intervalSeconds, count);
        });

      const decodeConfig: Effect.Effect<unknown, PluginError> =
        configSchema === undefined
          ? Effect.succeed(connection.config)
          : Effect.mapError(decodeAgainst(configSchema, connection.config), toPluginError);

      const openRetrySeconds = Math.min(...intervals.map(([, seconds]) => seconds));

      /** Opens the handle, retrying with backoff until it opens or the credentials are rejected. */
      const openWithRetry: Effect.Effect<IngestHandle, AuthError> = Effect.gen(function* () {
        while (true) {
          const credentialsVersion = yield* connectionTypes.readCredentialsVersion(connection.id);
          const attempt = yield* Effect.exit(
            Effect.flatMap(decodeConfig, (config) =>
              Effect.suspend(() =>
                source.open(
                  { id: connection.id, config },
                  contexts.buildIngestContext(source, { id: connection.id, config }),
                ),
              ),
            ),
          );
          if (Exit.isSuccess(attempt)) return attempt.value;
          const delay = yield* handleFailure(
            OPEN_FAILURES_KEY,
            openRetrySeconds,
            credentialsVersion,
            attempt.cause,
          );
          yield* Effect.sleep(Duration.seconds(delay));
        }
      });

      /**
       * Polls one feed, and fails with a `PluginError` when the poll runs
       * longer than `POLL_TIMEOUT_SECONDS`. The timeout starts once the poll
       * holds the lock, so time spent waiting for another feed's poll does
       * not count.
       */
      const pollWithTimeout = (handle: IngestHandle, lock: Semaphore.Semaphore, name: string) =>
        lock.withPermit(
          Effect.timeoutOrElse(
            Effect.suspend(() => handle.poll(name)),
            {
              duration: Duration.seconds(POLL_TIMEOUT_SECONDS),
              orElse: () =>
                Effect.fail(
                  new PluginError({
                    message:
                      `The poll of the feed ${name} was stopped after ${POLL_TIMEOUT_SECONDS} seconds. ` +
                      "A poll must return within that time: fetch less in one poll and go on in the next.",
                  }),
                ),
            },
          ),
        );

      /** Polls one feed right away and then forever. Fails only with an `AuthError`. */
      const runFeed = (
        handle: IngestHandle,
        lock: Semaphore.Semaphore,
        name: string,
        intervalSeconds: number,
      ): Effect.Effect<never, AuthError> =>
        Effect.gen(function* () {
          while (true) {
            const credentialsVersion = yield* connectionTypes.readCredentialsVersion(connection.id);
            const polled = yield* Effect.exit(pollWithTimeout(handle, lock, name));
            let delay: number;
            if (Exit.isSuccess(polled)) {
              yield* recordFeedSuccess(name);
              // `nextAfterSeconds` comes from the plugin and may be NaN or Infinity, so a value that is not finite is ignored.
              const asked = polled.value.nextAfterSeconds;
              // A plugin may ask for a longer wait than the interval, but not
              // for one longer than any feed may be configured to wait.
              const requested =
                typeof asked === "number" && Number.isFinite(asked)
                  ? Math.min(asked, MAX_FEED_INTERVAL_SECONDS)
                  : 0;
              delay = Math.max(intervalSeconds, requested);
            } else {
              delay = yield* handleFailure(name, intervalSeconds, credentialsVersion, polled.cause);
            }
            yield* Effect.sleep(Duration.seconds(delay));
          }
        });

      /**
       * Calls the handle's `close`, giving it `CLOSE_TIMEOUT_SECONDS`. A
       * failure, a defect or a timeout is logged and the Connection is closed
       * anyway: the host can do nothing else with a handle that will not
       * close.
       */
      const closeHandle = (handle: IngestHandle): Effect.Effect<void> =>
        Effect.catchCause(
          // A finalizer runs uninterruptibly. `close` is made interruptible so
          // the timeout can stop it.
          Effect.timeoutOrElse(Effect.interruptible(Effect.suspend(() => handle.close)), {
            duration: Duration.seconds(CLOSE_TIMEOUT_SECONDS),
            orElse: () =>
              Effect.fail(
                new PluginError({
                  message: `close did not return within ${CLOSE_TIMEOUT_SECONDS} seconds`,
                }),
              ),
          }),
          (cause) =>
            Effect.logError(
              `The event source ${source.id} failed to close the Connection ${connection.id}`,
              cause,
            ),
        );

      yield* Effect.scoped(
        Effect.gen(function* () {
          // The open itself can be interrupted; once it returns a handle,
          // registering its close cannot be.
          const handle = yield* Effect.uninterruptibleMask((restore) =>
            Effect.tap(restore(openWithRetry), (handle) =>
              Effect.addFinalizer(() => closeHandle(handle)),
            ),
          );
          // The open succeeded, so its failures no longer count towards
          // `error`. It does not clear `error` either: only the feeds do.
          failures.set(OPEN_FAILURES_KEY, 0);
          const lock = yield* Semaphore.make(1);
          yield* Effect.forEach(
            intervals,
            ([name, seconds]) => runFeed(handle, lock, name, seconds),
            { concurrency: "unbounded", discard: true },
          );
        }),
      );
    }).pipe(
      // An `AuthError` has already set `needs-reauth`; the supervisor ends.
      Effect.catchTag("AuthError", () => Effect.void),
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.logError(`The ingest loop of the Connection ${connection.id} stopped`, cause),
      ),
      Effect.ensuring(forgetRunningIngest(connection.id)),
    );

  const close = (connectionId: string): Effect.Effect<void> =>
    Effect.andThen(FiberMap.remove(supervisors, connectionId), forgetRunningIngest(connectionId));

  return {
    /**
     * Starts ingesting one Connection through the source, and returns once
     * the loop is started, not once the handle is open. The first poll of
     * each feed runs right after the open. Does nothing when the Connection
     * is already open; close it first to open it with a new config.
     */
    open: (source: RegisteredEventSource, connection: StoredConnection): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (yield* FiberMap.has(supervisors, connection.id)) return;
        yield* Ref.update(runningIngests, (all) =>
          new Map(all).set(connection.id, {
            connectionId: connection.id,
            pluginId: source.pluginId,
            fingerprint: computeIngestFingerprint(connection),
          }),
        );
        yield* FiberMap.run(supervisors, connection.id, superviseConnection(source, connection));
      }),

    /**
     * Stops ingesting one Connection, and returns once its handle is closed:
     * the feed timers are interrupted and finished, and `close` has returned
     * or timed out. Does nothing when the Connection is not open.
     */
    close,

    /** Stops ingesting every Connection open through the plugin's sources, and returns once all are closed. */
    closePluginIngests: (pluginId: string): Effect.Effect<void> =>
      Effect.flatMap(Ref.get(runningIngests), (all) =>
        Effect.forEach(
          [...all.values()].filter((running) => running.pluginId === pluginId),
          (running) => close(running.connectionId),
          { discard: true },
        ),
      ),

    /**
     * Lists the Connections whose loop is running. A loop that ended by
     * itself, after an `AuthError`, is not in the list: its supervisor
     * removed its entry as it ended.
     */
    listOpen: (): Effect.Effect<ReadonlyArray<RunningIngest>> =>
      Effect.map(Ref.get(runningIngests), (all) => [...all.values()]),
  };
});

/** Opens and closes the ingest handles of Connections, and runs their feed timers. */
export class IngestLoops extends Context.Service<IngestLoops, Effect.Success<typeof make>>()(
  "hercule/controller/plugins/IngestLoops",
) {}

export const IngestLoopsLayer: Layer.Layer<
  IngestLoops,
  never,
  SqlClient.SqlClient | ConnectionTypes | Notifier
> = Layer.effect(IngestLoops)(make);
