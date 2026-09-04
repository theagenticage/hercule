import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestDatabase } from "../db/testing";
import { Users, UsersLayer } from "./repository";

const layer = UsersLayer.pipe(Layer.provideMerge(TestDatabase));

const run = <A, E>(effect: Effect.Effect<A, E, Users | SqlClient.SqlClient>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

const runExit = <A, E>(effect: Effect.Effect<A, E, Users | SqlClient.SqlClient>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(layer)));

describe("Users", () => {
  it("creates a user and finds it by name and by id", async () => {
    const [created, byName, byId] = await run(
      Effect.gen(function* () {
        const users = yield* Users;
        const created = yield* users.create("rogier", "hash-1");
        return [
          created,
          yield* users.findByUsername("rogier"),
          yield* users.findById(created.id),
        ] as const;
      }),
    );
    expect(created.username).toBe("rogier");
    expect(created.createdAt).toBe(created.updatedAt);
    expect(Option.getOrThrow(byName)).toEqual(created);
    expect(Option.getOrThrow(byId)).toEqual(created);
  });

  it("finds nothing for a name and an id nobody has", async () => {
    const [byName, byId] = await run(
      Effect.gen(function* () {
        const users = yield* Users;
        return [
          yield* users.findByUsername("nobody"),
          yield* users.findById("019958e2-0000-7000-8000-000000000000"),
        ] as const;
      }),
    );
    expect(Option.isNone(byName)).toBe(true);
    expect(Option.isNone(byId)).toBe(true);
  });

  it("refuses a username that is already taken", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const users = yield* Users;
        yield* users.create("rogier", "hash-1");
        return yield* users.create("rogier", "hash-2");
      }),
    );
    expect(exit._tag).toBe("Failure");
  });

  it("replaces the password hash and stamps the row", async () => {
    const [before, after] = await run(
      Effect.gen(function* () {
        const users = yield* Users;
        const created = yield* users.create("rogier", "hash-1");
        yield* users.setPasswordHash(created.id, "hash-2");
        return [created, Option.getOrThrow(yield* users.findById(created.id))] as const;
      }),
    );
    expect(before.passwordHash).toBe("hash-1");
    expect(after.passwordHash).toBe("hash-2");
    expect(after.createdAt).toBe(before.createdAt);
  });
});
