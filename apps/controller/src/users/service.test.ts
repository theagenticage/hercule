import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import { CurrentActor, type Actor } from "../actor";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { hashPassword, PasswordCost, TEST_PASSWORD_PARAMS, verifyPassword } from "./password";
import { Users, UsersLayer } from "./repository";
import { User, UserLayer } from "./service";

const CURRENT = "correct horse battery staple";
const NEXT = "a different long passphrase";

type Deps = User | Users | AuditLog;

const layer = UserLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(UsersLayer, AuditLogLayer)),
  Layer.provideMerge(TestDatabase),
);

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(layer), Effect.provideService(PasswordCost, TEST_PASSWORD_PARAMS)),
  );

/** Creates the user with a real hash of {@link CURRENT}, and runs `body` as that user. */
const runAsUser = <A, E>(body: Effect.Effect<A, E, Deps>) =>
  run(
    Effect.gen(function* () {
      const users = yield* Users;
      const user = yield* users.create(
        "rogier",
        yield* hashPassword(CURRENT, TEST_PASSWORD_PARAMS),
      );
      const actor: Actor = {
        _tag: "user",
        userId: user.id,
        credential: { kind: "login", id: user.id, tokenHash: "irrelevant" },
      };
      return yield* body.pipe(Effect.provideService(CurrentActor, actor));
    }),
  );

describe("user.setPassword", () => {
  it("stores the new password and records the change", async () => {
    const result = await runAsUser(
      Effect.gen(function* () {
        const user = yield* User;
        const users = yield* Users;
        const audit = yield* AuditLog;
        const answer = yield* user.setPassword({ current: CURRENT, next: NEXT });
        const stored = yield* users.findByUsername("rogier");
        const hash = Option.getOrThrow(stored).passwordHash;
        return {
          answer,
          next: yield* verifyPassword(NEXT, hash),
          old: yield* verifyPassword(CURRENT, hash),
          entries: yield* audit.listByKind("user.passwordChanged"),
        };
      }),
    );

    expect(result.answer).toEqual({});
    expect(result.next).toBe(true);
    expect(result.old).toBe(false);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.actor).toBe("user");
    expect(result.entries[0]?.payload).toEqual({});
  });

  it("rejects a wrong current password on the current field, and changes nothing", async () => {
    const result = await runAsUser(
      Effect.gen(function* () {
        const user = yield* User;
        const users = yield* Users;
        const audit = yield* AuditLog;
        const failure = yield* Effect.flip(user.setPassword({ current: "guess", next: NEXT }));
        const stored = yield* users.findByUsername("rogier");
        return {
          failure,
          unchanged: yield* verifyPassword(CURRENT, Option.getOrThrow(stored).passwordHash),
          entries: yield* audit.listByKind("user.passwordChanged"),
        };
      }),
    );

    expect(result.failure).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["current"] }] } },
    });
    expect(result.unchanged).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it("does not check the password for a caller with no credential", async () => {
    const failure = await run(
      Effect.flip(
        Effect.flatMap(User, (user) => user.setPassword({ current: CURRENT, next: NEXT })),
      ),
    );

    expect(failure).toMatchObject({
      error: { code: "forbidden", details: { grant: "credential.write" } },
    });
  });
});
