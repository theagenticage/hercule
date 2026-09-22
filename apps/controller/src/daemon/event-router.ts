/**
 * The event router: the one consumer of the event log.
 *
 * It walks the pipeline events past its own durable cursor and tests each one
 * against every routing table it is handed. It polls rather than listens, and
 * it keeps how far it has read in the database, so a controller that was
 * killed and started again reads on from where it stopped instead of waiting
 * to be told about entries that arrived while it was gone.
 *
 * It carries nothing to anyone. A route that matches writes a row, and the
 * downstream consumer of that row - a delivery - reads it. So this module
 * knows the log, the cursor and the expressions, and no domain that owns a
 * destination: a routing table stands between the two, and is the only thing
 * that knows both.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Event } from "@hercule/contract";
import { withTransaction } from "../db";
import {
  advanceConsumerCursor,
  readConsumerPosition,
  readLogHead,
  readPipelineEvent,
  readPipelineEventsAfter,
} from "../events";
import { evaluateExpression, parseExpression, type CompiledExpression } from "../expressions";

/** One entry of a routing table: a condition and what to write when it holds. */
export interface Route {
  readonly id: string;
  /** The expression source. The router compiles it once per pass. */
  readonly condition: string;
  /** Whether the route carried an evaluation error when the pass began. */
  readonly inEvaluationError: boolean;
  readonly writeOnMatch: (event: Event) => Effect.Effect<void, SqlError>;
}

/** A table of routes one destination owns, prepared inside the routing transaction. */
export interface RoutingTable {
  /**
   * Sweeps entries nobody can answer any more, then answers the live routes.
   * Joins the caller's transaction.
   */
  readonly prepare: () => Effect.Effect<ReadonlyArray<Route>, SqlError>;
  /** Answers true when this failure began an error on the route's health. */
  readonly recordEvaluationFailure: (
    routeId: string,
    message: string,
  ) => Effect.Effect<boolean, SqlError>;
  readonly clearEvaluationFailure: (routeId: string) => Effect.Effect<void, SqlError>;
  /**
   * Tells whoever should know that a route's health went to error. Run after
   * the commit, once per route per new error.
   */
  readonly notifyEvaluationError: (routeId: string, message: string) => Effect.Effect<void>;
}

/** The downstream consumer of one kind of row a routing table writes. */
export interface Delivery {
  readonly name: string;
  readonly deliverWaiting: () => Effect.Effect<void, SqlError>;
}

/**
 * What a pass owes the world outside the database: the reports of the routes
 * whose health went to error. It is a value rather than a call, because the
 * pass produces it inside a transaction and nothing may be told until that
 * transaction has committed.
 */
type PendingReports = Effect.Effect<void>;

/** One routing table's routes, and which of them cannot be evaluated. */
interface PreparedTable {
  readonly table: RoutingTable;
  readonly routes: ReadonlyArray<Route>;
  /**
   * Which routes are in an evaluation error, as this pass has found them so
   * far. A route that evaluates cleanly has its health cleared only where the
   * set holds it, so a pass over a hundred entries writes nothing about a
   * route that was healthy all along.
   */
  readonly inEvaluationError: Set<string>;
}

/** One route's condition, compiled, beside the prepared table that owns it. */
interface CompiledRoute {
  readonly owner: PreparedTable;
  readonly route: Route;
  readonly program: CompiledExpression;
}

/** The router's name in the cursor table. It is the only consumer today. */
const ROUTER = "router";

/**
 * How many entries one pass reads.
 *
 * This is the only bound the pass has, and it bounds the entry count alone.
 * The routes a pass evaluates are read whole and unpaged, and the wall-clock
 * guard on one evaluation reports an overrun after the fact rather than
 * stopping it, so the time one pass takes is bounded by nothing: it grows with
 * the number of live routes and with what one expression does. The only hard
 * bound anywhere is the parse-time limit on the source of an expression. A
 * pass holds the database's one write lock the whole time it runs, so
 * everything else writing waits behind it. Real evaluations take microseconds;
 * a full pass over a hundred routes is milliseconds.
 */
const EVENTS_PER_PASS = 100;

/**
 * How many passes one tick may make.
 *
 * Ten passes are a thousand entries, which is far more than one second of any
 * real log, so a burst is walked to its end inside one tick and the cap is
 * reached only by an emitter writing faster than the router reads.
 */
const MAX_PASSES_PER_TICK = 10;

/**
 * The envelope a condition is evaluated against. The original payload the
 * source system sent is left out: a condition is written against the fields
 * Hercule normalizes, and a condition reading an unnormalized field would
 * break the moment the source changed its own shape.
 */
