/**
 * The loop that runs the event pipeline on an interval.
 *
 * Each tick has two steps:
 *
 * 1. The router reads the log after its cursor, and every routing table writes
 *    a row for each route that matched.
 * 2. Every delivery reads its rows and sends the ones that can be sent now.
 *
 * These are two steps rather than one call chain, because a routing table
 * writes inside a transaction, while a delivery waits on a runner outside it.
 *
 * The routing tables and deliveries are listed in `routing/index.ts`.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Notifier } from "../../notifications";
import type { SessionService } from "../../sessions";
import type { TriggerEffects, TriggerHealth } from "../../workflows";
import { absorbFailures } from "../absorbing";
import { EventRouter } from "./event-router";
import { Live } from "../sessions";
import { buildDeliveries, buildRoutingTables } from "./routing";

/** How often the pipeline looks for events the router has not read. */
const EVENT_ROUTING_INTERVAL: Duration.Duration = Duration.seconds(1);

/** The tick interval. Tests override it with a shorter one. */
export const EventRoutingInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/EventRoutingInterval",
  { defaultValue: (): Duration.Duration => EVENT_ROUTING_INTERVAL },
);

const make = Effect.gen(function* () {
  const router = yield* EventRouter;
  const routingTables = yield* buildRoutingTables;
  const deliveries = yield* buildDeliveries;

  const tick = Effect.gen(function* () {
    yield* router.routeNewEvents(routingTables);
    // A delivery that fails must not hold back the next one: they own
    // different rows and do not depend on each other.
    for (const delivery of deliveries) {
      yield* absorbFailures(`Delivering ${delivery.name} failed`, delivery.deliverWaiting());
    }
  });

  return {
    /**
     * Runs a tick every interval, forever. A tick that fails is logged and
     * the next one runs, because one bad tick must not stop the pipeline that
     * every later matched input depends on.
     */
    driving: Effect.gen(function* () {
      const interval = yield* EventRoutingInterval;
      while (true) {
        yield* Effect.sleep(interval);
        yield* absorbFailures("Running a tick of the event pipeline failed", tick);
      }
    }),
  };
});

/** The loop that runs the event pipeline. */
export class Pipeline extends Context.Service<Pipeline, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Pipeline",
) {}

export const PipelineLayer: Layer.Layer<
  Pipeline,
  never,
  | EventRouter
  | SessionService
  | Notifier
  | TriggerHealth
  | TriggerEffects
  | Live
  | SqlClient.SqlClient
> = Layer.effect(Pipeline)(make);
