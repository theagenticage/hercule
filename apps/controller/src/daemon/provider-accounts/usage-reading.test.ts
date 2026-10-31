/**
 * Tests the usage loop with a stand-in for the connection to the runners and
 * for the provider's API, on a test clock: which reads it starts, which it
 * leaves alone, and that nothing is claimed for a read that cannot start.
 */
import { describe, expect, it } from "vitest";
import { Clock, Duration, Effect, Layer, Logger, Option, Queue, Stream } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";
import type { Plugin, ProviderDefinition } from "@hercule/plugin-host";
import type { ControllerToRunner, RunnerToController } from "@hercule/protocol";
import { uuidFromString, withTransaction } from "../../db";
import { PromotionState } from "../../promotion";
import { PluginHost } from "../../plugins";
import {
  asUser,
  buildHarnessDefinition,
  buildPluginStack,
  createPluginFixture,
} from "../../plugins/testing";
import {
  HarnessAccountsLayer,
  ModelCatalogsLayer,
  ProviderAccountProbesLayer,
  ProviderAccountRunners,
  ProviderAccountRunnersLayer,
  ProviderAccountService,
  ProviderAccountServiceLayer,
  ProviderKeyRequestsLayer,
} from "../../provider-accounts";
import {
  addAccount,
  addRunner,
  addSnapshot,
  ALPHA_HARNESS_ID,
  buildFakeProviderApi,
  buildMeteredPlugin,
  inertMembership,
  METERED,
  METERED_KEY_KIND,
  METERED_PROVIDER_ID,
  setTokenExpiry,
  SIGNED_IN,
  storeCredential,
} from "../../provider-accounts/testing";
import { NotifierLayer } from "../../notifications";
import { LocalRunnerId, RunnerConnections } from "../../runners";
import { Secrets } from "../../secrets";
import { SettingsLayer } from "../../settings";
import { AccountUsage, AccountUsageLayer } from "../../usage";
import { ProviderAccountProbing, ProviderAccountProbingLayer } from "./probing";
import { runAccountUsageReadingLoop } from "./usage-reading";

/** Metered's key account is read with its key. The two kinds added here are read through a probe, and by sessions only. */
const MACHINE_KIND = "subscription";
const SESSIONS_KIND = "sessions-only";

const METERED_WITH_MACHINES: ProviderDefinition = {
  ...METERED,
  kinds: [
    ...METERED.kinds,
    {
      id: MACHINE_KIND,
      title: "Subscription",
      description: "A plan signed in on each machine.",
      setup: [{ kind: "harness-login", method: "sign-in" }],
      usage: { readBy: "harness", harnessId: ALPHA_HARNESS_ID },
      harnesses: [ALPHA_HARNESS_ID],
    },
    {
      id: SESSIONS_KIND,
      title: "Sessions only",
      description: "A plan whose usage only sessions report.",
      setup: [{ kind: "harness-login", method: "sign-in" }],
      usage: { readBy: "sessions" },
      harnesses: [ALPHA_HARNESS_ID],
    },
  ],
};

const buildPlugins = (): ReadonlyArray<Plugin> => [
  buildMeteredPlugin(METERED_WITH_MACHINES),
  createPluginFixture({
    id: "alpha",
    definitions: [
      buildHarnessDefinition("alpha", [
        {
          providerId: METERED_PROVIDER_ID,
          kinds: [
            { kind: METERED_KEY_KIND, credentialVariable: "METERED_API_KEY" },
            { kind: MACHINE_KIND },
            { kind: SESSIONS_KIND },
          ],
          modelArgument: "{model}",
          models: "own-list",
        },
      ]),
    ],
  }).plugin,
];

interface Sent {
  readonly runnerId: string;
  readonly request: ControllerToRunner;
}

/** What the stand-in runners do, which a test changes while it runs. */
interface RunnerBehaviour {
  /** The runner whose connection breaks on every probe, or none. */
  brokenRunnerId: string | undefined;
}

/** A connection that records every frame and answers each probe as a signed-in runner, with usage when asked. */
const buildConnections = (
  sent: Array<Sent>,
  behaviour: RunnerBehaviour,
): RunnerConnections["Service"] =>
  ({
    arrivals: Stream.empty,
    asked: (runnerId: string, request: ControllerToRunner) => {
      sent.push({ runnerId, request });
      if (request._tag !== "probeRequest") return Effect.succeed(Option.none());
      if (runnerId === behaviour.brokenRunnerId) {
        return Effect.die(new Error("the connection to the runner broke"));
      }
      return Effect.gen(function* () {
        const takenAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        const answer: RunnerToController = {
          _tag: "probeReport",
          requestId: request.requestId,
          providerAccountId: request.harnessAccount.providerAccountId,
          result: {
            ...SIGNED_IN,
            usage: request.readUsage
              ? [
                  {
                    kind: "window",
                    window: "weekly",
                    usedPercent: 60,
                    resetsAt: null,
                    hit: false,
                    takenAt,
                  },
                ]
              : null,
          },
        };
        return Option.some(answer);
      });
    },
  }) as unknown as RunnerConnections["Service"];

