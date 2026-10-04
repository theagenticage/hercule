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
 * - sets the Connection to `error`, and raises one `core.connection-error`
 *   notification, when one feed or the open has failed five times in a row;
 * - sets it back to `connected` after a success, once nothing is failing;
 * - sets it to `needs-reauth` and stops at the first `AuthError`, because
 *   retrying with rejected credentials cannot help.
 *
 * Closing a Connection interrupts its feed timers, waits for them to finish,
 * then calls the handle's `close` once. The controller daemon decides which
 * Connections are open; this module only opens and closes what it is told.
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
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  AuthError,
  decodeAgainst,
  type FeedDeclaration,
  type IngestHandle,
  PluginError,
} from "@hercule/plugin-host";
import { announce, nowIso, withTransaction } from "../db";
import { connectionRepository, ConnectionTypes, type StoredConnection } from "../connections";
import { Notifier } from "../notifications";
import { readCauseMessage, toPluginError } from "./errors";
import type { RegisteredEventSource } from "./event-sources";
import { ingestContexts } from "./ingest-context";

/** After this many failures in a row, of one feed or of the open, the Connection is set to `error`. */
export const FAILURES_BEFORE_ERROR = 5;

/** The longest wait between two tries of a failing feed, in seconds: 15 minutes. */
const MAX_RETRY_DELAY_SECONDS = 900;

/** The base of the open's backoff for a source that declares no feeds, in seconds. */
const OPEN_RETRY_SECONDS_WITHOUT_FEEDS = 60;

/** The key the open's failures are counted under, beside the feeds' names. */
const OPENING = Symbol("opening");

/** The body of a `core.connection-error` notification. */
const CONNECTION_ERROR_BODY =
  "The last error is shown on the Connection's card on the Connections screen. " +
  "Polling goes on with longer waits, and the Connection returns to connected " +
  "after its next successful poll.";

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

/** One open Connection, as the controller daemon compares it with what should be open. */
export interface OpenIngest {
  readonly connectionId: string;
  readonly pluginId: string;
  readonly fingerprint: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* connectionRepository;
  const connectionTypes = yield* ConnectionTypes;
  const notifier = yield* Notifier;
  const contexts = yield* ingestContexts;
  const supervisors = yield* FiberMap.make<string>();
  // What each supervisor was opened with. An entry outlives its fiber when
  // the fiber ends by itself, so only entries whose fiber is still in the
  // fiber map count as open.
  const opened = yield* Ref.make(new Map<string, OpenIngest>());

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
      // Failures in a row, by feed name, and of the open under `OPENING`.
      const failures = new Map<string | typeof OPENING, number>();

      const writeStatus = (write: (at: string) => Effect.Effect<void, unknown>) =>
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

