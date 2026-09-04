import { describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { CurrentActor, type Actor } from "../actor";
import { Credentials, CredentialsLayer, hashToken } from "../credentials";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { hashPassword, TEST_PASSWORD_PARAMS, Users, UsersLayer } from "../users";
import { Auth, AuthLayer } from "./service";

const PASSWORD = "correct horse battery staple";

type Deps = Auth | Users | Credentials | AuditLog | SqlClient.SqlClient;

const layer = AuthLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(UsersLayer, CredentialsLayer, AuditLogLayer)),
  Layer.provideMerge(TestDatabase),
);

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

/** Every test starts with the one user, hashed at the reduced test cost. */
const withUser = Effect.gen(function* () {
  const users = yield* Users;
  return yield* users.create("rogier", yield* hashPassword(PASSWORD, TEST_PASSWORD_PARAMS));
});

const asLogin = (tokenHash: string): Actor => ({
  _tag: "user",
  userId: "0199f0b7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199f0b7-0001-7000-8000-000000000000", tokenHash },
});

describe("auth.login", () => {
  it("hands back a bearer token that resolves, expiring 30 days out", async () => {
    const result = await run(
      Effect.gen(function* () {
        const auth = yield* Auth;
        const credentials = yield* Credentials;
        yield* withUser;
        const login = yield* auth.login({ username: "rogier", password: PASSWORD });
        const record = yield* credentials.findLoginToken(hashToken(login.token));
        return { login, resolved: Option.isSome(record) };
      }),
    );

    expect(result.resolved).toBe(true);
    const lifetime = Date.parse(result.login.expiresAt) - Date.now();
    expect(lifetime).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(lifetime).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
  });

  it("says the same thing about a wrong password and a username nobody has", async () => {
    const [wrongPassword, noSuchUser] = await run(
      Effect.gen(function* () {
        const auth = yield* Auth;
        yield* withUser;
        return [
          yield* Effect.flip(auth.login({ username: "rogier", password: "guess" })),
          yield* Effect.flip(auth.login({ username: "nobody", password: PASSWORD })),
        ] as const;
      }),
    );

    expect(wrongPassword).toMatchObject({ error: { code: "unauthenticated" } });
    expect(JSON.stringify(noSuchUser)).toEqual(JSON.stringify(wrongPassword));
  });

  it("stamps the failed attempt with no actor, because nobody was authenticated", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const auth = yield* Auth;
        const log = yield* AuditLog;
        yield* withUser;
        yield* Effect.flip(auth.login({ username: "rogier", password: "guess" }));
        yield* Effect.flip(auth.login({ username: "nobody", password: PASSWORD }));
        return yield* log.listByKind("auth.login.failed");
      }),
    );

    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.actor).toBeNull();
    expect(rows.map((row) => row.actor)).not.toContain("user");
  });

  it("still answers a wrong password 401 when the attempt cannot be logged", async () => {
    const error = await run(
      Effect.gen(function* () {
        const auth = yield* Auth;
        const sql = yield* SqlClient.SqlClient;
        yield* withUser;
        // The one store the failed-login path writes to, taken away under it.
        yield* sql`DROP TABLE events`;
        return yield* Effect.flip(auth.login({ username: "rogier", password: "guess" }));
      }),
    );

    expect(error).toMatchObject({ error: { code: "unauthenticated" } });
  });

  it("verifies a password even when the username does not exist, so login is no oracle", async () => {
    // The absent-user path runs argon2id at production cost; a lookup that
    // short-circuited would answer in well under a millisecond.
    const started = performance.now();
    await run(
      Effect.gen(function* () {
        const auth = yield* Auth;
        return yield* Effect.flip(auth.login({ username: "nobody", password: PASSWORD }));
      }),
    );
    expect(performance.now() - started).toBeGreaterThan(5);
  });
});

describe("auth.logout", () => {
  it("revokes the login token the call was made with", async () => {
    const resolved = await run(
      Effect.gen(function* () {
        const auth = yield* Auth;
        const credentials = yield* Credentials;
        const user = yield* withUser;
        const login = yield* auth.login({ username: "rogier", password: PASSWORD });
        const tokenHash = hashToken(login.token);
        expect(user.username).toBe("rogier");

        yield* auth.logout().pipe(Effect.provideService(CurrentActor, asLogin(tokenHash)));
        return yield* credentials.findLoginToken(tokenHash);
      }),
    );

    expect(Option.isNone(resolved)).toBe(true);
  });

  it("refuses an API key: revoking one of those is apiKey.revoke", async () => {
    const failure = await run(
      Effect.gen(function* () {
        const auth = yield* Auth;
        const actor: Actor = {
          _tag: "user",
          userId: "0199f0b7-0000-7000-8000-000000000000",
          credential: {
            kind: "apiKey",
            id: "0199f0b7-0002-7000-8000-000000000000",
            tokenHash: "x",
          },
        };
        return yield* Effect.flip(auth.logout().pipe(Effect.provideService(CurrentActor, actor)));
      }),
    );

    expect(failure).toMatchObject({ error: { code: "validation" } });
  });
});
