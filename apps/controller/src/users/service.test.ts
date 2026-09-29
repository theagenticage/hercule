import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { Grant } from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { TestDatabase } from "../db/testing";
import { AuditLogLayer } from "../events";
import { readEventsOfKind } from "../events/testing";
import { hashPassword, PasswordCost, TEST_PASSWORD_PARAMS, verifyPassword } from "./password";
import { Users, UsersLayer } from "./repository";
import { User, UserLayer } from "./service";

const CURRENT = "correct horse battery staple";
const NEXT = "a different long passphrase";

type Deps = User | Users | SqlClient.SqlClient;

const layer = UserLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(UsersLayer, AuditLogLayer)),
  Layer.provideMerge(TestDatabase),
);

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(layer), Effect.provideService(PasswordCost, TEST_PASSWORD_PARAMS)),
  );

/**
 * Creates the user with a real hash of {@link CURRENT}, and runs `body` as the
 * actor that `buildActor` returns for the new user's id.
 */
const runAs = <A, E>(buildActor: (userId: string) => Actor, body: Effect.Effect<A, E, Deps>) =>
  run(
    Effect.gen(function* () {
      const users = yield* Users;
      const user = yield* users.create(
        "rogier",
        yield* hashPassword(CURRENT, TEST_PASSWORD_PARAMS),
      );
      return yield* body.pipe(Effect.provideService(CurrentActor, buildActor(user.id)));
    }),
  );

/** Creates the user and runs `body` as that user, signed in with a login token. */
const runAsUser = <A, E>(body: Effect.Effect<A, E, Deps>) =>
  runAs(
    (userId) => ({
      _tag: "user",
      userId,
      credential: { kind: "login", id: userId, tokenHash: "irrelevant" },
    }),
    body,
  );

/** Returns a session actor whose permission profile holds exactly these grants. */
const buildSessionActor = (grants: ReadonlyArray<Grant>): Actor => ({
  _tag: "session",
  sessionId: "0199f0b7-0002-7000-8000-000000000000",
  profileId: "0199f0b7-0003-7000-8000-000000000000",
  grants,
  assistantId: null,
});

describe("user.read", () => {
  it("returns the name of the user the credential belongs to", async () => {
    const answer = await runAsUser(Effect.flatMap(User, (user) => user.read()));

    expect(answer).toEqual({ username: "rogier" });
  });

  it("refuses a caller with no credential", async () => {
    const failure = await run(Effect.flip(Effect.flatMap(User, (user) => user.read())));

    expect(failure).toMatchObject({
      error: { code: "forbidden", details: { grant: "credential.read" } },
    });
  });

  it("refuses a session whose profile lacks credential.read, and names the grant", async () => {
    const failure = await runAs(
      () => buildSessionActor(["task.read"]),
      Effect.flip(Effect.flatMap(User, (user) => user.read())),
    );

    expect(failure).toMatchObject({
      error: {
        code: "forbidden",
        message: "missing grant credential.read",
        details: { grant: "credential.read" },
      },
    });
  });

  it("refuses a session even when its profile holds credential.read, because only the user may call it", async () => {
    const failure = await runAs(
      () => buildSessionActor(["credential.read"]),
      Effect.flip(Effect.flatMap(User, (user) => user.read())),
    );

    expect(failure).toMatchObject({
      error: {
        code: "forbidden",
        message: "only the user may make this call; no grant confers it",
        details: { grant: "credential.read" },
      },
    });
  });
});

describe("user.setPassword", () => {
  it("stores the new password and records the change", async () => {
    const result = await runAsUser(
      Effect.gen(function* () {
        const user = yield* User;
        const users = yield* Users;
        const answer = yield* user.setPassword({ current: CURRENT, next: NEXT });
        const stored = yield* users.findByUsername("rogier");
        const hash = Option.getOrThrow(stored).passwordHash;
        return {
          answer,
          next: yield* verifyPassword(NEXT, hash),
          old: yield* verifyPassword(CURRENT, hash),
          entries: yield* readEventsOfKind("user.passwordChanged"),
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
        const failure = yield* Effect.flip(user.setPassword({ current: "guess", next: NEXT }));
        const stored = yield* users.findByUsername("rogier");
        return {
          failure,
          unchanged: yield* verifyPassword(CURRENT, Option.getOrThrow(stored).passwordHash),
          entries: yield* readEventsOfKind("user.passwordChanged"),
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
