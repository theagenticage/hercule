/**
 * Tests probing with a stand-in for the connection to the runners, so the
 * frames the controller sends can be read and answered one by one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Deferred, Duration, Effect, Fiber, Layer, Logger, Option, Redacted, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { ControllerToRunner, ProbeResult, RunnerToController } from "@hercule/protocol";
import { InvalidState } from "@hercule/contract";
import { CurrentActor, type Actor } from "../../actor";
import { AfterCommit, uuidFromString, withTransaction, type Change } from "../../db";
import { PluginHost } from "../../plugins";
import type { Plugin } from "@hercule/plugin-host";
import {
  asUser,
  buildHarnessDefinition,
  buildPluginStack,
  buildProviderDefinition,
  createPluginFixture,
} from "../../plugins/testing";
import {
  HarnessAccounts,
  HarnessAccountsLayer,
  ModelCatalogs,
  ModelCatalogsLayer,
  ProviderAccountProbes,
  ProviderAccountProbesLayer,
  ProviderAccountRunners,
  ProviderAccountRunnersLayer,
  providerAccountRepository,
} from "../../provider-accounts";
import {
  addAccount,
  addRunner,
  inertMembership,
  addSnapshot,
  ALPHA_HARNESS_ID,
  buildAccountPlugins,
  KEY_KIND,
  MACHINE_KIND,
  setTokenExpiry,
  SIGNED_IN,
  TOKEN_KIND,
} from "../../provider-accounts/testing";
import { LocalRunnerId, RunnerConnections } from "../../runners";
import { buildProviderAccountOwner, Secrets } from "../../secrets";
import { AccountUsage, AccountUsageLayer } from "../../usage";
import {
  ProviderAccountProbeInterval,
  ProviderAccountProbing,
  ProviderAccountProbingLayer,
} from "./probing";

interface Sent {
  readonly runnerId: string;
  readonly request: ControllerToRunner;
}

/** Counts the probe requests among the frames sent, which the login frames of a test are not part of. */
const probeRequestsIn = (sent: ReadonlyArray<Sent>): number =>
  sent.filter((one) => one.request._tag === "probeRequest").length;

/** Runs before a probe is answered, so a test can change the world while a runner is "thinking". */
const beforeAnswer: { current: Effect.Effect<void> } = { current: Effect.void };

/**
 * Decides what the runner answers to a probe, given how many probe requests
 * were sent before it (0 for the first). The default is `SIGNED_IN` at once.
 */
const probeResult: { current: (index: number) => Effect.Effect<ProbeResult> } = {
  current: () => Effect.succeed(SIGNED_IN),
};

/** Makes the runner stay silent to probes, as one does that is unplugged or hung. */
const silentProbes: { current: boolean } = { current: false };

/** Decides what the runner answers to a `loginStart`. The default prints a URL and a device code. */
const loginStartAnswer: {
  current: (requestId: string) => RunnerToController;
} = {
  current: (requestId) => ({
    _tag: "loginUrl",
    requestId,
    url: "https://example.test/login",
    userCode: "ABCD-1234",
  }),
};

/** A connection that records every frame and answers each probe as `probeResult` says. */
const buildFakeConnections = (sent: Array<Sent>): RunnerConnections["Service"] =>
  ({
    arrivals: Stream.empty,
    asked: (runnerId: string, request: ControllerToRunner) => {
      sent.push({ runnerId, request });
      if (request._tag === "loginStart") {
        return Effect.succeed(Option.some(loginStartAnswer.current(request.requestId)));
      }
      if (request._tag !== "probeRequest") return Effect.succeed(Option.none());
      if (silentProbes.current) return Effect.succeed(Option.none());
      const index = probeRequestsIn(sent) - 1;
      return Effect.gen(function* () {
        yield* beforeAnswer.current;
        const answer: RunnerToController = {
          _tag: "probeReport",
          requestId: request.requestId,
          providerAccountId: request.harnessAccount.providerAccountId,
          result: yield* probeResult.current(index),
        };
        return Option.some(answer);
      });
    },
  }) as unknown as RunnerConnections["Service"];

const MULTI_PROVIDER_ID = "multi/multi";
const ONE_HARNESS_ID = "one/one";
const TWO_HARNESS_ID = "two/two";

/** A harness this build pins a minimum version for, which the fixture harnesses are not. */
const FLOORED_HARNESS_ID = "codex/codex";
const FLOORED_PROVIDER_ID = "floored/floored";

/**
 * A provider with a key kind that two harnesses run, so an account can run in
 * more than its default harness (the fixture provider's account runs in one).
 */
const buildMultiHarnessPlugins = (): ReadonlyArray<Plugin> => [
  createPluginFixture({
    id: "multi",
    capabilities: ["providers"],
    definitions: [],
    providers: [buildProviderDefinition("multi", [ONE_HARNESS_ID, TWO_HARNESS_ID])],
  }).plugin,
  createPluginFixture({
    id: "floored",
    capabilities: ["providers"],
    definitions: [],
    providers: [buildProviderDefinition("floored", [FLOORED_HARNESS_ID])],
  }).plugin,
  createPluginFixture({
    id: "codex",
    definitions: [
      buildHarnessDefinition("codex", [
        {
          providerId: FLOORED_PROVIDER_ID,
          kinds: [
            { kind: "api-key", modelArgument: "{model}", credentialVariable: "FLOORED_API_KEY" },
          ],
          models: "own-list",
        },
      ]),
    ],
  }).plugin,
  ...["one", "two"].map(
    (id) =>
      createPluginFixture({
        id,
        definitions: [
          buildHarnessDefinition(id, [
            {
              providerId: MULTI_PROVIDER_ID,
              kinds: [
                { kind: "api-key", modelArgument: "{model}", credentialVariable: "MULTI_API_KEY" },
              ],
              models: "own-list",
            },
          ]),
        ],
      }).plugin,
  ),
];

