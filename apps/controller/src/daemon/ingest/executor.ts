import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import { IngestExecutor } from "../../plugins";

const make = Effect.gen(function* () {
  // The fibers running ingests, by Connection id. Closing the layer's scope
  // when the controller stops interrupts every fiber still running.
  const ingests = yield* FiberMap.make<string>();

  return IngestExecutor.of({
    // Forked from the caller's fiber, so the ingest sees the services the
    // caller sees, such as the test clock in a test.
    execute: (connectionId, ingest) => Effect.asVoid(FiberMap.run(ingests, connectionId, ingest)),
    stop: (connectionId) => FiberMap.remove(ingests, connectionId),
  });
});

/**
 * Implements the plugins domain's Ingest Executor: each Connection's ingest
 * runs on a fiber of its own, which lives until the ingest is stopped, ends by
 * itself, or the controller stops.
 */
export const IngestExecutorLayer: Layer.Layer<IngestExecutor> = Layer.effect(IngestExecutor)(make);
