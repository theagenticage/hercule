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
import { evaluateExpression, parseExpression, type CompiledExpression } from "../../expressions";

/** One entry of a routing table: a condition and what to write when it holds. */
export interface Route {
  readonly id: string;
  /** The expression source. The router compiles it once per pass. */
  readonly condition: string;
  /** Whether the route carried an evaluation error when the pass began. */
  readonly inEvaluationError: boolean;
  readonly writeOnMatch: (event: Event) => Effect.Effect<void, SqlError>;
}

/** The routes of one kind of destination, prepared inside the routing transaction. */
export interface RoutingTable {
  /**
   * Ends the routes whose destination is gone for good, then returns the live
   * routes. Joins the caller's transaction.
   */
  readonly prepare: () => Effect.Effect<ReadonlyArray<Route>, SqlError>;
  /**
   * Records a failed evaluation on the route's health, and tells the user when
   * this failure is the first of a streak. Joins the caller's transaction.
   */
  readonly recordEvaluationFailure: (
    routeId: string,
    message: string,
  ) => Effect.Effect<void, SqlError>;
  readonly clearEvaluationFailure: (routeId: string) => Effect.Effect<void, SqlError>;
}

/** Reads and delivers one kind of row that a routing table writes. */
export interface Delivery {
  readonly name: string;
  readonly deliverWaiting: () => Effect.Effect<void, SqlError>;
}

/** One routing table's routes, and which of them are in an evaluation error. */
interface PreparedTable {
  readonly table: RoutingTable;
  readonly routes: ReadonlyArray<Route>;
  /**
   * The ids of the routes in an evaluation error, as far as this pass knows so
   * far. A route that evaluates cleanly has its health cleared only if its id
   * is in this set, so a pass over a hundred events writes nothing for a route
   * that was healthy all along.
   */
  readonly inEvaluationError: Set<string>;
}

/** A route with its compiled condition, and the prepared table it belongs to. */
interface CompiledRoute {
  readonly owner: PreparedTable;
  readonly route: Route;
  readonly program: CompiledExpression;
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

/**
 * Builds the context a condition is evaluated against: the event without its
 * raw payload. Conditions are written against the normalized fields only,
 * because a condition that read the raw payload would break as soon as the
 * source system changed its format.
 */
const buildEvaluationContext = (event: Event): Record<string, unknown> => {
  const envelope: Record<string, unknown> = { ...event };
  delete envelope["raw"];
  return { event: envelope };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Prepares every table inside the caller's transaction. */
  const prepareTables = (
    tables: ReadonlyArray<RoutingTable>,
  ): Effect.Effect<ReadonlyArray<PreparedTable>, SqlError> =>
    Effect.forEach(tables, (table) =>
      Effect.map(table.prepare(), (routes) => ({
        table,
        routes,
        inEvaluationError: new Set(
          routes.filter((route) => route.inEvaluationError).map((route) => route.id),
        ),
      })),
    );

  /**
   * Evaluates each event against each route, and writes a row for every
   * match.
   *
   * Joins the caller's transaction and waits on nothing but SQL and CPU: the
   * evaluator is synchronous and reads nothing outside the context it gets.
   *
   * A condition that fails counts as no match for its own route only. Every
   * other route is still evaluated, and the error is recorded on the route's
   * health, where callers can read it. A condition that does not parse is
   * recorded the same way as one that fails while it runs.
   */
  const routeEvents = (
    prepared: ReadonlyArray<PreparedTable>,
    batch: ReadonlyArray<Event>,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      // A route's health is about how it handled events, so a pass with no
      // events must not change it.
      if (batch.length === 0) return;

      /** Records one route's failure, and remembers that the route is in error. */
      const recordFailure = (
        owner: PreparedTable,
        routeId: string,
        message: string,
      ): Effect.Effect<void, SqlError> =>
        Effect.gen(function* () {
          yield* owner.table.recordEvaluationFailure(routeId, message);
          owner.inEvaluationError.add(routeId);
        });

      /**
       * Every route whose condition parsed, with its compiled program. Each
       * condition is parsed once for the whole batch rather than once per
       * event, because a pass reads up to a hundred events.
       */
      const compiled: Array<CompiledRoute> = [];
      for (const owner of prepared) {
        for (const route of owner.routes) {
          const program = yield* Effect.result(parseExpression(route.condition));
          if (Result.isFailure(program)) {
            yield* recordFailure(owner, route.id, program.failure.message);
            continue;
          }
          compiled.push({ owner, route, program: program.success });
        }
      }

      for (const event of batch) {
        const context = buildEvaluationContext(event);
        for (const { owner, route, program } of compiled) {
          const answer = yield* Effect.result(evaluateExpression(program, context));
          if (Result.isFailure(answer)) {
            yield* recordFailure(owner, route.id, answer.failure.message);
            continue;
          }
          if (owner.inEvaluationError.has(route.id)) {
            yield* owner.table.clearEvaluationFailure(route.id);
            owner.inEvaluationError.delete(route.id);
          }
          // Only a condition that evaluates to `true` matches. A string or a
          // number is not a match, even a truthy one.
          if (answer.success !== true) continue;
          yield* route.writeOnMatch(event);
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
        const prepared = yield* prepareTables(tables);
        const position = yield* readConsumerPosition(sql, ROUTER);
        const batch = yield* readPipelineEventsAfter(sql, position, EVENTS_PER_PASS);
        yield* routeEvents(prepared, batch);
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
        const prepared = yield* prepareTables(tables);
        if (prepared.every(({ routes }) => routes.length === 0)) return;
        const event = yield* readPipelineEvent(sql, eventId);
        if (Option.isNone(event)) return;
        yield* routeEvents(prepared, [event.value]);
      }),
  };
});

/** The only consumer of the event log. */
export class EventRouter extends Context.Service<EventRouter, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/EventRouter",
) {}

export const EventRouterLayer: Layer.Layer<EventRouter, never, SqlClient.SqlClient> =
  Layer.effect(EventRouter)(make);
