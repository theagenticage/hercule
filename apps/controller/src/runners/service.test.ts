/**
 * The grant check `RunnerService` runs inside each method.
 *
 * It cannot be reached over HTTP: v1 authenticates one population, the user,
 * and the user has full parity, so no credential a request can present is
 * missing `infra.read` or `infra.write`. The refusal is asserted where it
 * lives - an in-process call with nobody in `CurrentActor`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { AuditLogLayer } from "../events";
import { TestDatabase } from "../db/testing";
import { SettingsLayer } from "../settings";
import { JoinTokensLayer, RunnerPresenceLayer, RunnerService, RunnerServiceLayer } from "./index";

const layer = RunnerServiceLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(JoinTokensLayer, SettingsLayer, RunnerPresenceLayer)),
  Layer.provideMerge(AuditLogLayer),
  Layer.provideMerge(TestDatabase),
);

/** A well-formed id nobody has: the grant check answers before the lookup. */
const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(Effect.flip(effect).pipe(Effect.provide(layer)) as Effect.Effect<E>);

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