      /** Resets the count of one feed, and sets an `error` Connection back to `connected` once nothing is failing. */
      const recordSuccess = (key: string | typeof OPENING): Effect.Effect<void> =>
        Effect.suspend(() => {
          failures.set(key, 0);
          if ([...failures.values()].some((count) => count >= FAILURES_BEFORE_ERROR)) {
            return Effect.void;
          }
          return writeStatus((at) =>
            Effect.gen(function* () {
              if (
                yield* connections.changeStatusFrom(connection.id, ["error"], "connected", null, at)
              ) {
                yield* announceConnection;
              }
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
      const recordFailure = (
        key: string | typeof OPENING,
        message: string,
      ): Effect.Effect<number> =>
        Effect.gen(function* () {
          const count = (failures.get(key) ?? 0) + 1;
          failures.set(key, count);
          if (count < FAILURES_BEFORE_ERROR) return count;
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
              yield* notifier.createCoreNotification({
                kind: "core.connection-error",
                title: `${typeDisplayName} connection '${connection.label}' keeps failing`,
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
       * Handles one failed open or poll. Passes an interruption on, sets the
       * Connection to `needs-reauth` and fails on an `AuthError`, and
       * otherwise counts the failure and returns the wait before the next
       * try, in seconds. A defect is logged, because it is a bug in the
       * plugin that its author needs to see.
       */
      const handleFailure = (
        key: string | typeof OPENING,
        intervalSeconds: number,
        cause: Cause.Cause<AuthError | PluginError>,
      ): Effect.Effect<number, AuthError> =>
        Effect.gen(function* () {
          if (Cause.hasInterrupts(cause)) return yield* Effect.interrupt;
          const error = Option.getOrUndefined(Cause.findErrorOption(cause));
          if (error instanceof AuthError) {
            yield* writeStatus((at) =>
              Effect.gen(function* () {
                if (
                  yield* connections.changeStatusFrom(
                    connection.id,
                    ["connected", "error"],
                    "needs-reauth",
                    readCauseMessage(cause),
                    at,
                  )
                ) {
                  yield* announceConnection;
                }
              }),
            );
            return yield* Effect.fail(error);
          }
          if (error === undefined) {
            yield* Effect.logError(
              `The event source ${source.id} crashed on the Connection ${connection.id}`,
              cause,
            );
          }
          const count = yield* recordFailure(key, readCauseMessage(cause));
          return computeRetryDelay(intervalSeconds, count);
        });

      const decodeConfig: Effect.Effect<unknown, PluginError> =
        configSchema === undefined
          ? Effect.succeed(connection.config)
          : Effect.mapError(decodeAgainst(configSchema, connection.config), toPluginError);

      const intervals = Object.entries(source.feeds).map(
        ([name, declaration]) =>
          [name, computeFeedInterval(declaration, connection.feedIntervals[name])] as const,
      );
      const openRetrySeconds =
        intervals.length === 0
          ? OPEN_RETRY_SECONDS_WITHOUT_FEEDS
          : Math.min(...intervals.map(([, seconds]) => seconds));

      /** Opens the handle, retrying with backoff until it opens or the credentials are rejected. */
      const openWithRetry: Effect.Effect<IngestHandle, AuthError> = Effect.gen(function* () {
        while (true) {
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
          if (Exit.isSuccess(attempt)) {
            yield* recordSuccess(OPENING);
            return attempt.value;
          }
          const delay = yield* handleFailure(OPENING, openRetrySeconds, attempt.cause);
          yield* Effect.sleep(Duration.seconds(delay));
        }
      });

      /** Polls one feed right away and then forever. Fails only with an `AuthError`. */
      const runFeed = (
        handle: IngestHandle,
        lock: Semaphore.Semaphore,
        name: string,
        intervalSeconds: number,
      ): Effect.Effect<never, AuthError> =>
        Effect.gen(function* () {
          while (true) {
            const polled = yield* Effect.exit(
              lock.withPermit(Effect.suspend(() => handle.poll(name))),
            );
            let delay: number;
            if (Exit.isSuccess(polled)) {
              yield* recordSuccess(name);
              // A plugin's number is not trusted to be a number.
              const asked = polled.value.nextAfterSeconds;
              delay = Math.max(intervalSeconds, Number.isFinite(asked) ? (asked as number) : 0);
            } else {
              delay = yield* handleFailure(name, intervalSeconds, polled.cause);
            }
            yield* Effect.sleep(Duration.seconds(delay));
          }
        });

      yield* Effect.scoped(
        Effect.gen(function* () {
          // The open itself can be interrupted; once it returns a handle,
          // registering its close cannot be.
          const handle = yield* Effect.uninterruptibleMask((restore) =>
            Effect.tap(restore(openWithRetry), (handle) =>
              Effect.addFinalizer(() =>
                Effect.catchCause(
                  Effect.suspend(() => handle.close),
                  (cause) =>
                    Effect.logError(
                      `The event source ${source.id} failed to close the Connection ${connection.id}`,
                      cause,
                    ),
                ),
              ),
            ),
          );
          const lock = yield* Semaphore.make(1);
          yield* Effect.forEach(
            intervals,
            ([name, seconds]) => runFeed(handle, lock, name, seconds),
            { concurrency: "unbounded", discard: true },
          );
          // A source without feeds keeps its handle open until it is closed.
          yield* Effect.never;
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
    );

  const close = (connectionId: string): Effect.Effect<void> =>
    Effect.andThen(
      FiberMap.remove(supervisors, connectionId),
      Ref.update(opened, (all) => {
        const next = new Map(all);
        next.delete(connectionId);
        return next;
      }),
    );

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
        yield* Ref.update(opened, (all) =>
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
     * the feed timers are interrupted and finished, and `close` has
     * returned. Does nothing when the Connection is not open.
     */
    close,

    /** Stops ingesting every Connection open through the plugin's sources, and returns once all are closed. */
    closePlugin: (pluginId: string): Effect.Effect<void> =>
      Effect.flatMap(Ref.get(opened), (all) =>
        Effect.forEach(
          [...all.values()].filter((one) => one.pluginId === pluginId),
          (one) => close(one.connectionId),
          { discard: true },
        ),
      ),

    /**
     * Lists the Connections whose loop is running. A loop that ended by
     * itself, after an `AuthError`, is not in the list.
     */
    listOpen: (): Effect.Effect<ReadonlyArray<OpenIngest>> =>
      Effect.gen(function* () {
        const all = yield* Ref.get(opened);
        const running: Array<OpenIngest> = [];
        for (const one of all.values()) {
          if (yield* FiberMap.has(supervisors, one.connectionId)) running.push(one);
        }
        return running;
      }),
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
