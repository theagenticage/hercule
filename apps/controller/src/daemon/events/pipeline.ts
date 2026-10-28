/**
 * The loops that run the event pipeline on an interval.
 *
 * Each tick of the main loop has two steps:
 *
 * 1. The router reads the log after its cursor, and every routing table writes
 *    a row for each route that matched.
 * 2. Every tick delivery reads its rows and sends the ones that can be sent
 *    now.
 *
 * These are two steps rather than one call chain, because a routing table
 * writes inside a transaction, while a delivery waits on a runner outside it.
 *
 * The signal raise delivery runs on a second loop beside the first. It waits
 * on each plugin's `build`, which may call the source for up to
 * `BUILD_TIMEOUT_SECONDS`, and that wait must hold back neither the routing
 * of new events nor the other deliveries.
 *
 * The routing tables and deliveries are listed in `routing/index.ts`.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SqlClient from "effect/sql/SqlClient";
import type { AuditLog } from "../../events";
import type { Notifier } from "../../notifications";
import type { PluginIntake } from "../../intake-settings";
import type { PluginHost } from "../../plugins";
import type { RunService } from "../../runs";
import type { SessionService } from "../../sessions";
import type { SignalRaises } from "../../signals";
import type { TriggerEffects, TriggerHealth } from "../../workflows";
import { PromotionState } from "../../promotion";
import { absorbFailures } from "../absorbing";
import { EventRouter } from "./event-router";
import { Live } from "../sessions";
import { buildRoutingTables, buildTickDeliveries, signalRaiseDelivery } from "./routing";

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
  const deliveries = yield* buildTickDeliveries;
  const raises = yield* signalRaiseDelivery;
  const promotion = yield* PromotionState;

  const tick = Effect.gen(function* () {
    yield* router.routeNewEvents(routingTables);
    // A delivery that fails must not hold back the next one: they own
    // different rows and do not depend on each other.
    for (const delivery of deliveries) {
      yield* absorbFailures(`Delivering ${delivery.name} failed`, delivery.deliverWaiting());
    }
  });

  /**
   * Runs `step` every interval, forever. A step that fails is logged and the
   * next one runs, because one bad step must not stop the loop that every
   * later event depends on. `step` passes the promotion gate itself.
   */
  const repeatEveryInterval = <E>(failureMessage: string, step: Effect.Effect<void, E>) =>
    Effect.gen(function* () {
      const interval = yield* EventRoutingInterval;
      while (true) {
        yield* Effect.sleep(interval);
        yield* absorbFailures(failureMessage, step);
      }
    });

  return {
    /** Runs the tick loop and the signal raise loop side by side, forever. */
    driving: Effect.all(
      [
        repeatEveryInterval(
          "Running a tick of the event pipeline failed",
          promotion.whenServing(tick),
        ),
        // The signal raise delivery passes the gate once per raise, so a
        // freeze never waits for a whole pass of builds.
        repeatEveryInterval(`Delivering ${raises.name} failed`, raises.deliverWaiting()),
      ],
      { concurrency: "unbounded", discard: true },
    ),
  };
});

/** The loops that run the event pipeline. */
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
  | RunService
  | Live
  | PromotionState
  | SqlClient.SqlClient
  | PluginHost
  | PluginIntake
  | SignalRaises
  | AuditLog
> = Layer.effect(Pipeline)(make);
