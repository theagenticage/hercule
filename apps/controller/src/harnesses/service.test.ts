import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { RunnerFacts } from "@hercule/protocol";
import { withTransaction } from "../db";
import { PluginHost } from "../plugins";
import { asUser, buildPluginStack } from "../plugins/testing";
import { runnerRepository } from "../runners";
import {
  addAccount,
  addRunner,
  addSnapshot,
  ALPHA_HARNESS_ID,
  BETA_HARNESS_ID,
  buildAccountPlugins,
  SIGNED_IN,
} from "../provider-accounts/testing";
import { HarnessService, HarnessServiceLayer } from "./service";

const run = <A, E>(body: Effect.Effect<A, E, HarnessService | SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Effect.flatMap(PluginHost, (host) => host.boot(buildAccountPlugins()));
      return yield* body;
    }).pipe(
      Effect.provide(HarnessServiceLayer.pipe(Layer.provideMerge(buildPluginStack()))),
      asUser,
    ) as Effect.Effect<A, E, never>,
  );

/** The facts of a machine that has the binaries named, each present. */
const factsWith = (binaries: ReadonlyArray<string>): RunnerFacts => ({
  os: "linux",
  arch: "x64",
  totalMemoryBytes: 8 * 1024 ** 3,
  docker: false,
  toolchains: [],
  harnesses: binaries.map((name) => ({ name, present: true })),
  adapters: [ALPHA_HARNESS_ID],
  identityPort: 4938,
});

const reportFacts = (runnerId: string, facts: RunnerFacts) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runners = yield* runnerRepository;
    yield* withTransaction(sql, runners.recordFacts(runnerId, facts, "2026-10-31T00:00:00.000Z"));
  });

describe("harness.query", () => {
  it("lists every registered harness, with its declared capabilities and no runners on an empty fleet", async () => {
    const harnesses = await run(Effect.flatMap(HarnessService, (service) => service.query()));

    expect(harnesses.map((harness) => harness.id)).toEqual([ALPHA_HARNESS_ID, BETA_HARNESS_ID]);
    expect(harnesses[0]).toMatchObject({
      displayName: "Harness alpha",
      binaryName: "harness",
      declared: { steering: "native" },
      runners: [],
    });
  });

  it("reports for each runner whether the harness's binary is present, and the version a probe saw", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const withBinary = yield* addRunner("laptop");
        const without = yield* addRunner("server");
        yield* reportFacts(withBinary, factsWith(["harness"]));
        yield* reportFacts(without, factsWith(["something-else"]));
        const account = yield* addAccount();
        yield* addSnapshot(account.id, ALPHA_HARNESS_ID, withBinary, SIGNED_IN);
        // A snapshot on a runner without the binary does not make it installed.
        yield* addSnapshot(account.id, ALPHA_HARNESS_ID, without, SIGNED_IN);
        const harnesses = yield* Effect.flatMap(HarnessService, (service) => service.query());
        return { harnesses, withBinary, without };
      }),
    );

    const alpha = outcome.harnesses.find((harness) => harness.id === ALPHA_HARNESS_ID);
    expect(alpha?.runners).toEqual([
      {
        runnerId: outcome.withBinary,
        installed: true,
        version: "1.2.3",
        versionVerdict: "unknown",
      },
      { runnerId: outcome.without, installed: false, version: null, versionVerdict: "unknown" },
    ]);
  });

  it("reports a runner that has not said hello as not having the harness", async () => {
    const harnesses = await run(
      Effect.gen(function* () {
        yield* addRunner("new", { saidHello: false });
        return yield* Effect.flatMap(HarnessService, (service) => service.query());
      }),
    );

    expect(harnesses[0]?.runners).toMatchObject([{ installed: false, version: null }]);
  });
});
