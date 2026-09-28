/**
 * The event router: the only consumer of the event log.
 *
 * It reads the pipeline events after its cursor and tests each one against
 * every routing table it receives. It polls instead of waiting to be notified,
 * and it stores its cursor in the database. So a controller that was killed
 * and restarted continues from where it stopped, including the events that
 * arrived while it was down.
 *
 * The router does not deliver anything itself. A route that matches writes a
 * row, and a delivery reads that row later. So this module knows the log, the
 * cursor and the expressions, but none of the domains that own a destination.
 * A routing table sits between the two and is the only thing that knows both.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Event } from "@hercule/contract";
import { withTransaction } from "../../db";
import {
  advanceConsumerCursor,
  readConsumerPosition,
  readLogHead,
  readPipelineEvent,
  readPipelineEventsAfter,
} from "../../events";
import {
  evaluateExpression,
  parseExpression,
  type CompiledExpression,
  type ExpressionError,
} from "../../expressions";

/**
 * One entry of a routing table: which events it wants, and what to write when
 * one matches. An event matches when the route admits it and its condition,
 * if it has one, evaluates to `true`.
 */
export interface Route {
  /**
   * Returns whether the route wants this event at all, before any expression
   * is evaluated. A route whose condition is written for one kind of event
   * uses it to skip the others, so the condition never fails on an event it
   * was not written for.
   */
  readonly admits: (event: Event) => boolean;
  /** The expression source, or `undefined` to match every admitted event. The router compiles it once per pass. */
  readonly condition: string | undefined;
  /** Whether the route carried an evaluation error when the pass began. */
  readonly inEvaluationError: boolean;
  /**
   * Writes the row for a matched event. `context` is what the condition was
   * evaluated against, for a route that evaluates more of its own
   * expressions to build the row. Fails with `ExpressionError` when one of
   * them fails; the router then treats the event as no match and records the
   * error like a failed condition.
   */
  readonly writeOnMatch: (
    event: Event,
    context: EvaluationContext,
  ) => Effect.Effect<void, ExpressionError | SqlError>;
  /**
   * Records a failed evaluation on the route's health, and tells the user when
   * this failure is the first of a streak. Joins the caller's transaction.
   */
  readonly recordEvaluationFailure: (message: string) => Effect.Effect<void, SqlError>;
  /** Clears the route's recorded evaluation error. Joins the caller's transaction. */
  readonly clearEvaluationFailure: () => Effect.Effect<void, SqlError>;
}

/** The routes of one kind of destination, prepared inside the routing transaction. */
export interface RoutingTable {
  /**
   * Ends the routes whose destination is gone for good, then returns the live
   * routes. Joins the caller's transaction.
   */
  readonly prepare: () => Effect.Effect<ReadonlyArray<Route>, SqlError>;
}

/** Reads and delivers one kind of row that a routing table writes. */
export interface Delivery {
  readonly name: string;
  readonly deliverWaiting: () => Effect.Effect<void, SqlError>;
}

/**
 * A route during one pass: its compiled condition, and whether it is in an
 * evaluation error as far as this pass knows so far.
 */
interface RouteInPass {
  readonly route: Route;
  /**
   * The compiled condition. `undefined` until an admitted event first needs
   * it, and `null` once it failed to parse, so the failure is recorded once
   * per pass and not once per event.
   */
  program: CompiledExpression | null | undefined;
  /**
   * A route that evaluates cleanly has its health cleared only when this is
   * set, so a pass over a hundred events writes nothing for a route that was
   * healthy all along.
   */
  inEvaluationError: boolean;
}

/** The router's name in the cursor table. It is the only consumer today. */
const ROUTER = "router";

/**
 * How many events one pass reads.
 *
 * This is the only limit on a pass, and it limits the number of events only.
 * Nothing limits how long a pass takes:
 *
 * - the pass reads all routes, without paging;
 * - the time guard on an evaluation reports an overrun after it happens, and
 *   does not stop it;
 * - the only hard limit is the maximum length of an expression's source,
 *   checked at parse time.
 *
 * So the time grows with the number of live routes and the cost of each
 * expression. A pass holds the database's single write lock the whole time,
 * so every other write waits for it. In practice an evaluation takes
 * microseconds, and a full pass over a hundred routes takes milliseconds.
 */
