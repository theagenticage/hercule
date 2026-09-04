import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Grant } from "@hydra/contract";
import { TestDatabase } from "../db/testing";
import { PermissionProfiles, PermissionProfilesLayer } from "./profiles";

const layer = PermissionProfilesLayer.pipe(Layer.provideMerge(TestDatabase));

const run = <A, E>(effect: Effect.Effect<A, E, PermissionProfiles | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

/** Runs an effect that is expected to fail, and hands the test its error. */
const runError = <A, E>(effect: Effect.Effect<A, E, PermissionProfiles | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(layer)));

describe("PermissionProfiles", () => {
  it("seeds a shipped profile and reads it back by name", async () => {
    const found = await run(
      Effect.gen(function* () {
        const profiles = yield* PermissionProfiles;
        yield* profiles.ensureShipped("reviewer", ["task.read", "run.read"]);
        return yield* profiles.getByName("reviewer");
      }),
    );
    const profile = Option.getOrThrow(found);
    expect(profile.name).toBe("reviewer");
    expect(profile.grants).toEqual(["task.read", "run.read"]);
    expect(profile.shipped).toBe(true);
    expect(profile.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(profile.createdAt).toBe(profile.updatedAt);
  });

  it("answers None for a name nobody created", async () => {
    const found = await run(
      Effect.flatMap(PermissionProfiles, (profiles) => profiles.getByName("nobody")),
    );
    expect(Option.isNone(found)).toBe(true);
  });

  it("leaves an existing profile alone rather than writing a second one", async () => {
    const { profile, rows } = await run(
      Effect.gen(function* () {
        const profiles = yield* PermissionProfiles;
        const sql = yield* SqlClient.SqlClient;
        yield* profiles.ensureShipped("reviewer", ["task.read"]);
        yield* profiles.ensureShipped("reviewer", ["task.read", "task.delete"]);
        const counted = yield* sql<{
          readonly n: number;
        }>`SELECT count(*) AS n FROM permission_profiles`;
        return { profile: yield* profiles.getByName("reviewer"), rows: counted[0]!.n };
      }),
    );
    expect(rows).toBe(1);
    expect(Option.getOrThrow(profile).grants).toEqual(["task.read"]);
  });

  it("refuses a grant outside the vocabulary", async () => {
    const error = await runError(
      Effect.flatMap(PermissionProfiles, (profiles) =>
        profiles.ensureShipped("broken", ["task.explode" as Grant]),
      ),
    );
    expect(error._tag).toBe("GrantsError");
  });
});