const buildEvaluationContext = (event: Event): Record<string, unknown> => {
  const envelope: Record<string, unknown> = { ...event };
  delete envelope["raw"];
  return { event: envelope };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Every table swept and read inside this transaction. */
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
   * Evaluates these events against these routes and writes what every route
   * that matched owes, answering the reports the failures owe.
   *
   * Joins the caller's transaction and waits on nothing but SQL and this
   * thread's own CPU: the evaluator is synchronous and reaches nothing outside
   * the context it is given.
   *
   * A condition that cannot be used is a no-match for its own route and
   * nothing else: every other route is still evaluated, and the failure is
   * recorded on the route's health, where a caller reads it. A source that
   * does not compile is such a failure, and is recorded the same way as one
   * that fails while it runs.
   */
  const routeEvents = (
    prepared: ReadonlyArray<PreparedTable>,
    batch: ReadonlyArray<Event>,
  ): Effect.Effect<PendingReports, SqlError> =>
    Effect.gen(function* () {
      // Nothing happened, so nothing is judged: a pass with no entries must not
      // move a route's health, which is a statement about events.
      if (batch.length === 0) return Effect.void;
      const reports: Array<Effect.Effect<void>> = [];

      /** Records one route's failure, and keeps the report it owes. */
      const recordFailure = (
        owner: PreparedTable,
        routeId: string,
        message: string,
      ): Effect.Effect<void, SqlError> =>
        Effect.gen(function* () {
          const began = yield* owner.table.recordEvaluationFailure(routeId, message);
          if (began) reports.push(owner.table.notifyEvaluationError(routeId, message));
          owner.inEvaluationError.add(routeId);
        });

      /**
       * Every route whose condition compiled, with the program it compiled to.
       * One source is read once for the whole batch rather than once per
       * event: a pass reads up to a hundred entries, and parsing the same
       * source a hundred times is work no event asked for.
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
          // Only a condition that answers true has matched. A condition
          // answering a string or a number has not said yes to anything.
          if (answer.success !== true) continue;
          yield* route.writeOnMatch(event);
        }
      }
      return Effect.forEach(reports, (report) => report, { discard: true });
    });

  /**
   * One pass: the tables as they stand, the entries past the cursor, and what
   * every route that matched writes.
   *
   * Everything the pass decides is one transaction, so a pass that fails part
   * way writes nothing at all, and a route created or withdrawn while the pass
   * runs is either wholly before it or wholly after it - never half seen,
   * which is how an event could be walked past for a route that existed all
   * along. Nothing in that transaction waits on anything but SQL and CPU:
   * reading the entries and storing the rows are SQL, and compiling and
   * evaluating a condition are this thread's own work. Telling anything
   * outside the database happens after the commit.
   *
   * The cursor moves even where nothing matched, and even where the batch came
   * back empty - to the end of the log as it stood inside the transaction - so
   * a log full of entries nothing waits for is walked once rather than read
   * again on every pass.
   */
  const routeOnePass = (
    tables: ReadonlyArray<RoutingTable>,
  ): Effect.Effect<
    { readonly reports: PendingReports; readonly reachedTheEnd: boolean },
    SqlError
  > =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const prepared = yield* prepareTables(tables);
        const position = yield* readConsumerPosition(sql, ROUTER);
        const batch = yield* readPipelineEventsAfter(sql, position, EVENTS_PER_PASS);
        const reports = yield* routeEvents(prepared, batch);
        const reached = batch.at(-1)?.id ?? (yield* readLogHead(sql));
        if (reached > position) yield* advanceConsumerCursor(sql, ROUTER, reached);
        return { reports, reachedTheEnd: batch.length < EVENTS_PER_PASS };
      }),
    );

  return {
    /**
     * Everything the log holds past the cursor, in passes of
     * `EVENTS_PER_PASS`, and then what those passes owe the world outside the
     * database.
     *
     * A batch that came back full has left entries behind it, and waiting a
     * whole interval for each of the next hundred would make a burst of a
     * thousand events take ten intervals to reach the sessions waiting for it.
     * So a full batch is followed by another pass at once, and the log is
     * walked to its end at the speed of SQL. Each pass is its own transaction,
     * so the write lock is released between them and nothing else writing is
     * held off for the whole burst.
     *
     * The passes are capped all the same. An emitter that keeps writing a full
     * batch between one pass and the next would hold the loop here for ever,
     * and the rows the earlier passes committed would never be read by a
     * delivery. At the cap the router returns, the tick delivers what the
     * passes wrote, and the next tick reads on from the cursor.
     */
    routeNewEvents: (tables: ReadonlyArray<RoutingTable>): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        for (let pass = 0; pass < MAX_PASSES_PER_TICK; pass++) {
          const { reports, reachedTheEnd } = yield* routeOnePass(tables);
          yield* reports;
          if (reachedTheEnd) break;
        }
      }),

    /**
     * One more look at one event, for a route that may have been created, or a
     * ref that may have been added, since the router walked past it.
     *
     * The cursor is not touched: this is not a step through the log, and moving
     * it would either skip entries or read them again. What a route writes is
     * unique per route and event, so whatever matched the first time gets
     * nothing a second time.
     *
     * The tables are prepared as they are for a pass, sweep and all: a route
     * nobody can answer any more is not a route, and an event must no more
     * reach it here than it would on a pass.
     *
     * Joins the caller's transaction and writes rows only. It answers the
     * reports the look owes, which the caller runs once its transaction has
     * committed.
     */
    rerouteEvent: (
      eventId: number,
      tables: ReadonlyArray<RoutingTable>,
    ): Effect.Effect<PendingReports, SqlError> =>
      Effect.gen(function* () {
        const prepared = yield* prepareTables(tables);
        if (prepared.every(({ routes }) => routes.length === 0)) return Effect.void;
        const event = yield* readPipelineEvent(sql, eventId);
        if (Option.isNone(event)) return Effect.void;
        return yield* routeEvents(prepared, [event.value]);
      }),
  };
});

/** The one consumer of the event log. */
export class EventRouter extends Context.Service<EventRouter, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/EventRouter",
) {}

export const EventRouterLayer: Layer.Layer<EventRouter, never, SqlClient.SqlClient> =
  Layer.effect(EventRouter)(make);
