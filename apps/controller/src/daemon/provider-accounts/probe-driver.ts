/**
 * Keeps the Provider Account snapshots fresh for the life of the controller:
 * probes every account on a runner when it connects, and sweeps the whole
 * fleet on a timer, because a login can expire and a harness can be upgraded
 * outside Hercule, which makes a snapshot older than the interval unreliable.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { RunnerConnections } from "../../runners";
import { ProviderAccountProbing } from "./probing";

const PROBE_INTERVAL: Duration.Duration = Duration.hours(1);

/** Lets tests set an interval short enough to wait for. */
export const ProviderAccountProbeInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/ProviderAccountProbeInterval",
  { defaultValue: (): Duration.Duration => PROBE_INTERVAL },
);

const make = Effect.gen(function* () {
  const connections = yield* RunnerConnections;
  const probing = yield* ProviderAccountProbing;

  return {
    /** Runs forever. Sweeps each runner that connects, and the whole fleet every interval. */
    driving: Effect.all(
      [
        // Forked, because a runner that answers slowly must not hold up the
        // next runner's sweep.
        Stream.runForEach(connections.arrivals, (runnerId) =>
          Effect.forkChild(probing.sweepRunner(runnerId)),
        ),
        Effect.gen(function* () {
          const interval = yield* ProviderAccountProbeInterval;
          while (true) {
            yield* Effect.sleep(interval);
            yield* probing.sweepFleet();
          }
        }),
      ],
      { concurrency: "unbounded", discard: true },
    ),
  };
});

export class ProbeDriver extends Context.Service<ProbeDriver, Effect.Success<typeof make>>()(
  "hercule/controller/daemon/ProbeDriver",
) {}

export const ProbeDriverLayer: Layer.Layer<
  ProbeDriver,
  never,
  RunnerConnections | ProviderAccountProbing
> = Layer.effect(ProbeDriver)(make);