/** A log line the controller wrote while a test ran. */
interface Logged {
  readonly level: string;
  readonly message: string;
}

const run = <A, E>(
  sent: Array<Sent>,
  body: Effect.Effect<
    A,
    E,
    | HarnessAccounts
    | ProviderAccountProbing
    | ProviderAccountProbes
    | ProviderAccountRunners
    | AccountUsage
    | ModelCatalogs
    | SqlClient.SqlClient
    | Secrets
  >,
  logged: Array<Logged> = [],
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(PluginHost, (host) =>
        host.boot([...buildAccountPlugins(), ...buildMultiHarnessPlugins()]),
      );
      return yield* body;
    }).pipe(
      Effect.provide(
        ProviderAccountProbingLayer.pipe(
          Layer.provideMerge(ProviderAccountProbesLayer),
          Layer.provideMerge(ModelCatalogsLayer),
          Layer.provideMerge(ProviderAccountRunnersLayer),
          Layer.provideMerge(inertMembership),
          Layer.provideMerge(Layer.succeed(LocalRunnerId, { read: () => undefined })),
          Layer.provideMerge(HarnessAccountsLayer),
          Layer.provideMerge(Layer.succeed(RunnerConnections)(buildFakeConnections(sent))),
          Layer.provideMerge(AccountUsageLayer),
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
      asUser,
    ) as Effect.Effect<A, E, never>,
  );

/** Stores the key of an account whose kind holds one, as a completed setup does. */
const storeKey = (accountId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const secrets = yield* Secrets;
    yield* withTransaction(
      sql,
      secrets.set(buildProviderAccountOwner(accountId), "apiKey", Redacted.make("sk-secret")),
    );
  });

/** Inserts an Acme account of the key kind together with its key. */
const addKeyAccount = (label: string | null = null) =>
  Effect.gen(function* () {
    const account = yield* addAccount({ kind: KEY_KIND, label });
    yield* storeKey(account.id);
    return account;
  });

/** A user actor with a name of its own, so a test can tell which one a login ran as. */
const userNamed = (userId: string): Actor => ({
  _tag: "user",
  userId,
  credential: { kind: "login", id: userId, tokenHash: "x" },
});

/**
 * Starts a device login on the runner as the current actor, through
 * `startLogin`, and returns the request id the controller gave it, which is
 * what the runner reports when the login ends.
 */
const startDeviceLogin = (
  sent: Array<Sent>,
  runnerId: string,
  providerAccountId: string,
  onSignedIn: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const probes = yield* ProviderAccountProbing;
    const harnessAccounts = yield* HarnessAccounts;
    yield* probes.startLogin(
      runnerId,
      providerAccountId,
      {
        harnessId: ALPHA_HARNESS_ID,
        harnessAccount: yield* harnessAccounts.prepareSignIn(providerAccountId, ALPHA_HARNESS_ID),
        method: "sign-in",
      },
      Duration.seconds(5),
      onSignedIn,
    );
    const frame = sent.findLast((one) => one.request._tag === "loginStart")?.request;
    if (frame?._tag !== "loginStart") throw new Error("no loginStart was sent");
    return frame.requestId;
  });

const listSnapshots = (accountId: string) =>
  Effect.flatMap(providerAccountRepository, (accounts) => accounts.listSnapshots(accountId));

const readAccountCatalog = (accountId: string) =>
  Effect.flatMap(ModelCatalogs, (catalogs) => catalogs.read(accountId));

describe("a probe", () => {
  it("sends the account's home, model argument and decrypted key, and stores the snapshot under the harness", async () => {
    const sent: Array<Sent> = [];

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const secrets = yield* Secrets;
        const probes = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: KEY_KIND });
        yield* withTransaction(
          sql,
          secrets.set(buildProviderAccountOwner(account.id), "apiKey", Redacted.make("sk-secret")),
        );
        const runner = yield* addRunner("laptop");

        const snapshot = yield* probes.probe(runner, account.id, ALPHA_HARNESS_ID);

        return { account, runner, snapshot, stored: yield* listSnapshots(account.id) };
      }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.runnerId).toBe(outcome.runner);
    expect(sent[0]?.request).toMatchObject({
      _tag: "probeRequest",
      harnessId: ALPHA_HARNESS_ID,
      harnessAccount: {
        providerAccountId: outcome.account.id,
        harnessHome: `providers/homes/${outcome.account.id}/alpha/alpha`,
        modelArgument: "acme/{model}",
        credential: { variable: "ACME_API_KEY", value: "sk-secret" },
      },
    });
    expect(outcome.snapshot).toMatchObject({
      _tag: "stored",
      snapshot: { runnerId: outcome.runner, harnessId: ALPHA_HARNESS_ID, auth: { status: "ok" } },
    });
    expect(outcome.stored).toHaveLength(1);
    expect(outcome.stored[0]).toMatchObject({
      providerAccountId: outcome.account.id,
      harnessId: ALPHA_HARNESS_ID,
      runnerId: outcome.runner,
    });
  });

  it("fails InvalidState and sends nothing when the account cannot run in the harness", async () => {
    const sent: Array<Sent> = [];

    const failure = await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        return yield* Effect.flip(probes.probe(runner, account.id, "beta/beta"));
      }),
    );

    expect(failure).toMatchObject({ error: { code: "invalid_state" } });
    expect(probeRequestsIn(sent)).toBe(0);
  });

  it("fails NotFound for an account that does not exist", async () => {
    const failure = await run(
      [],
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const runner = yield* addRunner("laptop");
        return yield* Effect.flip(
          probes.probe(runner, "0199e0e7-9999-7000-8000-000000000000", ALPHA_HARNESS_ID),
        );
      }),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });
});

/** A usage reading a runner returns with a probe: 40 percent of the five-hour window used. */
const FIVE_HOUR_READING = {
  kind: "window" as const,
  window: "five-hour" as const,
  usedPercent: 40,
  resetsAt: null,
  hit: false,
  takenAt: new Date().toISOString(),
};

