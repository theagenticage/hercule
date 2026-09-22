/**
 * The event pipeline's clock.
 *
 * One tick is the whole of it: the router walks the log past its cursor and
 * every routing table writes what its routes matched, and then every delivery
 * reads the rows it owns and acts on the ones that can act now. Routing and
 * delivery are two steps rather than one call chain, because a routing table
 * writes inside a transaction and a delivery waits on a machine outside it.
 *
 * What the tick walks is `routing/index.ts`: the routing tables the router is
 * handed, and the deliveries that read what those tables write.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { SessionService } from "../sessions";
import { EvaluationErrorNotifier } from "../subscriptions";
import { absorbing } from "./absorbing";
import { EventRouter } from "./event-router";
import { Live } from "./live";
import { buildDeliveries, buildRoutingTables } from "./routing";

/** How often the pipeline looks for entries the router has not read. */
const EVENT_ROUTING_INTERVAL: Duration.Duration = Duration.seconds(1);

/** Tests hand over an interval they can wait out. */
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
    // One delivery that cannot read its rows must not hold back the next one:
    // they own different rows and neither waits for the other.
    for (const delivery of deliveries) {
      yield* absorbing(`The delivery of ${delivery.name} failed`, delivery.deliverWaiting());
    }
  });

  return {
    /**
     * What the pipeline does on its own, on its own interval. A tick that
     * fails is logged and the next one runs, because one bad tick must not
     * stop the pipeline every later wake-up rides on.
     */
    driving: Effect.gen(function* () {
      const interval = yield* EventRoutingInterval;
      while (true) {
        yield* Effect.sleep(interval);
        yield* absorbing("One tick of the event pipeline failed", tick);
      }
    }),
  };
});

/** The clock the event pipeline runs on. */
export class Pipeline extends Context.Service<Pipeline, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/Pipeline",
) {}

export const PipelineLayer: Layer.Layer<
  Pipeline,
  never,
  EventRouter | SessionService | EvaluationErrorNotifier | Live | SqlClient.SqlClient
> = Layer.effect(Pipeline)(make);
