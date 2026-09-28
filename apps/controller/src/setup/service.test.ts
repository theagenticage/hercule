import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { buildHomePaths } from "@hercule/home";
import type { Assistant, Conversation } from "@hercule/contract";
import { AssistantService } from "../assistants";
import { HerculeHome } from "../config";
import { Credentials, CredentialsLayer, hashToken } from "../credentials";
import { TestDatabase } from "../db/testing";
import { AuditLog, AuditLogLayer } from "../events";
import {
  PASSWORD,
  SETUP_TOKEN,
  USERNAME,
  completeSetup,
  get,
  post,
  readErrorBody,
  send,
  withServer,
  type ServerHarness,
} from "../http/testing";
import { buildProviderDefinition, createPluginFixture } from "../plugins/testing";
import { Settings, SettingsLayer } from "../settings";
import { PasswordCost, TEST_PASSWORD_PARAMS, Users, UsersLayer, verifyPassword } from "../users";
import { Setup, SetupLayer } from "./service";

const TOKEN = "a-setup-token";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hercule-setup-"));
  writeFileSync(join(home, "setup-url"), "http://127.0.0.1:4937/setup?token=a-setup-token\n");
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * Stands in for the assistant service. These unit tests cover the user, the
 * token and the setup state; the default assistant needs the provider
 * instances of a booted controller, so the tests over HTTP below cover it.
 */
const AssistantStub = Layer.mock(AssistantService)({
  create: () => Effect.succeed({} as Assistant),
});

type Deps = Setup | Users | Credentials | Settings | AuditLog | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The boot writes this row, so a unit test that does not boot writes it itself.
      yield* sql`INSERT INTO setup_state (singleton, token_hash, completed_at)
                 VALUES (1, ${hashToken(TOKEN)}, NULL)`;
      return yield* effect;
    }).pipe(
      Effect.provide(
        SetupLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              UsersLayer,
              CredentialsLayer,
              SettingsLayer,
              AuditLogLayer,
              AssistantStub,
            ),
          ),
          Layer.provideMerge(TestDatabase),
          Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
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
  it("matches the token the boot created, and nothing else", async () => {
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

  it("returns a working bearer token, so the caller is logged in", async () => {
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
        const users = yield* Users;
        yield* complete;
        const user = yield* users.findByUsername("rogier");
        return yield* settings.getForUser(Option.getOrThrow(user).id, "timezone");
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

  it("fails with validation when the timezone is not an IANA zone name, and writes nothing", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        const setup = yield* Setup;
        const users = yield* Users;
        const failure = yield* Effect.flip(
          setup.complete({
            username: "rogier",
            password: "correct horse battery staple",
            timezone: "Mars/Olympus_Mons",
          }),
        );
        return { failure, user: yield* users.findByUsername("rogier") };
      }),
    );

    expect(outcome.failure).toMatchObject({
      error: { code: "validation", details: { issues: [{ path: ["timezone"] }] } },
    });
    expect(Option.isNone(outcome.user)).toBe(true);
  });

  it("fails a second time with invalid_state, and writes nothing", async () => {
    const outcome = await run(
      Effect.gen(function* () {
        yield* complete;
        return yield* Effect.flip(complete);
      }),
    );

    expect(outcome).toMatchObject({ error: { code: "invalid_state" } });
  });
});

/*
 * The tests below cover the default assistant setup creates. They run the whole
 * controller over HTTP, with three provider instances, because the assistant's
 * defaults come from the provider instances and permission profiles a booted
 * controller has.
 */
const PROVIDERS = [
  buildProviderDefinition("claude-provider", { token: "t" }),
  buildProviderDefinition("codex-provider", { token: "t" }),
  buildProviderDefinition("pi-provider", { token: "t" }),
];

const withProviders = (body: (harness: ServerHarness) => Promise<void>): Promise<void> =>
  withServer(body, {
    plugins: [createPluginFixture({ id: "providers", definitions: PROVIDERS }).plugin],
  });

/** Sends `setup.complete` with the setup token, as the onboarding screen does. */
const requestSetup = (harness: ServerHarness): Promise<Response> =>
  send("POST", harness.base, "/api/v1/setup/complete", {
    body: { username: USERNAME, password: PASSWORD, timezone: "Europe/Amsterdam" },
    token: SETUP_TOKEN,
  });