describe("a probe that reads usage", () => {
  afterEach(() => {
    probeResult.current = () => Effect.succeed(SIGNED_IN);
  });

  it("asks the runner for usage, and stores the readings of the answer as read", async () => {
    const sent: Array<Sent> = [];
    probeResult.current = () => Effect.succeed({ ...SIGNED_IN, usage: [FIVE_HOUR_READING] });

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const usage = yield* AccountUsage;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");

        const claimed = yield* probing.readUsageByProbe(runner, account.id, ALPHA_HARNESS_ID);
        return { claimed, readings: yield* usage.read(account.id) };
      }),
    );

    expect(outcome.claimed).toBe(true);
    expect(sent.map((one) => one.request)).toMatchObject([
      { _tag: "probeRequest", readUsage: true },
    ]);
    expect(outcome.readings).toMatchObject([
      { window: "five-hour", usedPercent: 40, source: "read" },
    ]);
  });

  it("sends nothing when the 15 minutes since the last read have not passed", async () => {
    const sent: Array<Sent> = [];

    const claims = await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");

        return [
          yield* probing.readUsageByProbe(runner, account.id, ALPHA_HARNESS_ID),
          yield* probing.readUsageByProbe(runner, account.id, ALPHA_HARNESS_ID),
        ];
      }),
    );

    expect(claims).toEqual([true, false]);
    expect(probeRequestsIn(sent)).toBe(1);
  });

  it("does not ask for usage in any other probe", async () => {
    const sent: Array<Sent> = [];

    await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");

        yield* probing.probe(runner, account.id, ALPHA_HARNESS_ID);
        yield* probing.sweepProviderAccount(account.id);
      }),
    );

    expect(sent.length).toBeGreaterThan(1);
    expect(sent.map((one) => one.request)).toSatisfy(
      (requests: ReadonlyArray<ControllerToRunner>) =>
        requests.every((request) => request._tag === "probeRequest" && !request.readUsage),
    );
  });

  it("stores no readings from a probe that did not ask for usage, even when the runner returns some", async () => {
    probeResult.current = () => Effect.succeed({ ...SIGNED_IN, usage: [FIVE_HOUR_READING] });

    const readings = await run(
      [],
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const usage = yield* AccountUsage;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");

        const outcome = yield* probing.probe(runner, account.id, ALPHA_HARNESS_ID);
        return { stored: outcome._tag, readings: yield* usage.read(account.id) };
      }),
    );

    expect(readings).toEqual({ stored: "stored", readings: [] });
  });

  it("stores no readings from an answer that was superseded", async () => {
    const sent: Array<Sent> = [];

    const readings = await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const usage = yield* AccountUsage;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        const gate = yield* Deferred.make<void>();
        // The first probe is answered last, with a reading, after the second
        // probe's snapshot was stored.
        probeResult.current = (index) =>
          index === 0
            ? Effect.as(Deferred.await(gate), { ...SIGNED_IN, usage: [FIVE_HOUR_READING] })
            : Effect.succeed(SIGNED_IN);

        const older = yield* Effect.forkChild(probing.probe(runner, account.id, ALPHA_HARNESS_ID));
        yield* Effect.sleep(Duration.millis(10));
        yield* probing.probe(runner, account.id, ALPHA_HARNESS_ID);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(older);
        return yield* usage.read(account.id);
      }),
    );

    expect(readings).toEqual([]);
  });

  it("stores no readings from an answer for a person other than the account's", async () => {
    const sent: Array<Sent> = [];
    probeResult.current = () =>
      Effect.succeed({
        ...SIGNED_IN,
        auth: { status: "ok" as const, identity: "someone-else@example.com" },
        usage: [FIVE_HOUR_READING],
      });

    const readings = await run(
      sent,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const probing = yield* ProviderAccountProbing;
        const usage = yield* AccountUsage;
        const accounts = yield* providerAccountRepository;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        yield* withTransaction(
          sql,
          accounts.setIdentityIfUnset(
            account.id,
            "someone@example.com",
            undefined,
            "2026-10-31T00:00:00.000Z",
          ),
        );
        const runner = yield* addRunner("laptop");

        yield* probing.probe(runner, account.id, ALPHA_HARNESS_ID);
        return yield* usage.read(account.id);
      }),
    );

    expect(readings).toEqual([]);
  });
});

describe("two probes of one pair in flight together", () => {
  afterEach(() => {
    probeResult.current = () => Effect.succeed(SIGNED_IN);
  });

  it("keeps the newer probe's snapshot, and reports the older probe as superseded, when the older probe's answer arrives last", async () => {
    const sent: Array<Sent> = [];

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        const gate = yield* Deferred.make<void>();
        // The first probe is sent first and answered last, saying the account
        // is signed out; the second says it is signed in.
        probeResult.current = (index) =>
          index === 0
            ? Effect.as(Deferred.await(gate), {
                ...SIGNED_IN,
                auth: { status: "unauthenticated" as const },
              })
            : Effect.succeed(SIGNED_IN);

        const older = yield* Effect.forkChild(probes.probe(runner, account.id, ALPHA_HARNESS_ID));
        yield* Effect.sleep(Duration.millis(10));
        yield* probes.probe(runner, account.id, ALPHA_HARNESS_ID);
        yield* Deferred.succeed(gate, undefined);
        const olderAnswer = yield* Fiber.join(older);
        return { olderAnswer, stored: yield* listSnapshots(account.id) };
      }),
    );

    expect(outcome.stored).toHaveLength(1);
    expect(outcome.stored[0]?.auth.status).toBe("ok");
    expect(outcome.olderAnswer).toEqual({ _tag: "superseded" });
  });
});

