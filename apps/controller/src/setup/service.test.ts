import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { homePaths } from "@hydra/home";
import { HydraHome } from "../config";
import { Credentials, CredentialsLayer, hashToken } from "../credentials";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import { Settings, SettingsLayer } from "../settings";
import { PasswordCost, TEST_PASSWORD_PARAMS, Users, UsersLayer, verifyPassword } from "../users";
import { Setup, SetupLayer } from "./service";

const TOKEN = "a-setup-token";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hydra-setup-"));
  writeFileSync(join(home, "setup-url"), "http://127.0.0.1:4937/setup?token=a-setup-token\n");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

type Deps = Setup | Users | Credentials | Settings | AuditLog | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The boot writes this row; a unit test that does not boot writes it too.
      yield* sql`INSERT INTO setup_state (singleton, token_hash, completed_at)
                 VALUES (1, ${hashToken(TOKEN)}, NULL)`;
      return yield* effect;
    }).pipe(
      Effect.provide(
        SetupLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(UsersLayer, CredentialsLayer, SettingsLayer, AuditLogLayer),
          ),
          Layer.provideMerge(TestDatabase),
          Layer.provideMerge(Layer.succeed(HydraHome, homePaths(home, join(home, "data")))),
        ),
      ),
      Effect.provideService(PasswordCost, TEST_PASSWORD_PARAMS),
    ),
  );

const complete = Effect.gen(function* () {
  const setup = yield* Setup;
  return yield* setup.complete({
    username: "rogier",
    password: "correct horse battery staple",
    timezone: "Europe/Amsterdam",
  });
});

describe("setup.read", () => {
  it("is false until setup completes, and true afterwards", async () => {
    const states = await run(
      Effect.gen(function* () {
        const setup = yield* Setup;
        const before = yield* setup.state();
        yield* complete;
        return { before, after: yield* setup.state() };
      }),
    );

    expect(states.before).toEqual({ complete: false });
    expect(states.after).toEqual({ complete: true });
  });
});

describe("the setup token", () => {
  it("matches the one the boot minted, and nothing else", async () => {
    const matches = await run(
      Effect.gen(function* () {
        const setup = yield* Setup;
        return {
          right: yield* setup.matchesToken(TOKEN),
          wrong: yield* setup.matchesToken("not-the-token"),
        };
      }),
    );

    expect(matches).toEqual({ right: true, wrong: false });
  });

  it("stops matching once setup is complete, so it is single use", async () => {
    const after = await run(
      Effect.gen(function* () {
        const setup = yield* Setup;
        yield* complete;
        return yield* setup.matchesToken(TOKEN);
      }),
    );

    expect(after).toBe(false);
  });
});

describe("setup.complete", () => {
  it("creates the user with an argon2id hash of the password", async () => {
    const user = await run(
      Effect.gen(function* () {
        const users = yield* Users;
        yield* complete;
        return yield* users.findByUsername("rogier");
      }),
    );

    expect(Option.isSome(user)).toBe(true);
    const found = Option.getOrThrow(user);
    expect(found.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(
      Effect.runPromise(verifyPassword("correct horse battery staple", found.passwordHash)),
    ).resolves.toBe(true);
  });

  it("returns a bearer token that resolves: the caller is logged in", async () => {
    const resolved = await run(
      Effect.gen(function* () {
        const credentials = yield* Credentials;
        const { token } = yield* complete;
        return yield* credentials.findLoginToken(hashToken(token));
      }),
    );

    expect(Option.isSome(resolved)).toBe(true);
  });

  it("writes the timezone the onboarding screen collected", async () => {
    const timezone = await run(
      Effect.gen(function* () {
        const settings = yield* Settings;
        yield* complete;
        return yield* settings.get("user", "timezone");
      }),
    );

    expect(timezone).toBe("Europe/Amsterdam");
  });

  it("clears the token hash, so the URL cannot be replayed", async () => {
    const rows = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* complete;
        return yield* sql<{
          readonly token_hash: string | null;
        }>`SELECT token_hash FROM setup_state WHERE singleton = 1`;
      }),
    );

    expect(rows[0]?.token_hash).toBeNull();
  });

  it("deletes <home>/setup-url, because setup is no longer outstanding", async () => {
    await run(complete);
    expect(existsSync(join(home, "setup-url"))).toBe(false);
  });

  it("refuses a second time with invalid_state, and writes nothing", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* complete;
        return yield* Effect.flip(complete);
      }),
    );

    expect(outcome).toMatchObject({ error: { code: "invalid_state" } });
  });
});
