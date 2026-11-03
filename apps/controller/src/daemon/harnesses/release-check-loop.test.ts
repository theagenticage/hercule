/**
 * Tests when the latest releases of the harnesses are read: every harness at
 * start and every hour, and soon after any plugin changes only the harnesses
 * that were never read, and never in a pile of reads when several changes
 * arrive together. The reads themselves are counted with a stand-in for
 * `HarnessReleases`; what a read stores is tested with the real one.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { HarnessReleases } from "../../harnesses";
import { Plugins, PluginHost, PluginObserver } from "../../plugins";
import {
  asUser,
  buildHarnessDefinition,
  buildPluginStack,
  createPluginFixture,
} from "../../plugins/testing";
import { PromotionState } from "../../promotion";
import {
  HarnessReleaseWake,
  HarnessReleaseWakeLayer,
  runHarnessReleaseCheckLoop,
  WakeHarnessReleaseCheckOnPluginChangeLayer,
} from "./release-check-loop";

const buildPlugins = () => [
  createPluginFixture({
    id: "scoped",
    definitions: [buildHarnessDefinition("scoped")],
  }).plugin,
];

/**
 * Runs `body` with the loop's services, where the plugin service reports to
 * the observer that wakes the loop, as in the real boot. A read of the
 * unread harnesses takes `unreadDuration`. `previousObserverCalls` counts the
 * calls the wrapped observer received.
 */
const run = <A>(
  unreadDuration: Duration.Duration,
  body: (context: {
    readonly refreshes: () => number;
    readonly unreadReads: () => number;
    readonly previousObserverCalls: () => number;
  }) => Effect.Effect<
    A,
    unknown,
    HarnessReleases | HarnessReleaseWake | PromotionState | Plugins | PluginHost
  >,
) => {
  let refreshes = 0;
  let unreadReads = 0;
  let previous = 0;
  const releases = Layer.succeed(HarnessReleases)({
    refreshLatestReleases: () =>
      Effect.sync(() => {
        refreshes += 1;
      }),
    readUnreadReleases: () =>
      Effect.andThen(
        Effect.sync(() => {
          unreadReads += 1;
        }),
        Effect.sleep(unreadDuration),
      ),
  });
  const previousObserver = Layer.succeed(PluginObserver)({
    pluginStatusChanged: () =>
      Effect.sync(() => {
        previous += 1;
      }),
  });
  const observer = WakeHarnessReleaseCheckOnPluginChangeLayer.pipe(Layer.provide(previousObserver));
  const stack = Layer.merge(
    releases,
    buildPluginStack(observer).pipe(Layer.provideMerge(HarnessReleaseWakeLayer)),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(PluginHost, (host) => host.boot(buildPlugins()));
      return yield* body({
        refreshes: () => refreshes,
        unreadReads: () => unreadReads,
        previousObserverCalls: () => previous,
      });
    }).pipe(Effect.provide(stack), Effect.provide(TestClock.layer()), asUser),
  );
};

describe("runHarnessReleaseCheckLoop", () => {
  it("reads every harness at once, then again every hour and not before", async () => {
    const counts = await run(Duration.zero, ({ refreshes }) =>
      Effect.gen(function* () {
        const loop = yield* Effect.forkChild(runHarnessReleaseCheckLoop);
        yield* TestClock.adjust(Duration.zero);
        const atStart = refreshes();
        yield* TestClock.adjust(Duration.minutes(59));
        const beforeTheHour = refreshes();
        yield* TestClock.adjust(Duration.minutes(1));
        const afterTheHour = refreshes();
        yield* Fiber.interrupt(loop);
        return { atStart, beforeTheHour, afterTheHour };
      }),
    );

    expect(counts).toEqual({ atStart: 1, beforeTheHour: 1, afterTheHour: 2 });
  });

  it("reads only the unread harnesses at once when a plugin is disabled or enabled, and the observer that was there before still hears of it", async () => {
    const outcome = await run(Duration.zero, ({ refreshes, unreadReads, previousObserverCalls }) =>
      Effect.gen(function* () {
        const plugins = yield* Plugins;
        const loop = yield* Effect.forkChild(runHarnessReleaseCheckLoop);
        yield* TestClock.adjust(Duration.zero);
        const atStart = { refreshes: refreshes(), unreadReads: unreadReads() };
        yield* plugins.disable("scoped");
        yield* TestClock.adjust(Duration.zero);
        const afterDisable = { refreshes: refreshes(), unreadReads: unreadReads() };
        yield* plugins.enable("scoped");
        yield* TestClock.adjust(Duration.zero);
        const afterEnable = { refreshes: refreshes(), unreadReads: unreadReads() };
        yield* Fiber.interrupt(loop);
        return {
          atStart,
          afterDisable,
          afterEnable,
          previousObserverCalls: previousObserverCalls(),
        };
      }),
    );

    expect(outcome).toEqual({
      atStart: { refreshes: 1, unreadReads: 0 },
      afterDisable: { refreshes: 1, unreadReads: 1 },
      afterEnable: { refreshes: 1, unreadReads: 2 },
      previousObserverCalls: 2,
    });
  });

  it("reads once more after a read that was running when changes arrived, however many arrived", async () => {
    const counts = await run(Duration.seconds(10), ({ refreshes, unreadReads }) =>
      Effect.gen(function* () {
        const plugins = yield* Plugins;
        const loop = yield* Effect.forkChild(runHarnessReleaseCheckLoop);
        yield* TestClock.adjust(Duration.seconds(1));
        yield* plugins.disable("scoped");
        yield* TestClock.adjust(Duration.seconds(1));
        // Three more changes while the first read of unread harnesses runs.
        yield* plugins.enable("scoped");
        yield* plugins.disable("scoped");
        yield* plugins.enable("scoped");
        const duringTheRead = unreadReads();
        yield* TestClock.adjust(Duration.seconds(9));
        const afterTheRead = unreadReads();
        yield* TestClock.adjust(Duration.minutes(30));
        const later = { unreadReads: unreadReads(), refreshes: refreshes() };
        yield* Fiber.interrupt(loop);
        return { duringTheRead, afterTheRead, later };
      }),
    );

    expect(counts).toEqual({
      duringTheRead: 1,
      afterTheRead: 2,
      later: { unreadReads: 2, refreshes: 1 },
    });
  });
});