const NOW = "2026-10-31T12:00:00.000Z";

/** The time between ticks of the loop: its default. */
const LOOP_INTERVAL = Duration.minutes(1);

type Services =
  | AccountUsage
  | ProviderAccountProbing
  | ProviderAccountRunners
  | ProviderAccountService
  | PromotionState
  | Secrets
  | SqlClient.SqlClient;

/** A log line the controller wrote while a test ran. */
interface Logged {
  readonly level: string;
  readonly message: string;
}

/**
 * Runs `body` as the user, on a database with the Metered plugins booted, a
 * test clock set to `NOW`, and the fake runner connection and provider API.
 * `body` starts the loop itself, so it can arrange the world first.
 */
const run = <A, E>(
  sent: Array<Sent>,
  provider: ReturnType<typeof buildFakeProviderApi>,
  body: Effect.Effect<A, E, Services>,
  behaviour: RunnerBehaviour = { brokenRunnerId: undefined },
  logged: Array<Logged> = [],
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      yield* Effect.flatMap(PluginHost, (host) => host.boot(buildPlugins()));
      return yield* body;
    }).pipe(
      Effect.provide(
        ProviderAccountProbingLayer.pipe(
          Layer.provideMerge(ProviderAccountServiceLayer),
          Layer.provideMerge(ProviderKeyRequestsLayer),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, provider.client)),
          Layer.provideMerge(ProviderAccountProbesLayer),
          Layer.provideMerge(ModelCatalogsLayer),
          Layer.provideMerge(ProviderAccountRunnersLayer),
          Layer.provideMerge(inertMembership),
          Layer.provideMerge(Layer.succeed(LocalRunnerId, { read: () => undefined })),
          Layer.provideMerge(HarnessAccountsLayer),
          Layer.provideMerge(SettingsLayer),
          Layer.provideMerge(AccountUsageLayer),
          Layer.provideMerge(Layer.succeed(RunnerConnections)(buildConnections(sent, behaviour))),
          Layer.provideMerge(NotifierLayer),
          Layer.provideMerge(buildPluginStack()),
        ),
      ),
      Effect.provide(
        Logger.layer([
          Logger.make<unknown, void>(({ logLevel, message }) => {
            logged.push({ level: logLevel, message: String(message) });
          }),
        ]),
      ),
      Effect.provide(TestClock.layer()),
      asUser,
    ) as Effect.Effect<A, E, never>,
  );

/**
 * Starts the loop on its own fiber and waits for its first tick to end. The
 * returned `passMinutes(n)` moves the clock on one minute at a time and
 * waits, after each minute, for the tick that minute starts to end.
 *
 * A tick ends when the loop goes to sleep for its interval, so the loop's
 * clock tells the test when that happens. A read can wait on real I/O (the
 * body of the fake provider's answer), so waiting a number of scheduler turns
 * would be a race.
 */
const startLoop = Effect.gen(function* () {
  const tickEnds = yield* Queue.unbounded<void>();
  yield* TestClock.testClockWith((testClock) => {
    const observed: Clock.Clock = {
      ...testClock,
      sleep: (duration) => {
        if (Duration.toMillis(duration) === Duration.toMillis(LOOP_INTERVAL)) {
          Queue.offerUnsafe(tickEnds, undefined);
        }
        return testClock.sleep(duration);
      },
    };
    return Effect.forkChild(
      Effect.provideService(runAccountUsageReadingLoop, Clock.Clock, observed),
    );
  });
  yield* Queue.take(tickEnds);
  return {
    passMinutes: (minutes: number) =>
      Effect.forEach(
        Array.from({ length: minutes }),
        () => Effect.andThen(TestClock.adjust(Duration.minutes(1)), Queue.take(tickEnds)),
        { discard: true },
      ),
  };
});

/** Adds a Metered key account holding `key`. */
const addKeyAccount = (key = "sk-live") =>
  Effect.gen(function* () {
    const account = yield* addAccount({
      providerId: METERED_PROVIDER_ID,
      kind: METERED_KEY_KIND,
      label: key,
    });
    yield* storeCredential(account.id, "apiKey", key);
    return account;
  });

/** Adds a Metered subscription account, and a signed-in snapshot of it on the runner when given one. */
const addMachineAccount = (signedInOn?: string, label?: string) =>
  Effect.gen(function* () {
    const account = yield* addAccount({
      providerId: METERED_PROVIDER_ID,
      kind: MACHINE_KIND,
      ...(label === undefined ? {} : { label }),
    });
    if (signedInOn !== undefined) yield* addSnapshot(account.id, ALPHA_HARNESS_ID, signedInOn);
    return account;
  });

