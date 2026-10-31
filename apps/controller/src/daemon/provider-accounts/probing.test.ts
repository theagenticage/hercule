/**
 * Tests probing with a stand-in for the connection to the runners, so the
 * frames the controller sends can be read and answered one by one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Deferred, Duration, Effect, Fiber, Layer, Logger, Option, Redacted, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { ControllerToRunner, ProbeResult, RunnerToController } from "@hercule/protocol";
import { uuidFromString, withTransaction } from "../../db";
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
  HarnessAccountsLayer,
  ProviderAccountProbes,
  ProviderAccountProbesLayer,
  ProviderAccountRunners,
  ProviderAccountRunnersLayer,
  providerAccountRepository,
} from "../../provider-accounts";
import {
  addAccount,
  addRunner,
  addSnapshot,
  ALPHA_HARNESS_ID,
  buildAccountPlugins,
  KEY_KIND,
  MACHINE_KIND,
  SIGNED_IN,
} from "../../provider-accounts/testing";
import { RunnerConnections } from "../../runners";
import { buildProviderAccountOwner, Secrets } from "../../secrets";
import { ProviderAccountProbing, ProviderAccountProbingLayer } from "./probing";

interface Sent {
  readonly runnerId: string;
  readonly request: ControllerToRunner;
}

/** Runs before a probe is answered, so a test can change the world while a runner is "thinking". */
const beforeAnswer: { current: Effect.Effect<void> } = { current: Effect.void };

/**
 * Decides what the runner answers to a probe, given how many probe requests
 * were sent before it (0 for the first). The default is `SIGNED_IN` at once.
 */
const probeResult: { current: (index: number) => Effect.Effect<ProbeResult> } = {
  current: () => Effect.succeed(SIGNED_IN),
};

/** A connection that records every frame and answers each probe as `probeResult` says. */
const buildFakeConnections = (sent: Array<Sent>): RunnerConnections["Service"] =>
  ({
    arrivals: Stream.empty,
    asked: (runnerId: string, request: ControllerToRunner) => {
      sent.push({ runnerId, request });
      if (request._tag !== "probeRequest") return Effect.succeed(Option.none());
      const index = sent.filter((one) => one.request._tag === "probeRequest").length - 1;
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
          kinds: [{ kind: "api-key", credentialVariable: "FLOORED_API_KEY" }],
          modelArgument: "{model}",
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
              kinds: [{ kind: "api-key", credentialVariable: "MULTI_API_KEY" }],
              modelArgument: "{model}",
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
    | ProviderAccountProbing
    | ProviderAccountProbes
    | ProviderAccountRunners
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
          Layer.provideMerge(ProviderAccountRunnersLayer),
          Layer.provideMerge(ProviderAccountProbesLayer),
          Layer.provideMerge(HarnessAccountsLayer),
          Layer.provideMerge(Layer.succeed(RunnerConnections)(buildFakeConnections(sent))),
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

const snapshotsOf = (accountId: string) =>
  Effect.flatMap(providerAccountRepository, (accounts) => accounts.listSnapshots(accountId));

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

        return { account, runner, snapshot, stored: yield* snapshotsOf(account.id) };
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
    expect(sent).toEqual([]);
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
        return { olderAnswer, stored: yield* snapshotsOf(account.id) };
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
        return { failure, stored: yield* snapshotsOf(account.id) };
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
      sent.map((one) =>
        one.request._tag === "probeRequest" ? one.request.harnessAccount.providerAccountId : "",
      ),
    ).toEqual([outcome.first.id, outcome.second.id]);
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

    expect(sent).toEqual([]);
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

    expect(sent.map((one) => one.runnerId)).toEqual([ready]);
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
    expect(sent).toHaveLength(10);
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
    expect(sent).toHaveLength(8);
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
    expect(sent.map((one) => one.runnerId)).toEqual([outcome.runner]);
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

    expect(sent).toHaveLength(2);
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
        return yield* snapshotsOf(account.id);
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

    await run(
      [],
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        yield* probes.expectLoginEnd(runner, account.id, ALPHA_HARNESS_ID, "login-1", Effect.void);
        yield* probes.recordPrintedLogin(runner, account.id, ALPHA_HARNESS_ID, "login-1", {
          reportsEnd: true,
        });
        yield* deleteWhenAnswering(account.id);
        // Fails with nothing: the end of a login is reported by a runner, and nobody awaits this call.
        yield* probes.probeAfterLoginEnd(runner, "login-1");
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
  });

  it("probes the account in the login's harness on the login's runner, once", async () => {
    const sent: Array<Sent> = [];

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        yield* probes.expectLoginEnd(runner, account.id, ALPHA_HARNESS_ID, "login-1", Effect.void);
        yield* probes.recordPrintedLogin(runner, account.id, ALPHA_HARNESS_ID, "login-1", {
          reportsEnd: true,
        });

        yield* probes.probeAfterLoginEnd(runner, "login-1");
        // The same end reported twice is ignored the second time.
        yield* probes.probeAfterLoginEnd(runner, "login-1");

        return { account, runner, stored: yield* snapshotsOf(account.id) };
      }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      runnerId: outcome.runner,
      request: { _tag: "probeRequest", harnessId: ALPHA_HARNESS_ID },
    });
    expect(outcome.stored.map((snapshot) => snapshot.harnessId)).toEqual([ALPHA_HARNESS_ID]);
  });

  it("completes a probe repeated for a login that ended meanwhile as that later login", async () => {
    const sent: Array<Sent> = [];
    const signedInAs: Array<string> = [];
    const answerFirstProbe = Effect.runSync(Deferred.make<void>());
    beforeAnswer.current = Effect.suspend(() =>
      sent.length === 1 ? Deferred.await(answerFirstProbe) : Effect.void,
    );

    await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbing;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        // A newer printed login ends the older one's wait, so login-2 starts
        // only after login-1 ended and its probe is running.
        const startLogin = (requestId: string, actor: string) =>
          Effect.gen(function* () {
            yield* probes.expectLoginEnd(
              runner,
              account.id,
              ALPHA_HARNESS_ID,
              requestId,
              Effect.sync(() => void signedInAs.push(actor)),
            );
            yield* probes.recordPrintedLogin(runner, account.id, ALPHA_HARNESS_ID, requestId, {
              reportsEnd: true,
            });
          });

        yield* startLogin("login-1", "user-a");
        const first = yield* Effect.forkChild(probes.probeAfterLoginEnd(runner, "login-1"));
        while (sent.length === 0) yield* Effect.sleep(Duration.millis(1));
        yield* startLogin("login-2", "user-b");
        yield* probes.probeAfterLoginEnd(runner, "login-2");
        yield* Deferred.succeed(answerFirstProbe, undefined);
        yield* Fiber.join(first);
      }),
    );

    expect(sent.filter((one) => one.request._tag === "probeRequest")).toHaveLength(2);
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

    expect(sent).toEqual([]);
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
        yield* probes.expectLoginEnd(runner, account.id, ALPHA_HARNESS_ID, "login-1", Effect.void);
        yield* probes.recordPrintedLogin(runner, account.id, ALPHA_HARNESS_ID, "login-1", {
          reportsEnd: true,
        });
        yield* probes.probeAfterLoginEnd(other, "login-1");
      }),
    );

    expect(sent).toEqual([]);
  });
});
