/**
 * Tests when the latest releases of the harnesses are read: at start, every
 * hour, and soon after a plugin is enabled or disabled, and never in a pile of
 * reads when several changes arrive together.
 */
import { describe, expect, it } from "vitest";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as HttpClient from "effect/http/HttpClient";
import { HarnessReleases, HarnessReleasesLayer } from "../../harnesses";
import { Plugins, PluginHost, PluginObserver } from "../../plugins";
import {
  asUser,
  buildHarnessDefinition,
  buildPluginStack,
  createPluginFixture,
} from "../../plugins/testing";
import { buildFakeProviderApi, type FakeProviderAnswer } from "../../provider-accounts/testing";
import { PromotionState } from "../../promotion";
import {
  HarnessReleaseWake,
  HarnessReleaseWakeLayer,
  runHarnessReleaseCheckLoop,
  WakeHarnessReleaseCheckOnPluginChangeLayer,
} from "./release-check-loop";

const SCOPED_URL = "https://registry.npmjs.org/%40acme%2Ftool/latest";
const PLAIN_URL = "https://registry.npmjs.org/plain-tool/latest";

const buildPlugins = () => [
  createPluginFixture({
    id: "scoped",
    definitions: [
      {
        ...buildHarnessDefinition("scoped"),
        releaseSource: { kind: "npm", package: "@acme/tool" },
      },
    ],
  }).plugin,
  createPluginFixture({
    id: "plain",
    definitions: [
      { ...buildHarnessDefinition("plain"), releaseSource: { kind: "npm", package: "plain-tool" } },
    ],
  }).plugin,
];

/**
 * Runs `body` with the loop's services over a fake registry, where the plugin
 * service reports to the observer that wakes the loop, as in the real boot.
 * `previousObserverCalls` counts the calls the wrapped observer received.
 */
const run = <A>(
  answer: (url: string, readNumber: number) => FakeProviderAnswer,
  body: (context: {
    readonly countRequests: (url: string) => number;
    readonly previousObserverCalls: () => number;
  }) => Effect.Effect<
    A,
    unknown,
    HarnessReleases | HarnessReleaseWake | PromotionState | Plugins | PluginHost
  >,
) => {
  const reads = new Map<string, number>();
  const { client, requests } = buildFakeProviderApi((request) => {
    const number = (reads.get(request.url) ?? 0) + 1;
    reads.set(request.url, number);
    return answer(request.url, number);
  });
  let previous = 0;
  const previousObserver = Layer.succeed(PluginObserver)({
    pluginStatusChanged: () =>
      Effect.sync(() => {
        previous += 1;
      }),
  });
  const observer = WakeHarnessReleaseCheckOnPluginChangeLayer.pipe(
    Layer.provide(Layer.merge(previousObserver, HarnessReleaseWakeLayer)),
  );
  const stack = HarnessReleasesLayer.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.merge(HarnessReleaseWakeLayer),
    Layer.provideMerge(buildPluginStack(observer)),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(PluginHost, (host) => host.boot(buildPlugins()));
      return yield* body({
        countRequests: (url) => requests.filter((request) => request.url === url).length,
        previousObserverCalls: () => previous,
      });
    }).pipe(Effect.provide(stack), Effect.provide(TestClock.layer()), asUser) as Effect.Effect<
      A,
      unknown,
      never
    >,
  );
};

const ok = (): FakeProviderAnswer => new Response(JSON.stringify({ version: "1.0.0" }));

describe("runHarnessReleaseCheckLoop", () => {
  it("reads every harness at once, then again every hour and not before", async () => {
    const counts = await run(ok, ({ countRequests }) =>
      Effect.gen(function* () {
        const loop = yield* Effect.forkChild(runHarnessReleaseCheckLoop);
        yield* TestClock.adjust(Duration.zero);
        const atStart = [countRequests(SCOPED_URL), countRequests(PLAIN_URL)];
        yield* TestClock.adjust(Duration.minutes(59));
        const beforeTheHour = [countRequests(SCOPED_URL), countRequests(PLAIN_URL)];
        yield* TestClock.adjust(Duration.minutes(1));
        const afterTheHour = [countRequests(SCOPED_URL), countRequests(PLAIN_URL)];
        yield* Fiber.interrupt(loop);
        return { atStart, beforeTheHour, afterTheHour };
      }),
    );

    expect(counts).toEqual({ atStart: [1, 1], beforeTheHour: [1, 1], afterTheHour: [2, 2] });
  });

  it("reads again at once when a plugin is disabled or enabled, and the observer that was there before still hears of it", async () => {
    const outcome = await run(ok, ({ countRequests, previousObserverCalls }) =>
      Effect.gen(function* () {
        const plugins = yield* Plugins;
        const loop = yield* Effect.forkChild(runHarnessReleaseCheckLoop);
        yield* TestClock.adjust(Duration.zero);
        const atStart = countRequests(PLAIN_URL);
        yield* plugins.disable("scoped");
        yield* TestClock.adjust(Duration.zero);
        const afterDisable = countRequests(PLAIN_URL);
        yield* plugins.enable("scoped");
        yield* TestClock.adjust(Duration.zero);
        const afterEnable = countRequests(PLAIN_URL);
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
      atStart: 1,
      afterDisable: 2,
      afterEnable: 3,
      previousObserverCalls: 2,
    });
  });

  it("reads once more after a read that was running when changes arrived, however many arrived", async () => {
    const counts = await run(
      (url, readNumber) => (url === PLAIN_URL && readNumber === 1 ? "silent" : ok()),
      ({ countRequests }) =>
        Effect.gen(function* () {
          const plugins = yield* Plugins;
          const loop = yield* Effect.forkChild(runHarnessReleaseCheckLoop);
          yield* TestClock.adjust(Duration.seconds(1));
          // Three changes while the first read waits for the silent registry.
          yield* plugins.disable("scoped");
          yield* plugins.enable("scoped");
          yield* plugins.disable("scoped");
          const duringTheRead = countRequests(PLAIN_URL);
          yield* TestClock.adjust(Duration.seconds(9));
          const afterTheRead = countRequests(PLAIN_URL);
          yield* TestClock.adjust(Duration.minutes(30));
          const later = countRequests(PLAIN_URL);
          yield* Fiber.interrupt(loop);
          return { duringTheRead, afterTheRead, later };
        }),
    );

    expect(counts).toEqual({ duringTheRead: 1, afterTheRead: 2, later: 2 });
  });
});
