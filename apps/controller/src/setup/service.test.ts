import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { buildHomePaths } from "@hercule/home";
import type { Assistant, Conversation } from "@hercule/contract";
import type { Plugin } from "@hercule/plugin-host";
import { AssistantService } from "../assistants";
import { withTransaction } from "../db";
import { HerculeHome } from "../config";
import {
  buildHarnessDefinition,
  buildProviderDefinition,
  createPluginFixture,
} from "../plugins/testing";
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
 * accounts of a booted controller, so the tests over HTTP below cover it.
 */
const AssistantStub = Layer.mock(AssistantService)({
  createDefaultIfNone: () => Effect.void,
});

type Deps = Setup | Users | Credentials | Settings | AuditLog | SqlClient.SqlClient;

const run = <A, E>(effect: Effect.Effect<A, E, Deps>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // The boot writes this row, so a unit test that does not boot writes it itself.
      yield* withTransaction(
        sql,
        sql`INSERT INTO setup_state (singleton, token_hash, completed_at)
            VALUES (1, ${hashToken(TOKEN)}, NULL)`,
      );
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
 * controller over HTTP, with a Provider Account, because the assistant's
 * defaults come from the Provider Accounts and permission profiles a booted
 * controller has.
 */
const withProviders = (body: (harness: ServerHarness) => Promise<void>): Promise<void> =>
  withServer(body);

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

/** Deletes the account the test controller opens, to stand for a fresh install with none. */
const deleteAllProviderAccounts = (harness: ServerHarness): Promise<void> =>
  Effect.runPromise(
    Effect.orDie(withTransaction(harness.sql, harness.sql`DELETE FROM provider_accounts`)),
  ).then(() => undefined);

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
      const identity = ["id", "name", "mainConversationId", "createdAt", "updatedAt"];
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
      expect(hercule.mainConversationId).toBe(items[0]!.id);
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
          withTransaction(
            harness.sql,
            harness.sql`CREATE TRIGGER fail_assistant_insert BEFORE INSERT ON assistants
                        BEGIN SELECT RAISE(ABORT, 'forced assistant insert failure'); END`,
          ),
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
      await Effect.runPromise(
        Effect.orDie(withTransaction(harness.sql, harness.sql`DROP TRIGGER fail_assistant_insert`)),
      );
      const retried = await requestSetup(harness);
      expect(retried.status, await retried.clone().text()).toBe(200);
    });
  });

  it("is not created when there is no provider account, and setup still completes", async () => {
    await withProviders(async (harness) => {
      await deleteAllProviderAccounts(harness);

      const token = await completeSetup(harness.base);

      expect(await listAssistants(harness, token)).toEqual([]);
      expect(await countRows(harness, "users")).toBe(1);
      expect(await (await get(harness.base, "/api/v1/setup")).json()).toEqual({ complete: true });
    });
  });
});

/*
 * A fresh install has no Provider Account, so setup finishes without the
 * default assistant, and the first account that is ready makes it: an account
 * that comes with a key is ready when it is created.
 */