describe("a probe that checks a sign-in", () => {
  afterEach(() => {
    probeResult.current = () => Effect.succeed(SIGNED_IN);
  });

  /** Makes the first `count` probes answer after the account's credential generation advanced. */
  const supersedeFirstProbes = (count: number, advance: Effect.Effect<void, unknown>): void => {
    probeResult.current = (index) =>
      index < count ? Effect.as(Effect.orDie(advance), SIGNED_IN) : Effect.succeed(SIGNED_IN);
  };

  it("probes once more when the first answer is superseded, and answers with the second snapshot", async () => {
    const sent: Array<Sent> = [];

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const domain = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        supersedeFirstProbes(
          1,
          domain.acceptDeviceSignIn(
            account.id,
            "0199e0e7-9999-7000-8000-000000000001",
            ALPHA_HARNESS_ID,
          ),
        );
        return yield* probing.probeToCheckSignIn(runner, account.id, ALPHA_HARNESS_ID);
      }),
    );

    expect(Option.getOrThrow(outcome).auth.status).toBe("ok");
    expect(sent.filter((one) => one.request._tag === "probeRequest")).toHaveLength(2);
  });

  it("fails InvalidState, and stores no snapshot, when the account changes during both probes", async () => {
    const sent: Array<Sent> = [];

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const domain = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        supersedeFirstProbes(
          2,
          domain.acceptDeviceSignIn(
            account.id,
            "0199e0e7-9999-7000-8000-000000000001",
            ALPHA_HARNESS_ID,
          ),
        );
        const failure = yield* Effect.flip(
          probing.probeToCheckSignIn(runner, account.id, ALPHA_HARNESS_ID),
        );
        return { failure, stored: yield* listSnapshots(account.id) };
      }),
    );

    expect(outcome.failure).toMatchObject({
      error: {
        code: "invalid_state",
        message: "The account changed while this sign-in was checked. Sign in again.",
      },
    });
    expect(outcome.stored).toEqual([]);
    expect(sent.filter((one) => one.request._tag === "probeRequest")).toHaveLength(2);
  });
});

describe("a sweep", () => {
  afterEach(() => {
    probeResult.current = () => Effect.succeed(SIGNED_IN);
  });

  it("probes each account on every connected runner", async () => {
    const sent: Array<Sent> = [];

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const first = yield* addAccount({ kind: MACHINE_KIND });
        const second = yield* addKeyAccount("work");
        const runner = yield* addRunner("laptop");
        yield* probes.sweepRunner(runner);
        return { first, second };
      }),
    );

    expect(
      sent
        .map((one) =>
          one.request._tag === "probeRequest" ? one.request.harnessAccount.providerAccountId : "",
        )
        .toSorted(),
      // Each account is probed, and then its catalog is read with a probe of
      // its own, also the sign-in account, which the first probe found signed in.
    ).toEqual(
      [outcome.first.id, outcome.second.id, outcome.first.id, outcome.second.id].toSorted(),
    );
    expect(
      sent.every((one) => (one.request as { harnessId?: string }).harnessId === ALPHA_HARNESS_ID),
    ).toBe(true);
  });

  it("probes an account in every harness it can run in that the runner has, not only its default", async () => {
    const sent: Array<Sent> = [];

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const account = yield* addAccount({
          providerId: MULTI_PROVIDER_ID,
          kind: KEY_KIND,
          defaultHarnessId: ONE_HARNESS_ID,
        });
        yield* storeKey(account.id);
        const both = yield* addRunner("both", { adapters: [ONE_HARNESS_ID, TWO_HARNESS_ID] });
        const onlyTwo = yield* addRunner("only-two", { adapters: [TWO_HARNESS_ID] });
        yield* Effect.forEach([both, onlyTwo], probes.sweepRunner, { discard: true });
        return { both, onlyTwo };
      }),
    );

    expect(
      sent
        .map((one) => `${one.runnerId}:${(one.request as { harnessId: string }).harnessId}`)
        .toSorted(),
    ).toEqual(
      [
        `${outcome.both}:${ONE_HARNESS_ID}`,
        `${outcome.both}:${TWO_HARNESS_ID}`,
        `${outcome.onlyTwo}:${TWO_HARNESS_ID}`,
        // The catalog read, in the provider's source harness on the first runner.
        `${outcome.both}:${ONE_HARNESS_ID}`,
      ].toSorted(),
    );
  });

  it("skips an account whose kind holds a key when no key is stored", async () => {
    const sent: Array<Sent> = [];

    await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        yield* addAccount({ kind: KEY_KIND });
        const runner = yield* addRunner("laptop");
        yield* probes.sweepRunner(runner);
      }),
    );

    expect(probeRequestsIn(sent)).toBe(0);
  });

  it("sends nothing to a runner whose facts show no adapter for the harness, or no binary", async () => {
    const sent: Array<Sent> = [];

    const ready = await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        yield* addKeyAccount();
        const ready = yield* addRunner("ready");
        const noAdapter = yield* addRunner("no-adapter", { adapters: [] });
        const noBinary = yield* addRunner("no-binary", { binaryPresent: false });
        yield* Effect.forEach([ready, noAdapter, noBinary], probes.sweepRunner, { discard: true });
        return ready;
      }),
    );

    // The probe of the pair, and the catalog read.
    expect(sent.map((one) => one.runnerId)).toEqual([ready, ready]);
  });

  it("sends a runner at most two probes at once, however many pairs it has", async () => {
    const sent: Array<Sent> = [];
    const gate = Effect.runSync(Deferred.make<void>());
    probeResult.current = () => Effect.as(Deferred.await(gate), SIGNED_IN);

    const inFlight = await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        for (const label of ["a", "b", "c", "d", "e"]) yield* addKeyAccount(label);
        const first = yield* addRunner("first");
        const second = yield* addRunner("second");
        const sweeps = yield* Effect.forkChild(
          Effect.forEach([first, second], probes.sweepRunner, {
            concurrency: "unbounded",
            discard: true,
          }),
        );
        // Nothing answers yet, so every probe the controller sent is still in flight.
        yield* Effect.sleep(Duration.millis(100));
        const counts = [first, second].map(
          (runnerId) => sent.filter((one) => one.runnerId === runnerId).length,
        );
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(sweeps);
        return counts;
      }),
    );

    expect(inFlight).toEqual([2, 2]);
    // The ten probes of the pairs, and the catalog reads that follow them.
    expect(sent.length).toBeGreaterThanOrEqual(10);
  });

  it("counts the probes in flight on a runner across sweeps, not per sweep", async () => {
    const sent: Array<Sent> = [];
    const gate = Effect.runSync(Deferred.make<void>());
    probeResult.current = () => Effect.as(Deferred.await(gate), SIGNED_IN);

    const inFlight = await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const accounts = [];
        for (const label of ["a", "b", "c", "d"]) accounts.push(yield* addKeyAccount(label));
        const runner = yield* addRunner("laptop");
        // A facts change sweeps the runner while an account's new key sweeps the account.
        const sweeps = yield* Effect.forkChild(
          Effect.all(
            [
              probes.sweepRunner(runner),
              ...accounts.map((account) => probes.sweepProviderAccount(account.id)),
            ],
            { concurrency: "unbounded", discard: true },
          ),
        );
        yield* Effect.sleep(Duration.millis(100));
        const count = sent.length;
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(sweeps);
        return count;
      }),
    );

    expect(inFlight).toBe(2);
    // The eight probes of the pairs, and the catalog reads that follow them.
    expect(sent.length).toBeGreaterThanOrEqual(8);
  });

  it("probes a harness that was below its minimum version, so an upgrade is seen and the account can run there again", async () => {
    const sent: Array<Sent> = [];
    probeResult.current = () => Effect.succeed({ ...SIGNED_IN, harnessVersion: "999.0.0" });

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const runners = yield* ProviderAccountRunners;
        const account = yield* addAccount({
          providerId: FLOORED_PROVIDER_ID,
          kind: KEY_KIND,
          defaultHarnessId: FLOORED_HARNESS_ID,
        });
        yield* storeKey(account.id);
        const runner = yield* addRunner("laptop", { adapters: [FLOORED_HARNESS_ID] });
        // The last probe found the harness too old; the user has upgraded it since.
        yield* addSnapshot(account.id, FLOORED_HARNESS_ID, runner, {
          ...SIGNED_IN,
          harnessVersion: "0.0.1",
        });
        const before = yield* runners.list(account.id, FLOORED_HARNESS_ID);
        yield* probes.sweepRunner(runner);
        const after = yield* runners.list(account.id, FLOORED_HARNESS_ID);
        return { runner, before, after };
      }),
    );

    expect(outcome.before.runnerIds).toEqual([]);
    // The sweep's probe, then the catalog read the upgrade made possible.
    expect(sent.map((one) => one.runnerId)).toEqual([outcome.runner, outcome.runner]);
    expect(outcome.after.runnerIds).toEqual([outcome.runner]);
  });

  it("probes one account on every connected runner after its credential changed", async () => {
    const sent: Array<Sent> = [];

    await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const account = yield* addKeyAccount();
        yield* addKeyAccount("other");
        yield* addRunner("laptop");
        yield* addRunner("desktop");
        yield* probes.sweepProviderAccount(account.id);
        return account;
      }),
    );

    // One probe per runner, then the catalog read.
    expect(sent).toHaveLength(3);
  });
});

