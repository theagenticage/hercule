/**
 * `RunnerService` called in process, for the rules that need no transport.
 *
 * The grant check is here because it cannot be reached over HTTP: v1
 * authenticates one population, the user, and the user has full parity, so no
 * credential a request can present is missing `infra.read` or `infra.write`.
 * The lifecycle and conflict refusals are here because they are decided in this
 * file and asserting them over the wire only re-asserts the status mapping.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { RunnerDetail, RunnerLifecycle } from "@hydra/contract";
import { CurrentActor, type Actor } from "../actor";
import { nowIso } from "../db";
import { AuditLog, AuditLogLayer } from "../events";
import { TestDatabase } from "../db/testing";
import { Settings, SettingsLayer } from "../settings";
import { runnerRepository } from "./repository";
import { JoinTokensLayer, RunnerPresenceLayer, RunnerService, RunnerServiceLayer } from "./index";

const layer = RunnerServiceLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(JoinTokensLayer, SettingsLayer, RunnerPresenceLayer)),
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

/** Everything a scenario in this file may reach. */
type Provided = RunnerService | Settings | AuditLog | SqlClient.SqlClient;

/** A well-formed id nobody has: the grant check answers before the lookup. */
const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-1111-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-2222-7000-8000-000000000000", tokenHash: "hash" },
};

const failure = <A, E>(effect: Effect.Effect<A, E, Provided>) =>
  Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(layer)) as Effect.Effect<E>);

/** Runs one scenario against a fresh database, with the user behind it. */
const asUser = <A, E>(effect: Effect.Effect<A, E, Provided>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provideService(CurrentActor, USER), Effect.provide(layer), Effect.orDie),
  );

const insert = (
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
  it("is refused infra.read by query and read, before anything is looked up", async () => {
    const errors = await Promise.all([
      failure(Effect.flatMap(RunnerService, (runners) => runners.query({}))),
      failure(Effect.flatMap(RunnerService, (runners) => runners.read({ id: UNKNOWN_ID }))),
    ]);
    for (const error of errors) {
      expect(error).toMatchObject({
        error: { code: "forbidden", details: { grant: "infra.read" } },
      });
    }
  });

  it("is refused infra.write by update, before anything is looked up", async () => {
    const error = await failure(
      Effect.flatMap(RunnerService, (runners) => runners.update({ id: UNKNOWN_ID, name: "iris" })),
    );
    expect(error).toMatchObject({
      error: { code: "forbidden", details: { grant: "infra.write" } },
    });
  });

  it("is refused infra.write by createJoinToken, before a token is minted", async () => {
    const error = await failure(
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

describe("the refusals the state machine makes on its own", () => {
  it("refuses each lifecycle move the runner is not standing where it needs to be for", async () => {
    const { errors, after, trail } = await asUser(
      Effect.gen(function* () {
        const runners = yield* RunnerService;
        const active = yield* insert("iris", "active");
        const draining = yield* insert("atlas", "draining");
        const retired = yield* insert("vega", "retired");

        const errors = yield* Effect.forEach(
          [
            runners.drain({ id: draining.id }),
            runners.drain({ id: retired.id }),
            runners.undrain({ id: active.id }),
            runners.undrain({ id: retired.id }),
            runners.retire({ id: retired.id }),
          ],
          Effect.flip,
        );
        const audit = yield* AuditLog;
        return {
          errors,
          after: yield* Effect.forEach([active, draining, retired], (runner) =>
            Effect.map(runners.read({ id: runner.id }), (row) => row.lifecycle),
          ),
          trail: yield* Effect.forEach(
            ["runner.drained", "runner.undrained", "runner.retired"] as const,
            (kind) => audit.listByKind(kind),
          ),
        };
      }),
    );

    for (const error of errors) expect(error).toMatchObject({ error: { code: "invalid_state" } });
    expect(after, "nothing moved").toEqual(["active", "draining", "retired"]);
    expect(trail.flat(), "nothing was written down").toEqual([]);
  });

  it("refuses a name another runner holds, takes one nobody does, and reads case as its own", async () => {
    const { taken, refused, cased, free } = await asUser(
      Effect.gen(function* () {
        const runners = yield* RunnerService;
        const iris = yield* insert("iris", "active", ["gpu"]);
        yield* insert("atlas");
        const taken = yield* Effect.flip(runners.update({ id: iris.id, name: "atlas" }));
        return {
          taken,
          refused: yield* runners.read({ id: iris.id }),
          // Nothing here folds case: the fleet reads what the user typed.
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

  it("refuses to reserve the runner the fleet falls back on, and leaves it alone", async () => {
    const { error, after } = await asUser(
      Effect.gen(function* () {
        const runners = yield* RunnerService;
        const chosen = yield* insert("iris");
        yield* (yield* Settings).setDefaultRunnerId(chosen.id, yield* nowIso);
        return {
          error: yield* Effect.flip(runners.update({ id: chosen.id, reserved: true })),
          after: yield* runners.read({ id: chosen.id }),
        };
      }),
    );

    expect(error).toMatchObject({ error: { code: "conflict" } });
    expect(after.reserved).toBe(false);
  });
});