/** Returns the first page of `assistant.query`. */
const listAssistants = async (
  harness: ServerHarness,
  token: string,
): Promise<ReadonlyArray<Assistant>> => {
  const response = await get(harness.base, "/api/v1/assistants", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Assistant> }).items;
};

/** Counts the rows of one table, straight from the database. */
const countRows = (harness: ServerHarness, table: string): Promise<number> =>
  Effect.runPromise(
    Effect.orDie(
      Effect.map(
        harness.sql<{
          readonly count: number;
        }>`SELECT count(*) AS count FROM ${harness.sql(table)}`,
        (rows) => rows[0]!.count,
      ),
    ),
  );

describe("the default assistant", () => {
  it("is created by setup as Hercule, with the defaults of a name-only create, and its web conversation", async () => {
    await withProviders(async (harness) => {
      const token = await completeSetup(harness.base);

      const assistants = await listAssistants(harness, token);
      expect(assistants.map((assistant) => assistant.name)).toEqual(["Hercule"]);
      const hercule = assistants[0]!;

      // A create from a name alone gets every default, so the default
      // assistant must match it in everything but its identity.
      const response = await post(harness.base, "/api/v1/assistants", { name: "Ada" }, token);
      expect(response.ok, await response.clone().text()).toBe(true);
      const ada = (await response.json()) as Assistant;
      const identity = ["id", "name", "createdAt", "updatedAt"];
      const withoutIdentity = (assistant: Assistant) =>
        Object.fromEntries(Object.entries(assistant).filter(([key]) => !identity.includes(key)));
      expect(withoutIdentity(hercule)).toEqual(withoutIdentity(ada));

      const conversations = await get(
        harness.base,
        `/api/v1/conversations?assistantId=${hercule.id}`,
        token,
      );
      expect(conversations.status, await conversations.clone().text()).toBe(200);
      const items = ((await conversations.json()) as { items: ReadonlyArray<Conversation> }).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        assistantId: hercule.id,
        channel: "web",
        containerKey: null,
      });
    });
  });

  it("is stamped with the new user", async () => {
    await withProviders(async (harness) => {
      await completeSetup(harness.base);

      const created = await harness.audit("assistant.created");
      expect(created.map((entry) => entry.actor)).toEqual(["user"]);
    });
  });

  it("rolls the whole setup back when the assistant cannot be written, and returns the error", async () => {
    await withProviders(async (harness) => {
      // A trigger stands in for any failure of the assistant insert: it makes
      // the real insert fail inside setup's transaction.
      await Effect.runPromise(
        Effect.orDie(
          harness.sql`CREATE TRIGGER fail_assistant_insert BEFORE INSERT ON assistants
                      BEGIN SELECT RAISE(ABORT, 'forced assistant insert failure'); END`,
        ),
      );

      const refused = await requestSetup(harness);
      expect(refused.ok).toBe(false);
      expect((await readErrorBody(refused)).code).toBeTypeOf("string");

      const state = await get(harness.base, "/api/v1/setup");
      expect(await state.json()).toEqual({ complete: false });
      for (const table of ["users", "user_settings", "assistants", "conversations"]) {
        expect(await countRows(harness, table), table).toBe(0);
      }

      // Setup is still open: once the insert can succeed, the same token
      // completes it.
      await Effect.runPromise(Effect.orDie(harness.sql`DROP TRIGGER fail_assistant_insert`));
      const retried = await requestSetup(harness);
      expect(retried.status, await retried.clone().text()).toBe(200);
    });
  });

  it("fails setup with invalid_state when there is no provider instance, and writes nothing", async () => {
    await withProviders(async (harness) => {
      // The boot opens one instance per provider, so the test deletes them
      // all to stand for a build that opened none.
      await Effect.runPromise(Effect.orDie(harness.sql`DELETE FROM provider_instances`));

      const refused = await requestSetup(harness);
      expect(refused.status).toBe(409);
      const error = await readErrorBody(refused);
      expect(error.code).toBe("invalid_state");
      expect(error.message).toContain("add a provider instance first");

      const state = await get(harness.base, "/api/v1/setup");
      expect(await state.json()).toEqual({ complete: false });
      for (const table of ["users", "login_tokens", "assistants", "conversations"]) {
        expect(await countRows(harness, table), table).toBe(0);
      }
    });
  });
});
