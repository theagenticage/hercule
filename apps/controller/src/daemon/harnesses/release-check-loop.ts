/**
 * The periodic read of the latest release of every harness (spec 06 section
 * 2): at controller start, then every hour, and again soon after a plugin is
 * enabled, disabled or changed, because that can add a harness to read.
 *
 * The rule itself is `HarnessReleases.refreshLatestReleases`: what is read
 * and what is stored. This module only repeats it.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { HarnessReleases } from "../../harnesses";
import { PluginObserver } from "../../plugins";
import { PromotionState } from "../../promotion";
import { absorbFailures } from "../absorbing";

/** How often the latest releases are read. Three small requests an hour. */
const HARNESS_RELEASE_CHECK_INTERVAL: Duration.Duration = Duration.hours(1);

/** The release check interval. Tests override it with a shorter one. */
export const HarnessReleaseCheckInterval = Context.Reference<Duration.Duration>(
  "hercule/controller/daemon/HarnessReleaseCheckInterval",
  { defaultValue: (): Duration.Duration => HARNESS_RELEASE_CHECK_INTERVAL },
);

/**
 * A request for the loop to read the latest releases now instead of waiting
 * for the next interval. Requests made while the loop is busy or before it
 * waits collapse into one: the queue holds at most one, the newest.
 */
export class HarnessReleaseWake extends Context.Service<
  HarnessReleaseWake,
  { readonly queue: Queue.Queue<void> }
>()("hercule/controller/daemon/HarnessReleaseWake") {}

export const HarnessReleaseWakeLayer: Layer.Layer<HarnessReleaseWake> = Layer.effect(
  HarnessReleaseWake,
)(Effect.map(Queue.sliding<void>(1), (queue) => ({ queue })));

/**
 * Replaces the `PluginObserver` below it with one that does what that one
 * does and then asks for a read of the latest releases. It only signals, and
 * never waits for the read: the plugin service calls its observer while it
 * holds the host's lifecycle permit, so waiting would keep that permit for as
 * long as the requests take.
 */
export const WakeHarnessReleaseCheckOnPluginChangeLayer: Layer.Layer<
  PluginObserver,
  never,
  PluginObserver | HarnessReleaseWake
> = Layer.effect(PluginObserver)(
  Effect.gen(function* () {
    const next = yield* PluginObserver;
    const { queue } = yield* HarnessReleaseWake;
    return {
      pluginStatusChanged: () =>
        Effect.andThen(next.pluginStatusChanged(), Queue.offer(queue, undefined)),
    };
  }),
);

/**
 * Reads the latest releases at once, then again after each interval or when
 * `HarnessReleaseWake` is asked, whichever comes first. Never returns. A pass
 * that fails is logged, and the next one runs.
 *
 * A request that arrives while a pass runs leads to exactly one more pass
 * after it, however many arrive. A request that arrived before the pass
 * started is covered by that pass, so it is dropped when the pass starts.
 *
 * A pass starts only while the controller serves, and never once it is
 * sealed. The pass itself is not counted as running work, because a freeze
 * must not wait for a slow registry. So a pass can still finish after a
 * freeze began: until the database is copied its result is stored as usual,
 * and once the copy is made the write is refused, logged, and repeated by the
 * next pass.
 */
export const runHarnessReleaseCheckLoop: Effect.Effect<
  never,
  never,
  HarnessReleases | HarnessReleaseWake | PromotionState
> = Effect.gen(function* () {
  const releases = yield* HarnessReleases;
  const { queue } = yield* HarnessReleaseWake;
  const interval = yield* HarnessReleaseCheckInterval;
  const promotion = yield* PromotionState;
  while (true) {
    yield* promotion.whenServing(Effect.void);
    yield* Queue.clear(queue);
    yield* absorbFailures(
      "Reading the latest releases of the harnesses failed",
      releases.refreshLatestReleases(),
    );
    yield* Effect.timeoutOption(Queue.take(queue), interval);
  }
});