describe("an account deleted while a probe was in flight", () => {
  /** Deletes the account the moment the runner is about to answer, like a user racing the probe. */
  const deleteWhenAnswering = (accountId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      beforeAnswer.current = withTransaction(
        sql,
        sql`DELETE FROM provider_accounts WHERE id = ${uuidFromString(accountId)}`,
      ).pipe(Effect.orDie);
    });

  afterEach(() => {
    beforeAnswer.current = Effect.void;
  });

  it("is logged at info, not error, when a sweep's probe finds it gone", async () => {
    const logged: Array<Logged> = [];

    const stored = await run(
      [],
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        yield* deleteWhenAnswering(account.id);
        yield* probes.sweepRunner(runner);
        return yield* listSnapshots(account.id);
      }),
      logged,
    );

    expect(stored).toEqual([]);
    expect(logged.filter((line) => line.level === "Error")).toEqual([]);
    expect(logged.filter((line) => line.level === "Info").map((line) => line.message)).toEqual([
      expect.stringContaining("deleted meanwhile") as unknown,
    ]);
  });

  it("is logged at info, not error, when the probe after a sign-in ended finds it gone", async () => {
    const logged: Array<Logged> = [];

    const sent: Array<Sent> = [];

    await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        const loginId = yield* startDeviceLogin(sent, runner, account.id);
        yield* deleteWhenAnswering(account.id);
        // Fails with nothing: the end of a login is reported by a runner, and nobody awaits this call.
        yield* probes.probeAfterLoginEnd(runner, loginId);
      }),
      logged,
    );

    expect(logged.filter((line) => line.level === "Error")).toEqual([]);
    expect(logged.map((line) => line.message).join("\n")).toContain("deleted meanwhile");
  });
});

