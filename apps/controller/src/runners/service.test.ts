/**
 * Tests for `RunnerService` called in process, for the rules that need no
 * transport.
 *
 * The grant check is tested here because it cannot be reached over HTTP: v1
 * authenticates only the user, and the user has every grant, so no credential
 * a request can send is missing `infra.read` or `infra.write`. The lifecycle
 * and conflict errors are tested here because the service decides them, and
 * testing them over HTTP would only test the status mapping again.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { RunnerDetail, RunnerLifecycle } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { nowIso } from "../db";
import { AuditLogLayer } from "../events";
import { NotificationServiceTestLayer } from "../notifications/testing";
import { readEventsOfKind } from "../events/testing";
import { TestDatabase } from "../db/testing";
import { Settings, SettingsLayer } from "../settings";
import { runnerRepository } from "./repository";
import {
  JoinTokensLayer,
  RunnerConnectionsLayer,
  RunnerService,
  RunnerServiceLayer,
} from "./index";

const layer = RunnerServiceLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(JoinTokensLayer, SettingsLayer)),
  Layer.provideMerge(RunnerConnectionsLayer),
  Layer.provideMerge(NotificationServiceTestLayer),
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

/** The services a test in this file may use. */
type Provided = RunnerService | Settings | SqlClient.SqlClient;

/** A valid id that matches no runner: the grant check fails before the lookup. */
const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-1111-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-2222-7000-8000-000000000000", tokenHash: "hash" },
};

const runError = <A, E>(effect: Effect.Effect<A, E, Provided>) =>
  Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(layer)) as Effect.Effect<E>);

/** Runs one test against a fresh database, as the user. */
const runAsUser = <A, E>(effect: Effect.Effect<A, E, Provided>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provideService(CurrentActor, USER), Effect.provide(layer), Effect.orDie),
  );

const insertRunner = (
  name: string,
  lifecycle: RunnerLifecycle = "active",
  labels: ReadonlyArray<string> = [],
): Effect.Effect<RunnerDetail, never, Provided> =>
  Effect.gen(function* () {
    const runners = yield* runnerRepository;
    return yield* runners.insert({
      name,
      connectivity: "offline",
      lifecycle,
      reserved: false,
      labels,
      credentialHash: `hash-${name}`,
      at: yield* nowIso,
    });
  }).pipe(Effect.orDie);

describe("a caller with no actor", () => {
  it("is forbidden from query and read without infra.read, before anything is looked up", async () => {
    const errors = await Promise.all([
      runError(Effect.flatMap(RunnerService, (runners) => runners.query({}))),
      runError(Effect.flatMap(RunnerService, (runners) => runners.read(UNKNOWN_ID))),
    ]);
    for (const error of errors) {
      expect(error).toMatchObject({
        error: { code: "forbidden", details: { grant: "infra.read" } },
      });
    }
  });

  it("is forbidden from update without infra.write, before anything is looked up", async () => {
    const error = await runError(
      Effect.flatMap(RunnerService, (runners) => runners.update({ id: UNKNOWN_ID, name: "iris" })),
    );
    expect(error).toMatchObject({
      error: { code: "forbidden", details: { grant: "infra.write" } },
    });
  });

  it("is forbidden from createJoinToken without infra.write, before a token is created", async () => {
    const error = await runError(
      Effect.flatMap(RunnerService, (runners) => runners.createJoinToken()),
    );
    expect(error).toMatchObject({
      error: { code: "forbidden", details: { grant: "infra.write" } },
    });
    const rows = await Effect.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`SELECT token_hash FROM runner_join_tokens`,
      ).pipe(Effect.provide(layer), Effect.orDie),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("the errors the service returns on its own", () => {
  it("rejects each lifecycle change from a lifecycle it does not start from", async () => {
    const { errors, after, trail } = await runAsUser(
      Effect.gen(function* () {
        const runners = yield* RunnerService;
        const active = yield* insertRunner("iris", "active");
        const draining = yield* insertRunner("atlas", "draining");
        const retired = yield* insertRunner("vega", "retired");

        const errors = yield* Effect.forEach(
          [
            runners.drain(draining.id),
            runners.drain(retired.id),
            runners.undrain(active.id),
            runners.undrain(retired.id),
            runners.retire({ id: retired.id }),
          ],
          Effect.flip,
        );
        return {
          errors,
          after: yield* Effect.forEach([active, draining, retired], (runner) =>
            Effect.map(runners.read(runner.id), (row) => row.lifecycle),
          ),
          trail: yield* Effect.forEach(
            ["runner.drained", "runner.undrained", "runner.retired"] as const,
            (kind) => readEventsOfKind(kind),
          ),
        };
      }),
    );

    for (const error of errors) expect(error).toMatchObject({ error: { code: "invalid_state" } });
    expect(after, "nothing moved").toEqual(["active", "draining", "retired"]);
    expect(trail.flat(), "nothing was written down").toEqual([]);
  });

  it("rejects a name another runner has, accepts a free one, and treats a different case as a different name", async () => {
    const { taken, refused, cased, free } = await runAsUser(
      Effect.gen(function* () {
        const runners = yield* RunnerService;
        const iris = yield* insertRunner("iris", "active", ["gpu"]);
        yield* insertRunner("atlas");
        const taken = yield* Effect.flip(runners.update({ id: iris.id, name: "atlas" }));
        return {
          taken,
          refused: yield* runners.read(iris.id),
          // Names are case-sensitive: the fleet stores what the user typed.
          cased: yield* runners.update({ id: iris.id, name: "Atlas" }),
          free: yield* runners.update({ id: iris.id, name: "vega" }),
        };
      }),
    );

    expect(taken).toMatchObject({ error: { code: "conflict" } });
    expect(refused, "the refused rename changed nothing").toMatchObject({
      name: "iris",
      labels: ["gpu"],
    });
    expect([cased.name, free.name]).toEqual(["Atlas", "vega"]);
  });

  it("rejects reserving the fleet's default runner, and leaves it unchanged", async () => {
    const { error, after } = await runAsUser(
      Effect.gen(function* () {
        const runners = yield* RunnerService;
        const chosen = yield* insertRunner("iris");
        yield* (yield* Settings).setDefaultRunnerId(chosen.id, yield* nowIso);
        return {
          error: yield* Effect.flip(runners.update({ id: chosen.id, reserved: true })),
          after: yield* runners.read(chosen.id),
        };
      }),
    );

    expect(error).toMatchObject({ error: { code: "conflict" } });
    expect(after.reserved).toBe(false);
  });
});