describe("the default assistant of the first provider account", () => {
  const KEYED_HARNESS_ID = "keyed/keyed";

  /**
   * A provider with two kinds, a key and a subscription that signs in, both
   * run by one harness. The test provider every other test uses has only the
   * subscription kind.
   */
  const keyedPlugins: ReadonlyArray<Plugin> = [
    createPluginFixture({
      id: "keyed",
      capabilities: ["harnesses", "providers"],
      definitions: [
        buildHarnessDefinition("keyed", [
          {
            providerId: "keyed/keyed",
            kinds: [
              { kind: "api-key", credentialVariable: "KEYED_API_KEY" },
              { kind: "signed-in" },
            ],
            modelArgument: "{model}",
            models: "all",
          },
        ]),
      ],
      providers: [
        {
          ...buildProviderDefinition("keyed", [KEYED_HARNESS_ID]),
          kinds: [
            ...buildProviderDefinition("keyed", [KEYED_HARNESS_ID]).kinds,
            {
              id: "signed-in",
              title: "Subscription",
              description: "A plan signed in on each machine.",
              setup: [{ kind: "harness-login", method: "sign-in" }],
              harnesses: [KEYED_HARNESS_ID],
            },
          ],
        },
      ],
    }).plugin,
  ];

  const withKeyedProvider = (body: (harness: ServerHarness) => Promise<void>): Promise<void> =>
    withServer(body, { plugins: keyedPlugins });

  /** Deletes the account the test controller opens, then completes setup, as on a fresh install. */
  const setUpWithoutAccount = async (harness: ServerHarness): Promise<string> => {
    await deleteAllProviderAccounts(harness);
    return completeSetup(harness.base);
  };

  /** Creates an account of the key kind, which is ready as soon as it is created. */
  const createAccount = (harness: ServerHarness, token: string, label?: string) =>
    post(
      harness.base,
      "/api/v1/provider-accounts",
      {
        providerId: "keyed/keyed",
        kind: "api-key",
        credentials: { apiKey: "sk-test" },
        ...(label === undefined ? {} : { label }),
      },
      token,
    );

  it("is not created by the create of an account that signs in, which is not ready yet", async () => {
    await withKeyedProvider(async (harness) => {
      const token = await setUpWithoutAccount(harness);

      const created = await post(
        harness.base,
        "/api/v1/provider-accounts",
        { providerId: "keyed/keyed", kind: "signed-in" },
        token,
      );

      expect(created.status, await created.clone().text()).toBe(200);
      expect(await listAssistants(harness, token)).toEqual([]);
    });
  });

  it("is created as Hercule, on that account, by the create of the first account", async () => {
    await withKeyedProvider(async (harness) => {
      const token = await setUpWithoutAccount(harness);

      const created = await createAccount(harness, token);
      expect(created.status, await created.clone().text()).toBe(200);
      const account = (await created.json()) as { readonly id: string };

      const assistants = await listAssistants(harness, token);
      expect(assistants.map((assistant) => assistant.name)).toEqual(["Hercule"]);
      expect(assistants[0]!.providerAccountId).toBe(account.id);
      expect((await harness.audit("assistant.created")).map((entry) => entry.actor)).toEqual([
        "user",
      ]);
    });
  });

  it("is not created again by a second account", async () => {
    await withKeyedProvider(async (harness) => {
      const token = await setUpWithoutAccount(harness);
      expect((await createAccount(harness, token)).status).toBe(200);

      const second = await createAccount(harness, token, "work");
      expect(second.status, await second.clone().text()).toBe(200);

      expect(await listAssistants(harness, token)).toHaveLength(1);
    });
  });

  it("is not created when an assistant exists already", async () => {
    await withKeyedProvider(async (harness) => {
      // The test controller opens an account, so setup creates Hercule; the
      // user deletes it, and the assistant with it, then adds a second account.
      const token = await completeSetup(harness.base);
      const [hercule] = await listAssistants(harness, token);
      const other = await post(harness.base, "/api/v1/assistants", { name: "Ada" }, token);
      expect(other.ok).toBe(true);
      expect(
        (await send("DELETE", harness.base, `/api/v1/assistants/${hercule!.id}`, { token })).ok,
      ).toBe(true);

      const created = await createAccount(harness, token, "work");
      expect(created.status, await created.clone().text()).toBe(200);

      expect((await listAssistants(harness, token)).map((assistant) => assistant.name)).toEqual([
        "Ada",
      ]);
    });
  });

  it("is created once when two first sign-ins finish together", async () => {
    await withKeyedProvider(async (harness) => {
      const token = await setUpWithoutAccount(harness);
      // Two accounts that sign in: neither is ready at creation, so no
      // assistant exists until a sign-in finishes.
      for (const label of ["one", "two"]) {
        const created = await post(
          harness.base,
          "/api/v1/provider-accounts",
          { providerId: "keyed/keyed", kind: "signed-in", label },
          token,
        );
        expect(created.status, await created.clone().text()).toBe(200);
      }
      expect(await listAssistants(harness, token)).toEqual([]);

      // A write in progress holds the writer while both completions start, so
      // each one reaches its check before either one has created anything.
      const writing = harness.runWithLiveSessions(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          withTransaction(sql, Effect.sleep("150 millis")),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
      const exits = await Promise.all([
        harness.runWithLiveSessions(
          Effect.flatMap(AssistantService, (assistants) => assistants.createDefaultIfNone()),
        ),
        harness.runWithLiveSessions(
          Effect.flatMap(AssistantService, (assistants) => assistants.createDefaultIfNone()),
        ),
      ]);

      await writing;
      expect(exits.map((exit) => exit._tag)).toEqual(["Success", "Success"]);
      expect(await listAssistants(harness, token)).toHaveLength(1);
    });
  });

  it("rolls the account back when the assistant cannot be written", async () => {
    await withKeyedProvider(async (harness) => {
      const token = await setUpWithoutAccount(harness);
      await Effect.runPromise(
        Effect.orDie(
          withTransaction(
            harness.sql,
            harness.sql`CREATE TRIGGER fail_assistant_insert BEFORE INSERT ON assistants
                        BEGIN SELECT RAISE(ABORT, 'forced assistant insert failure'); END`,
          ),
        ),
      );

      const refused = await createAccount(harness, token);
      expect(refused.ok).toBe(false);

      expect(await countRows(harness, "provider_accounts")).toBe(0);
      expect(await countRows(harness, "assistants")).toBe(0);
      expect(await harness.audit("providerAccount.created")).toEqual([]);

      // Once the insert can succeed, the same create works.
      await Effect.runPromise(
        Effect.orDie(withTransaction(harness.sql, harness.sql`DROP TRIGGER fail_assistant_insert`)),
      );
      expect((await createAccount(harness, token)).status).toBe(200);
      expect(await listAssistants(harness, token)).toHaveLength(1);
    });
  });
});