describe("the probe after a sign-in ended", () => {
  afterEach(() => {
    beforeAnswer.current = Effect.void;
    loginStartAnswer.current = (requestId) => ({
      _tag: "loginUrl",
      requestId,
      url: "https://example.test/login",
      userCode: "ABCD-1234",
    });
  });

  it("probes the account in the login's harness on the login's runner once, then reads its catalog with a probe of its own", async () => {
    const sent: Array<Sent> = [];

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        const loginId = yield* startDeviceLogin(sent, runner, account.id);

        yield* probes.probeAfterLoginEnd(runner, loginId);
        // The same end reported twice is ignored the second time.
        yield* probes.probeAfterLoginEnd(runner, loginId);

        return {
          account,
          runner,
          stored: yield* listSnapshots(account.id),
          catalog: yield* readAccountCatalog(account.id),
        };
      }),
    );

    // The end reported twice caused one probe to check the login, and the
    // signed-in account's catalog read is a second one.
    const probeRequests = sent.filter((one) => one.request._tag === "probeRequest");
    expect(probeRequests).toHaveLength(2);
    for (const request of probeRequests) {
      expect(request).toMatchObject({
        runnerId: outcome.runner,
        request: { _tag: "probeRequest", harnessId: ALPHA_HARNESS_ID },
      });
    }
    expect(outcome.stored.map((snapshot) => snapshot.harnessId)).toEqual([ALPHA_HARNESS_ID]);
    expect(outcome.catalog.models.map((one) => one.slug)).toEqual(["model-1"]);
  });

  it("completes a probe repeated for a login that ended meanwhile as that later login", async () => {
    const sent: Array<Sent> = [];
    const signedInAs: Array<string> = [];
    const answerFirstProbe = Effect.runSync(Deferred.make<void>());
    beforeAnswer.current = Effect.suspend(() =>
      probeRequestsIn(sent) === 1 ? Deferred.await(answerFirstProbe) : Effect.void,
    );

    await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        // A newer printed login ends the older one's wait, so the second login
        // starts only after the first ended and its probe is running.
        const startLoginAs = (userId: string) =>
          startDeviceLogin(
            sent,
            runner,
            account.id,
            Effect.flatMap(CurrentActor, (actor) =>
              Effect.sync(() => void signedInAs.push(actor._tag === "user" ? actor.userId : "")),
            ),
          ).pipe(Effect.provideService(CurrentActor, userNamed(userId)));

        const firstLogin = yield* startLoginAs("user-a");
        const first = yield* Effect.forkChild(probes.probeAfterLoginEnd(runner, firstLogin));
        while (!sent.some((one) => one.request._tag === "probeRequest")) {
          yield* Effect.sleep(Duration.millis(1));
        }
        const secondLogin = yield* startLoginAs("user-b");
        yield* probes.probeAfterLoginEnd(runner, secondLogin);
        yield* Deferred.succeed(answerFirstProbe, undefined);
        yield* Fiber.join(first);
      }),
    );

    // Two sign-in checks, then the catalog read.
    expect(probeRequestsIn(sent)).toBe(3);
    expect(signedInAs).toEqual(["user-b"]);
  });

  it("ignores an end that no login was waiting for", async () => {
    const sent: Array<Sent> = [];

    await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const runner = yield* addRunner("laptop");
        yield* probes.probeAfterLoginEnd(runner, "never-started");
      }),
    );

    expect(probeRequestsIn(sent)).toBe(0);
  });

  it("ignores an end reported by another runner than the one the login ran on", async () => {
    const sent: Array<Sent> = [];

    await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        const other = yield* addRunner("desktop");
        const loginId = yield* startDeviceLogin(sent, runner, account.id);
        yield* probes.probeAfterLoginEnd(other, loginId);
      }),
    );

    expect(probeRequestsIn(sent)).toBe(0);
  });

  it("ignores the end of a login the runner refused to start", async () => {
    const sent: Array<Sent> = [];
    loginStartAnswer.current = (requestId) => ({
      _tag: "loginFailed",
      requestId,
      message: "no login in progress",
    });

    await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        const failure = yield* Effect.flip(startDeviceLogin(sent, runner, account.id));
        expect(failure).toBeInstanceOf(InvalidState);
        const loginId = sent.findLast((one) => one.request._tag === "loginStart")?.request;
        yield* probes.probeAfterLoginEnd(
          runner,
          loginId?._tag === "loginStart" ? loginId.requestId : "",
        );
      }),
    );

    expect(probeRequestsIn(sent)).toBe(0);
  });

  it("ignores the end of a login finished by pasting a code, which reports none", async () => {
    const sent: Array<Sent> = [];
    loginStartAnswer.current = (requestId) => ({
      _tag: "loginUrl",
      requestId,
      url: "https://example.test/login",
    });

    await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        const loginId = yield* startDeviceLogin(sent, runner, account.id);
        yield* probes.probeAfterLoginEnd(runner, loginId);
      }),
    );

    expect(probeRequestsIn(sent)).toBe(0);
  });
});

