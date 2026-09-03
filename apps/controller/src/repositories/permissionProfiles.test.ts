import { describe, expect, it } from "vitest";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import {
  ALL_GRANTS,
  GrantSchema,
  PermissionProfiles,
  PermissionProfilesLayer,
  type Grant,
} from "./permissionProfiles";

const layer = PermissionProfilesLayer.pipe(Layer.provideMerge(TestDatabase));

const run = <A, E>(effect: Effect.Effect<A, E, PermissionProfiles | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

/** Runs an effect that is expected to fail, and hands the test its error. */
const runError = <A, E>(effect: Effect.Effect<A, E, PermissionProfiles | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.flip, Effect.provide(layer)));

describe("the grant vocabulary", () => {
  it("accepts a grant from the table and rejects anything else", () => {
    const decode = Schema.decodeUnknownEffect(GrantSchema);
    expect(Effect.runSync(decode("task.delete"))).toBe("task.delete");
    for (const bad of ["task.explode", "tasks.read", "task", "read.task", ""]) {
      expect(Effect.runSyncExit(decode(bad))._tag).toBe("Failure");
    }
  });

  it("has no duplicates and covers every family", () => {
    expect(new Set(ALL_GRANTS).size).toBe(ALL_GRANTS.length);
    expect(ALL_GRANTS).toContain("credential.write");
    expect(ALL_GRANTS).toContain("connection.use");
  });
});

describe("PermissionProfiles", () => {
  it("creates a profile and reads it back by name", async () => {
    const found = await run(
      Effect.gen(function* () {
        const profiles = yield* PermissionProfiles;
        yield* profiles.create("reviewer", ["task.read", "run.read"]);
        return yield* profiles.getByName("reviewer");
      }),
    );
    const profile = Option.getOrThrow(found);
    expect(profile.name).toBe("reviewer");
    expect(profile.grants).toEqual(["task.read", "run.read"]);
    expect(profile.shipped).toBe(false);
    expect(profile.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(profile.createdAt).toBe(profile.updatedAt);
  });

  it("answers None for a name nobody created", async () => {
    const found = await run(
      Effect.flatMap(PermissionProfiles, (profiles) => profiles.getByName("nobody")),
    );
    expect(Option.isNone(found)).toBe(true);
  });

  it("refuses a duplicate name", async () => {
    const error = await runError(
      Effect.gen(function* () {
        const profiles = yield* PermissionProfiles;
        yield* profiles.create("reviewer", ["task.read"]);
        yield* profiles.create("reviewer", ["task.read"]);
      }),
    );
    expect(error._tag).toBe("DuplicateProfileError");
  });

  it("refuses a grant outside the vocabulary", async () => {
    const error = await runError(
      Effect.flatMap(PermissionProfiles, (profiles) =>
        profiles.create("broken", ["task.explode" as Grant]),
      ),
    );
    expect(error._tag).toBe("GrantsError");
  });

  it("lists profiles by name", async () => {
    const names = await run(
      Effect.gen(function* () {
        const profiles = yield* PermissionProfiles;
        yield* profiles.create("beta", ["task.read"]);
        yield* profiles.create("alpha", ["task.read"]);
        return (yield* profiles.list()).map((profile) => profile.name);
      }),
    );
    expect(names).toEqual(["alpha", "beta"]);
  });
});