const EVENTS_PER_PASS = 100;

/**
 * How many passes one tick may make.
 *
 * Ten passes read a thousand events, far more than any real log gets in one
 * second. So a burst is read to its end within one tick, and the cap is
 * reached only when an emitter writes faster than the router reads.
 */
const MAX_PASSES_PER_TICK = 10;

/** What an expression over one event is evaluated against. */
export type EvaluationContext = Readonly<Record<string, unknown>>;

/**
 * Builds the context an expression over `event` is evaluated against: the
 * event without its raw payload. Expressions are written against the
 * normalized fields only, because one that read the raw payload would break
 * as soon as the source system changed its format.
 */
const buildEvaluationContext = (event: Event): EvaluationContext => ({
  event: Struct.omit(event, ["raw"]),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Prepares every table inside the caller's transaction, and returns all their routes. */
  const prepareRoutes = (
    tables: ReadonlyArray<RoutingTable>,
  ): Effect.Effect<ReadonlyArray<Route>, SqlError> =>
    Effect.map(
      Effect.forEach(tables, (table) => table.prepare()),
      (routes) => routes.flat(),
    );

  /**
   * Evaluates each event against each route that admits it, and writes a row
   * for every match.
   *
   * Joins the caller's transaction and waits on nothing but SQL and CPU: the
   * evaluator is synchronous and reads nothing outside the context it gets.
   *
   * A condition that fails counts as no match for its own route only. Every
   * other route is still evaluated, and the error is recorded on the route's
   * health, where callers can read it. A condition that does not parse, and
   * an expression that fails while the matched row is built, are recorded the
   * same way. A route whose expressions all evaluate cleanly for an event has
   * its recorded error cleared.
   */
  const routeEvents = (
    routes: ReadonlyArray<Route>,
    batch: ReadonlyArray<Event>,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const inPass: ReadonlyArray<RouteInPass> = routes.map((route) => ({
        route,
        program: undefined,
        inEvaluationError: route.inEvaluationError,
      }));

      /** Records one route's failure, and remembers that the route is in error. */
      const recordFailure = (entry: RouteInPass, message: string): Effect.Effect<void, SqlError> =>
        Effect.gen(function* () {
          yield* entry.route.recordEvaluationFailure(message);
          entry.inEvaluationError = true;
        });

      /** Clears one route's recorded failure, if it has one. */
      const clearFailure = (entry: RouteInPass): Effect.Effect<void, SqlError> =>
        Effect.gen(function* () {
          if (!entry.inEvaluationError) return;
          yield* entry.route.clearEvaluationFailure();
          entry.inEvaluationError = false;
        });

      /**
       * Decides whether the route's condition holds for the event. Returns
       * `undefined` when it could not be decided; the failure is recorded.
       * Each condition is parsed at most once per pass rather than once per
       * event, because a pass reads up to a hundred events.
       */
      const decideCondition = (
        entry: RouteInPass,
        context: EvaluationContext,
      ): Effect.Effect<boolean | undefined, SqlError> =>
        Effect.gen(function* () {
          const condition = entry.route.condition;
          if (condition === undefined) return true;
          if (entry.program === null) return undefined;
          if (entry.program === undefined) {
            const parsed = yield* Effect.result(parseExpression(condition));
            if (Result.isFailure(parsed)) {
              entry.program = null;
              yield* recordFailure(entry, parsed.failure.message);
              return undefined;
            }
            entry.program = parsed.success;
          }
          const answer = yield* Effect.result(evaluateExpression(entry.program, context));
          if (Result.isFailure(answer)) {
            yield* recordFailure(entry, answer.failure.message);
            return undefined;
          }
          // Only a condition that evaluates to `true` matches. A string or a
          // number is not a match, even a truthy one.
          return answer.success === true;
        });

      for (const event of batch) {
        const context = buildEvaluationContext(event);
        for (const entry of inPass) {
          if (!entry.route.admits(event)) continue;
          const matched = yield* decideCondition(entry, context);
          if (matched === undefined) continue;
          if (matched) {
            const written = yield* entry.route.writeOnMatch(event, context).pipe(
              Effect.as(true),
              Effect.catchTag("ExpressionError", (error) =>
                Effect.as(recordFailure(entry, error.message), false),
              ),
            );
            if (!written) continue;
          }
          yield* clearFailure(entry);
        }
      }
    });

  /**
   * Runs one pass: prepares the tables, reads the next batch of events after
   * the cursor, writes a row for every match, and moves the cursor. Returns
   * whether the pass reached the end of the log.
   *
   * The whole pass is one transaction, which gives two guarantees:
   *
   * - a pass that fails part way writes nothing at all;
   * - a route created or removed during the pass is seen either fully or not
   *   at all, so no event is skipped for a route that existed all along.
   *
   * Nothing in the transaction waits on anything but SQL and CPU.
   *
   * The cursor moves even when nothing matched. When the batch is empty, it
   * moves to the end of the log as read inside the transaction. So events that
   * no route wants are read once, not on every pass.
   */
  const routeOnePass = (
    tables: ReadonlyArray<RoutingTable>,
  ): Effect.Effect<{ readonly reachedTheEnd: boolean }, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const routes = yield* prepareRoutes(tables);
        const position = yield* readConsumerPosition(sql, ROUTER);
        const batch = yield* readPipelineEventsAfter(sql, position, EVENTS_PER_PASS);
        yield* routeEvents(routes, batch);
        const reached = batch.at(-1)?.id ?? (yield* readLogHead(sql));
        if (reached > position) yield* advanceConsumerCursor(sql, ROUTER, reached);
        return { reachedTheEnd: batch.length < EVENTS_PER_PASS };
      }),
    );

  return {
    /**
     * Routes every event after the cursor, in passes of `EVENTS_PER_PASS`.
     *
     * A full batch means more events are waiting. Waiting a whole interval
     * before each next batch would make a burst of a thousand events take ten
     * intervals to reach the sessions waiting for it. So a full batch is
     * followed by another pass at once. Each pass is its own transaction, so
     * the write lock is released between passes and other writes are not held
     * off for the whole burst.
     *
     * The number of passes is still capped. An emitter that keeps writing a
     * full batch between passes would otherwise keep the loop here forever,
     * and no delivery would ever read the rows the earlier passes wrote. At
     * the cap the router returns, the tick delivers what the passes wrote, and
     * the next tick continues from the cursor.
     */
    routeNewEvents: (tables: ReadonlyArray<RoutingTable>): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        for (let pass = 0; pass < MAX_PASSES_PER_TICK; pass++) {
          const { reachedTheEnd } = yield* routeOnePass(tables);
          if (reachedTheEnd) break;
        }
      }),

    /**
     * Routes one event again, for a route that may have been created, or a
     * ref that may have been added, since the router first read the event.
     *
     * The cursor does not move: this is not a step through the log, and moving
     * it would skip events or read them twice. Each route writes at most one
     * row per event, so a route that matched the first time writes nothing
     * new.
     *
     * The tables are prepared exactly as for a pass, including ending routes
     * whose destination is gone, so an event cannot reach such a route here
     * either.
     *
     * Joins the caller's transaction and only writes rows.
     */
    rerouteEvent: (
      eventId: number,
      tables: ReadonlyArray<RoutingTable>,
    ): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const routes = yield* prepareRoutes(tables);
        if (routes.length === 0) return;
        const event = yield* readPipelineEvent(sql, eventId);
        if (Option.isNone(event)) return;
        yield* routeEvents(routes, [event.value]);
      }),
  };
});

/** The only consumer of the event log. */
export class EventRouter extends Context.Service<EventRouter, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/EventRouter",
) {}

export const EventRouterLayer: Layer.Layer<EventRouter, never, SqlClient.SqlClient> =
  Layer.effect(EventRouter)(make);