describe("a catalog read in a sweep", () => {
  afterEach(() => {
    silentProbes.current = false;
    probeResult.current = () => Effect.succeed(SIGNED_IN);
  });

  it("is a probe of its own after the sweep's probes: a never-read key account is probed twice and its catalog is stored", async () => {
    const sent: Array<Sent> = [];

    const catalog = await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        yield* probing.sweepRunner(runner);
        return yield* readAccountCatalog(account.id);
      }),
    );

    expect(probeRequestsIn(sent)).toBe(2);
    expect(catalog.models.map((one) => one.slug)).toEqual(["model-1"]);
    expect(catalog.readAt).not.toBeNull();
  });

  it("is not repeated by a later sweep while the catalog is fresh, but is by a forced sweep of the account", async () => {
    const sent: Array<Sent> = [];

    const reads = await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        yield* probing.sweepRunner(runner);
        const first = yield* readAccountCatalog(account.id);
        yield* Effect.sleep(Duration.millis(5));
        probeResult.current = () =>
          Effect.succeed({ ...SIGNED_IN, models: [{ ...SIGNED_IN.models[0]!, slug: "model-2" }] });
        yield* probing.sweepFleet();
        const afterSweep = yield* readAccountCatalog(account.id);
        yield* probing.sweepProviderAccount(account.id);
        return { first, afterSweep, afterForced: yield* readAccountCatalog(account.id) };
      }),
    );

    expect(reads.afterSweep).toEqual(reads.first);
    expect(reads.afterForced.models.map((one) => one.slug)).toEqual(["model-2"]);
    expect(reads.afterForced.readAt).not.toBe(reads.first.readAt);
  });

  it("reads the catalog of a per-machine account after the sweep found it signed in", async () => {
    const sent: Array<Sent> = [];

    const catalog = await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        yield* probing.sweepRunner(runner);
        return yield* readAccountCatalog(account.id);
      }),
    );

    // The sweep's probe found the account signed in, and a second probe is the read.
    expect(probeRequestsIn(sent)).toBe(2);
    expect(catalog.models.map((one) => one.slug)).toEqual(["model-1"]);
    expect(catalog.error).toBeNull();
  });

  it("records what to do for an account that no machine has signed in", async () => {
    const sent: Array<Sent> = [];

    const catalog = await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        // A runner with the harness, but the account is signed in nowhere.
        yield* addRunner("laptop");
        probeResult.current = () =>
          Effect.succeed({ ...SIGNED_IN, auth: { status: "unauthenticated" } });
        yield* probing.sweepProviderAccount(account.id);
        return yield* readAccountCatalog(account.id);
      }),
    );

    // Only the sweep's own probe, which found the account signed out.
    expect(probeRequestsIn(sent)).toBe(1);
    expect(catalog.error).toContain("not signed in on any connected machine");
  });

  it("keeps the models and records an error when the runner does not answer the read", async () => {
    const sent: Array<Sent> = [];

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const account = yield* addKeyAccount();
        yield* addRunner("laptop");
        yield* probing.sweepProviderAccount(account.id);
        const good = yield* readAccountCatalog(account.id);
        silentProbes.current = true;
        yield* probing.sweepProviderAccount(account.id);
        return { good, after: yield* readAccountCatalog(account.id) };
      }),
    );

    expect(outcome.after.models).toEqual(outcome.good.models);
    expect(outcome.after.readAt).toBe(outcome.good.readAt);
    expect(outcome.after.error).toContain("did not answer");
  });
  it("records why the models cannot be listed when the stored key does not decrypt, and sends nothing", async () => {
    const sent: Array<Sent> = [];

    const catalog = await run(
      sent,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const probing = yield* ProviderAccountProbing;
        const account = yield* addKeyAccount();
        yield* addRunner("laptop");
        yield* withTransaction(
          sql,
          sql`UPDATE secrets SET ciphertext = randomblob(length(ciphertext))`,
        );
        yield* probing.readCatalog(account.id);
        return yield* readAccountCatalog(account.id);
      }),
    );

    expect(sent).toEqual([]);
    expect(catalog.models).toEqual([]);
    expect(catalog.error).toContain("could not be decrypted");
  });

  it("sends one read at a time per account: a forced read waits for the one in flight, and forced reads that wait together are one", async () => {
    const sent: Array<Sent> = [];
    const answerFirstProbe = Effect.runSync(Deferred.make<void>());
    beforeAnswer.current = Effect.suspend(() =>
      probeRequestsIn(sent) === 1 ? Deferred.await(answerFirstProbe) : Effect.void,
    );

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const account = yield* addKeyAccount();
        yield* addRunner("laptop");
        const reads = [yield* Effect.forkChild(probing.readCatalog(account.id))];
        while (probeRequestsIn(sent) < 1) yield* Effect.sleep(Duration.millis(1));
        // Two more forced reads while the first is out: neither is sent yet.
        reads.push(yield* Effect.forkChild(probing.readCatalog(account.id)));
        reads.push(yield* Effect.forkChild(probing.readCatalog(account.id)));
        yield* Effect.sleep(Duration.millis(30));
        const sentWhileWaiting = probeRequestsIn(sent);
        yield* Deferred.succeed(answerFirstProbe, undefined);
        yield* Fiber.joinAll(reads);
        return { sentWhileWaiting, catalog: yield* readAccountCatalog(account.id) };
      }),
    );

    expect(outcome.sentWhileWaiting).toBe(1);
    // The first read, and one for the two that waited.
    expect(probeRequestsIn(sent)).toBe(2);
    expect(outcome.catalog.models.map((one) => one.slug)).toEqual(["model-1"]);
  });

  it("does not send a due read of an account whose read is in flight", async () => {
    const sent: Array<Sent> = [];
    const answerFirstProbe = Effect.runSync(Deferred.make<void>());
    beforeAnswer.current = Effect.suspend(() =>
      probeRequestsIn(sent) === 1 ? Deferred.await(answerFirstProbe) : Effect.void,
    );

    const catalog = await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const account = yield* addKeyAccount();
        const runner = yield* addRunner("laptop");
        const forced = yield* Effect.forkChild(probing.readCatalog(account.id));
        while (probeRequestsIn(sent) < 1) yield* Effect.sleep(Duration.millis(1));
        // A runner that arrives meanwhile probes its pairs, but the catalog is being read.
        const sweep = yield* Effect.forkChild(probing.sweepRunner(runner));
        yield* Effect.sleep(Duration.millis(30));
        yield* Deferred.succeed(answerFirstProbe, undefined);
        yield* Fiber.joinAll([forced, sweep]);
        return yield* readAccountCatalog(account.id);
      }),
    );

    // The read, and the sweep's ordinary probe of the same pair; no second read.
    expect(probeRequestsIn(sent)).toBe(2);
    // The sweep's probe was stored after the read was sent, so the read is
    // out of date as a snapshot. It is still recorded as the catalog read.
    expect(catalog.models.map((one) => one.slug)).toEqual(["model-1"]);
  });
});