const probeRequestsIn = (sent: ReadonlyArray<Sent>) =>
  sent.flatMap((one) => (one.request._tag === "probeRequest" ? [one.request] : []));

const countNotifications = (kind: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM notifications WHERE kind = ${kind}`;
    return rows[0]?.count ?? 0;
  });

const answerWithUsage = () => new Response(JSON.stringify({ used: 40 }));

describe("the usage loop, for an account read with its key", () => {
  it("reads it at once, and again only when 15 minutes have passed", async () => {
    const sent: Array<Sent> = [];
    const provider = buildFakeProviderApi(answerWithUsage);

    const outcome = await run(
      sent,
      provider,
      Effect.gen(function* () {
        const usage = yield* AccountUsage;
        const account = yield* addKeyAccount();
        const loop = yield* startLoop;
        const afterStart = provider.requests.length;
        const stored = yield* usage.read(account.id);
        yield* loop.passMinutes(14);
        const afterFourteen = provider.requests.length;
        yield* loop.passMinutes(1);
        return { afterStart, stored, afterFourteen, afterFifteen: provider.requests.length };
      }),
    );

    expect(outcome.afterStart).toBe(1);
    expect(outcome.stored).toMatchObject([
      { window: "five-hour", usedPercent: 40, source: "read" },
    ]);
    expect(outcome.afterFourteen).toBe(1);
    expect(outcome.afterFifteen).toBe(2);
    expect(provider.requests[0]?.headers["authorization"]).toBe("sk-live");
  });

  it("leaves it alone while a session reported usage in the last 15 minutes", async () => {
    const sent: Array<Sent> = [];
    const provider = buildFakeProviderApi(answerWithUsage);

    const outcome = await run(
      sent,
      provider,
      Effect.gen(function* () {
        const usage = yield* AccountUsage;
        const account = yield* addKeyAccount();
        yield* usage.record(
          account.id,
          [
            {
              kind: "window",
              window: "five-hour",
              usedPercent: 10,
              resetsAt: null,
              hit: false,
              takenAt: NOW,
            },
          ],
          { source: "session", credentialSince: null },
        );
        const loop = yield* startLoop;
        yield* loop.passMinutes(14);
        const afterFourteen = provider.requests.length;
        yield* loop.passMinutes(1);
        return { afterFourteen, afterFifteen: provider.requests.length };
      }),
    );

    expect(outcome).toEqual({ afterFourteen: 0, afterFifteen: 1 });
  });
});

describe("the usage loop, for an account read through a probe", () => {
  it("probes it on a signed-in runner with readUsage, stores the readings, and probes again after 15 minutes", async () => {
    const sent: Array<Sent> = [];
    const provider = buildFakeProviderApi();

    const outcome = await run(
      sent,
      provider,
      Effect.gen(function* () {
        const usage = yield* AccountUsage;
        const runner = yield* addRunner("laptop");
        const account = yield* addMachineAccount(runner);
        const loop = yield* startLoop;
        const afterStart = probeRequestsIn(sent);
        const stored = yield* usage.read(account.id);
        yield* loop.passMinutes(14);
        const afterFourteen = probeRequestsIn(sent).length;
        yield* loop.passMinutes(1);
        return {
          runner,
          afterStart,
          stored,
          afterFourteen,
          afterFifteen: probeRequestsIn(sent).length,
        };
      }),
    );

    expect(outcome.afterStart).toMatchObject([{ harnessId: ALPHA_HARNESS_ID, readUsage: true }]);
    expect(sent[0]?.runnerId).toBe(outcome.runner);
    expect(outcome.stored).toMatchObject([{ window: "weekly", usedPercent: 60, source: "read" }]);
    expect(outcome.afterFourteen).toBe(1);
    expect(outcome.afterFifteen).toBe(2);
  });

  it("does nothing, and claims nothing, while no runner is connected", async () => {
    const sent: Array<Sent> = [];
    const provider = buildFakeProviderApi();

    const outcome = await run(
      sent,
      provider,
      Effect.gen(function* () {
        const account = yield* addMachineAccount();
        const loop = yield* startLoop;
        yield* loop.passMinutes(3);
        const whileAlone = sent.length;
        // A runner signs in. Had the earlier ticks claimed the read, this
        // probe would wait for the 15 minutes to pass.
        const runner = yield* addRunner("laptop");
        yield* addSnapshot(account.id, ALPHA_HARNESS_ID, runner);
        yield* loop.passMinutes(1);
        return { whileAlone, afterRunner: probeRequestsIn(sent).length };
      }),
    );

    expect(outcome).toEqual({ whileAlone: 0, afterRunner: 1 });
  });

  it("does nothing, and claims nothing, while the account is not signed in on a connected runner", async () => {
    const sent: Array<Sent> = [];
    const provider = buildFakeProviderApi();

    const outcome = await run(
      sent,
      provider,
      Effect.gen(function* () {
        const account = yield* addMachineAccount();
        const runner = yield* addRunner("laptop");
        const loop = yield* startLoop;
        yield* loop.passMinutes(3);
        const beforeSignIn = sent.length;
        yield* addSnapshot(account.id, ALPHA_HARNESS_ID, runner);
        yield* loop.passMinutes(1);
        return { beforeSignIn, afterSignIn: probeRequestsIn(sent).length };
      }),
    );

    expect(outcome).toEqual({ beforeSignIn: 0, afterSignIn: 1 });
  });
});

describe("the usage loop, for a runner that went offline", () => {
  it("does not probe on it, and claims nothing", async () => {
    const sent: Array<Sent> = [];
    const provider = buildFakeProviderApi();

    const outcome = await run(
      sent,
      provider,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const runner = yield* addRunner("laptop");
        yield* addMachineAccount(runner);
        yield* withTransaction(
          sql,
          sql`UPDATE runners SET connectivity = 'offline' WHERE id = ${uuidFromString(runner)}`,
        );
        const loop = yield* startLoop;
        yield* loop.passMinutes(3);
        const whileOffline = sent.length;
        yield* withTransaction(
          sql,
          sql`UPDATE runners SET connectivity = 'online' WHERE id = ${uuidFromString(runner)}`,
        );
        yield* loop.passMinutes(1);
        return { whileOffline, afterReturn: probeRequestsIn(sent).length };
      }),
    );

    expect(outcome).toEqual({ whileOffline: 0, afterReturn: 1 });
  });
});

describe("the usage loop, for an account whose usage only sessions report", () => {
  it("reads nothing", async () => {
    const sent: Array<Sent> = [];
    const provider = buildFakeProviderApi();

    await run(
      sent,
      provider,
      Effect.gen(function* () {
        const runner = yield* addRunner("laptop");
        const account = yield* addAccount({ providerId: METERED_PROVIDER_ID, kind: SESSIONS_KIND });
        yield* addSnapshot(account.id, ALPHA_HARNESS_ID, runner);
        const loop = yield* startLoop;
        yield* loop.passMinutes(20);
      }),
    );

    expect(sent).toEqual([]);
    expect(provider.requests).toEqual([]);
  });
});

describe("the usage loop", () => {
  it("warns about expiring credentials on every tick", async () => {
    const sent: Array<Sent> = [];
    const provider = buildFakeProviderApi();

    const outcome = await run(
      sent,
      provider,
      Effect.gen(function* () {
        const account = yield* addMachineAccount();
        const loop = yield* startLoop;
        const before = yield* countNotifications("core.account-expiring");
        // The credential starts to expire after the first tick.
        yield* setTokenExpiry(account.id, "2026-11-05T00:00:00.000Z");
        yield* loop.passMinutes(1);
        const afterNextTick = yield* countNotifications("core.account-expiring");
        yield* loop.passMinutes(3);
        return { before, afterNextTick, later: yield* countNotifications("core.account-expiring") };
      }),
    );

    expect(outcome).toEqual({ before: 0, afterNextTick: 1, later: 1 });
  });

  it("goes on with the other accounts and the next tick when one read fails, and logs the failure", async () => {
    const sent: Array<Sent> = [];
    const provider = buildFakeProviderApi();
    const logged: Array<Logged> = [];
    const behaviour: RunnerBehaviour = { brokenRunnerId: undefined };

    const outcome = await run(
      sent,
      provider,
      Effect.gen(function* () {
        const usage = yield* AccountUsage;
        const broken = yield* addRunner("broken");
        const working = yield* addRunner("working");
        behaviour.brokenRunnerId = broken;
        const failing = yield* addMachineAccount(broken, "broken");
        const fine = yield* addMachineAccount(working, "working");
        const loop = yield* startLoop;
        const stored = yield* usage.read(fine.id);
        // The 15 minutes after the failed read still count.
        yield* loop.passMinutes(5);
        return { failing: failing.id, stored, probes: probeRequestsIn(sent).length };
      }),
      behaviour,
      logged,
    );

    expect(outcome.stored).toMatchObject([{ window: "weekly", source: "read" }]);
    expect(outcome.probes).toBe(2);
    expect(
      logged.filter(
        (line) =>
          line.level === "Error" &&
          line.message.includes(`Reading the usage of provider account ${outcome.failing} failed`),
      ),
    ).toHaveLength(1);
  });
});
