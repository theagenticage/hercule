/**
 * The periodic read of the latest release of every harness (spec 06 section
 * 2): every harness at controller start and then every hour, and, soon after
 * any plugin changes, only the harnesses that have never been read, because a
 * plugin change can add a harness and nothing else it does needs a new read.
 *
 * What is read and what is stored is decided by `HarnessReleases`
 * (`refreshLatestReleases` and `readUnreadReleases`). This module only
 * repeats them.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { HarnessReleases } from "../../harnesses";
import { PluginObserver } from "../../plugins";
import { PromotionState } from "../../promotion";
import { absorbFailures } from "../absorbing";

/** How often the latest releases are read. Three small requests an hour. */
const HARNESS_RELEASE_CHECK_INTERVAL: Duration.Duration = Duration.hours(1);

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
 * does and then asks for a read of the harnesses that have not been read. It only signals, and
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
 * Reads the latest release of every harness at once, then again one interval
 * after the end of each such full read. When `HarnessReleaseWake` is asked
 * first, reads only the harnesses that have no stored result, and then waits
 * only for the time left until the full read is due. So requests never push
 * the full read back, however often they come. Never returns. A pass that
 * fails is logged, and the next one runs.
 *
 * A request that arrives while a pass runs leads to exactly one more pass
 * after it, however many arrive. A request that arrived before the pass
 * started is dropped when the pass starts: the pass reads at least what the
 * request would have.
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
  const promotion = yield* PromotionState;
  let pass = releases.refreshLatestReleases();
  let isFullRead = true;
  let nextFullReadAt = 0;
  while (true) {
    yield* promotion.whenServing(Effect.void);
    yield* Queue.clear(queue);
    yield* absorbFailures("Reading the latest releases of the harnesses failed", pass);
    const now = yield* Clock.currentTimeMillis;
    if (isFullRead) nextFullReadAt = now + Duration.toMillis(HARNESS_RELEASE_CHECK_INTERVAL);
    // A read of the unread harnesses can run past the due time: then the full read starts at once.
    const wake =
      nextFullReadAt > now
        ? yield* Effect.timeoutOption(Queue.take(queue), Duration.millis(nextFullReadAt - now))
        : Option.none();
    isFullRead = Option.isNone(wake);
    pass = isFullRead ? releases.refreshLatestReleases() : releases.readUnreadReleases();
  }
});
