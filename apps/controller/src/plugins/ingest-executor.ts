/**
 * The Ingest Executor: the port through which the plugins domain hands each
 * Connection's ingest to be carried out apart from the request that opened
 * it, and stops it when the Connection is closed.
 *
 * The plugins domain decides what an ingest does: when each feed is polled,
 * how failures back off, and which status the Connection gets. It never
 * decides where that work runs. A domain holds no long-lived fibers and knows
 * nothing of the process lifetime, and an ingest runs for as long as its
 * Connection stays open, often for the life of the controller. The controller
 * daemon implements this port (`daemon/ingest/`), and gives each Connection's
 * ingest a place to run until it is stopped or ends by itself. ADR 0033
 * records this split between domains and the controller daemon.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

/** The Ingest Executor, which the controller daemon implements. */
export class IngestExecutor extends Context.Service<
  IngestExecutor,
  {
    /**
     * Starts running `ingest` for the Connection `connectionId`, and returns
     * at once, without waiting for any of its work. The ingest keeps running
     * until it ends by itself or `stop` is called for the Connection.
     *
     * An ingest still running for that Connection is interrupted and
     * replaced. The plugins domain only lets that happen to an ingest that is
     * already ending, because it starts no second ingest for a Connection
     * whose ingest is running.
     */
    readonly execute: (connectionId: string, ingest: Effect.Effect<void>) => Effect.Effect<void>;

    /**
     * Interrupts the ingest of the Connection `connectionId`, and returns once
     * it has finished, its finalizers included: the handle's `close` has run
     * by then. Does nothing when no ingest is running for the Connection.
     */
    readonly stop: (connectionId: string) => Effect.Effect<void>;
  }
>()("hercule/controller/plugins/IngestExecutor") {}