describe("a sweep of a runner that just connected", () => {
  afterEach(() => {
    probeResult.current = () => Effect.succeed(SIGNED_IN);
  });

  it("records no failed read for an account that no connected machine serves yet, but the sweep of the whole fleet does", async () => {
    const sent: Array<Sent> = [];

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        // Signed in on a machine that has not connected yet.
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        probeResult.current = () =>
          Effect.succeed({ ...SIGNED_IN, auth: { status: "unauthenticated" } });
        yield* probing.sweepRunner(runner);
        const afterArrival = yield* readAccountCatalog(account.id);
        yield* probing.sweepFleet();
        return { afterArrival, afterFleet: yield* readAccountCatalog(account.id) };
      }),
    );

    expect(outcome.afterArrival.error).toBeNull();
    expect(outcome.afterFleet.error).toContain("not signed in on any connected machine");
  });

  it("reads only the catalogs of accounts it can serve, not those only another machine can", async () => {
    const sent: Array<Sent> = [];

    const catalog = await run(
      sent,
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const account = yield* addKeyAccount();
        yield* addRunner("laptop");
        const bare = yield* addRunner("bare", { binaryPresent: false });
        yield* probing.sweepRunner(bare);
        return yield* readAccountCatalog(account.id);
      }),
    );

    expect(sent).toEqual([]);
    expect(catalog).toMatchObject({ models: [], readAt: null, error: null });
  });
});

describe("the announcement of an expiring token", () => {
  /** Runs `body` while recording what the controller announces. */
  const runAnnouncing = <A, E>(
    body: (
      announced: ReadonlyArray<Change>,
    ) => Effect.Effect<
      A,
      E,
      ProviderAccountProbing | ProviderAccountProbes | SqlClient.SqlClient | Secrets
    >,
  ) => {
    const announced: Array<Change> = [];
    const listener = {
      publish: (changes: ReadonlyArray<Change>) =>
        Effect.sync(() => {
          announced.push(...changes);
        }),
    };
    return run(
      [],
      body(announced).pipe(Effect.provideService(AfterCommit, listener)) as Effect.Effect<
        A,
        E,
        | HarnessAccounts
        | ProviderAccountProbing
        | ProviderAccountProbes
        | ProviderAccountRunners
        | ModelCatalogs
        | SqlClient.SqlClient
        | Secrets
      >,
    );
  };

  /** Waits until `done` is true, for at most three seconds. */
  const waitUntil = (done: () => boolean) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 300 && !done(); attempt++) {
        yield* Effect.sleep(Duration.millis(10));
      }
    });

  const announcesProvider = (change: Change, accountId: string): boolean =>
    change._tag === "record" && change.topic === "provider" && change.id === accountId;

  it("announces the account on the provider topic when its token expires, and not before", async () => {
    const outcome = await runAnnouncing((announced) =>
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: TOKEN_KIND });
        yield* setTokenExpiry(account.id, new Date(Date.now() + 200).toISOString());
        const driver = yield* Effect.forkChild(probing.driving);
        yield* Effect.sleep(Duration.millis(60));
        const before = announced.filter((change) => announcesProvider(change, account.id)).length;
        yield* waitUntil(() => announced.some((change) => announcesProvider(change, account.id)));
        yield* Fiber.interrupt(driver);
        return {
          before,
          after: announced.filter((change) => announcesProvider(change, account.id)),
        };
      }),
    );

    expect(outcome.before).toBe(0);
    expect(outcome.after).toEqual([
      { _tag: "record", topic: "provider", id: expect.any(String) as unknown, kind: "updated" },
    ]);
  });

  it("announces an expiry on time while a slow sweep of the fleet is still running", async () => {
    // The sweep's probe is held, so the sweep cannot end during the test.
    const releaseProbe = Effect.runSync(Deferred.make<void>());
    beforeAnswer.current = Deferred.await(releaseProbe);
    try {
      const outcome = await runAnnouncing((announced) =>
        Effect.gen(function* () {
          const probing = yield* ProviderAccountProbing;
          const account = yield* addAccount({ kind: TOKEN_KIND });
          yield* addKeyAccount("work");
          yield* addRunner("laptop");
          yield* setTokenExpiry(account.id, new Date(Date.now() + 300).toISOString());
          // The driver's own timer starts a sweep after 50 ms, and its probe is held.
          const driver = yield* Effect.forkChild(
            probing.driving.pipe(
              Effect.provideService(ProviderAccountProbeInterval, Duration.millis(50)),
            ),
          );
          yield* waitUntil(() => announced.some((change) => announcesProvider(change, account.id)));
          const announcedWhileSweeping = announced.some((change) =>
            announcesProvider(change, account.id),
          );
          yield* Deferred.succeed(releaseProbe, undefined);
          yield* Fiber.interrupt(driver);
          return announcedWhileSweeping;
        }),
      );
      expect(outcome).toBe(true);
    } finally {
      beforeAnswer.current = Effect.void;
    }
  });

  it("plans again when a snapshot is stored, so a token that now expires sooner is announced on time", async () => {
    const announcedAfterChange = await runAnnouncing((announced) =>
      Effect.gen(function* () {
        const probing = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: TOKEN_KIND });
        const sql = yield* SqlClient.SqlClient;
        yield* withTransaction(
          sql,
          (yield* Secrets).set(
            buildProviderAccountOwner(account.id),
            "token",
            Redacted.make("tok-secret"),
          ),
        );
        const runner = yield* addRunner("laptop");
        // The driver plans with no expiry at all: its next wake is the hourly sweep.
        const driver = yield* Effect.forkChild(probing.driving);
        yield* Effect.sleep(Duration.millis(30));
        yield* setTokenExpiry(account.id, new Date(Date.now() + 250).toISOString());
        // A sign-in ends in a stored snapshot, which is what makes the driver plan again.
        yield* probing.probe(runner, account.id, ALPHA_HARNESS_ID);
        const afterProbe = announced.filter((change) =>
          announcesProvider(change, account.id),
        ).length;
        yield* waitUntil(
          () =>
            announced.filter((change) => announcesProvider(change, account.id)).length > afterProbe,
        );
        yield* Fiber.interrupt(driver);
        return (
          announced.filter((change) => announcesProvider(change, account.id)).length - afterProbe
        );
      }),
    );

    expect(announcedAfterChange).toBe(1);
  });
});
