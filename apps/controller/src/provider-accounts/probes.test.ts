/**
 * Tests the probes with a stand-in for the connection to the runners, so the
 * frames the controller sends can be read and answered one by one.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Layer, Logger, Option, Redacted, Stream } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { ControllerToRunner, RunnerToController } from "@hercule/protocol";
import { uuidFromString, withTransaction } from "../db";
import { PluginHost } from "../plugins";
import { asUser, buildPluginStack } from "../plugins/testing";
import { RunnerConnections } from "../runners";
import { buildProviderAccountOwner, Secrets } from "../secrets";
import { HarnessAccountsLayer } from "./harness-account";
import { ProviderAccountProbes, ProviderAccountProbesLayer } from "./probes";
import { providerAccountRepository } from "./repository";
import {
  addAccount,
  addRunner,
  ALPHA_HARNESS_ID,
  buildAccountPlugins,
  KEY_KIND,
  MACHINE_KIND,
  SIGNED_IN,
} from "./testing";

interface Sent {
  readonly runnerId: string;
  readonly request: ControllerToRunner;
}

/** Runs before a probe is answered, so a test can change the world while a runner is "thinking". */
const beforeAnswer: { current: Effect.Effect<void> } = { current: Effect.void };

/** A connection that records every frame and answers each probe with `SIGNED_IN`. */
const buildFakeConnections = (sent: Array<Sent>): RunnerConnections["Service"] =>
  ({
    arrivals: Stream.empty,
    asked: (runnerId: string, request: ControllerToRunner) => {
      sent.push({ runnerId, request });
      if (request._tag !== "probeRequest") return Effect.succeed(Option.none());
      const answer: RunnerToController = {
        _tag: "probeReport",
        requestId: request.requestId,
        providerAccountId: request.harnessAccount.providerAccountId,
        result: SIGNED_IN,
      };
      return Effect.as(beforeAnswer.current, Option.some(answer));
    },
  }) as unknown as RunnerConnections["Service"];

/** A log line the controller wrote while a test ran. */
interface Logged {
  readonly level: string;
  readonly message: string;
}

const run = <A, E>(
  sent: Array<Sent>,
  body: Effect.Effect<A, E, ProviderAccountProbes | SqlClient.SqlClient | Secrets>,
  logged: Array<Logged> = [],
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(PluginHost, (host) => host.boot(buildAccountPlugins()));
      return yield* body;
    }).pipe(
      Effect.provide(
        ProviderAccountProbesLayer.pipe(
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
        const probes = yield* ProviderAccountProbes;
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
    expect(Option.getOrNull(outcome.snapshot)).toMatchObject({
      runnerId: outcome.runner,
      harnessId: ALPHA_HARNESS_ID,
      auth: { status: "ok" },
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
        const probes = yield* ProviderAccountProbes;
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
        const probes = yield* ProviderAccountProbes;
        const runner = yield* addRunner("laptop");
        return yield* Effect.flip(
          probes.probe(runner, "0199e0e7-9999-7000-8000-000000000000", ALPHA_HARNESS_ID),
        );
      }),
    );

    expect(failure).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("a sweep", () => {
  it("probes each account in its default harness on every connected runner", async () => {
    const sent: Array<Sent> = [];

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const first = yield* addAccount({ kind: MACHINE_KIND });
        const second = yield* addAccount({ kind: KEY_KIND, label: "work" });
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

  it("sends nothing to a runner whose facts show no adapter for the harness, or no binary", async () => {
    const sent: Array<Sent> = [];

    const ready = await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        yield* addAccount({ kind: KEY_KIND });
        const ready = yield* addRunner("ready");
        const noAdapter = yield* addRunner("no-adapter", { adapters: [] });
        const noBinary = yield* addRunner("no-binary", { binaryPresent: false });
        yield* Effect.forEach([ready, noAdapter, noBinary], probes.sweepRunner, { discard: true });
        return ready;
      }),
    );

    expect(sent.map((one) => one.runnerId)).toEqual([ready]);
  });

  it("probes one account on every connected runner after its credential changed", async () => {
    const sent: Array<Sent> = [];

    await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: KEY_KIND });
        yield* addAccount({ kind: KEY_KIND, label: "other" });
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
        const probes = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: KEY_KIND });
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
        const probes = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        yield* probes.expectLoginEnd(runner, account.id, ALPHA_HARNESS_ID, "login-1");
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
  it("probes the account in the login's harness on the login's runner, once", async () => {
    const sent: Array<Sent> = [];

    const outcome = await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        yield* probes.expectLoginEnd(runner, account.id, ALPHA_HARNESS_ID, "login-1");
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

  it("ignores an end that no login was waiting for", async () => {
    const sent: Array<Sent> = [];

    await run(
      sent,
      Effect.gen(function* () {
        const probes = yield* ProviderAccountProbes;
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
        const probes = yield* ProviderAccountProbes;
        const account = yield* addAccount({ kind: MACHINE_KIND });
        const runner = yield* addRunner("laptop");
        const other = yield* addRunner("desktop");
        yield* probes.expectLoginEnd(runner, account.id, ALPHA_HARNESS_ID, "login-1");
        yield* probes.recordPrintedLogin(runner, account.id, ALPHA_HARNESS_ID, "login-1", {
          reportsEnd: true,
        });
        yield* probes.probeAfterLoginEnd(other, "login-1");
      }),
    );

    expect(sent).toEqual([]);
  });
});
