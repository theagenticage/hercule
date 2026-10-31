/**
 * Tests what the provider accounts migration does to rows written by the
 * previous head: every Provider Instance becomes a Provider Account with the
 * same id, and every row that pointed at an instance points at the account,
 * with the harness the instance ran.
 *
 * The tests stop at this migration, so a later migration cannot change what
 * they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import { decryptSecretValue, encryptSecretValue, type Bytes } from "../../secrets/cipher";
import { uuidToString } from "../id";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 95);

/** The migrations up to and including the one under test. */
const UP_TO_PROVIDER_ACCOUNTS = migrations.filter(([id]) => id <= 95);

const CLAUDE_CODE = "claude-code/claude-code";
const CODEX = "codex/codex";
const PI = "pi/pi";

/** The ids of the rows a test writes, as the bytes a table stores. */
const bytes = (fill: number): Uint8Array => new Uint8Array(16).fill(fill);

/** The `n`th minute of a day, so that rows sort by age in the order a test lists them. */
const minute = (n: number): string => `2026-10-01T00:${String(n).padStart(2, "0")}:00.000Z`;

const RUNNER_A = bytes(0xa1);
const RUNNER_B = bytes(0xa2);

/** One instance to arrange: its id fill, harness and name. They are created one minute apart, in this order. */
interface Instance {
  readonly fill: number;
  readonly harnessId: string;
  readonly name: string;
}

/** The ids of the instances the main scenario creates. */
const PI_FIRST = 1;
const PI_SECOND = 2;
const PI_THIRD = 3;
const CLAUDE_DEFAULT = 4;
const CLAUDE_WORK = 5;
const CLAUDE_WORK_AGAIN = 6;
const CLAUDE_OTHER = 7;
const CODEX_DEFAULT = 8;
const CODEX_WORK = 9;
/** An id no instance has: the instance was deleted before the migration. */
const DELETED_INSTANCE = 0x40;

const SCENARIO: ReadonlyArray<Instance> = [
  { fill: PI_FIRST, harnessId: PI, name: "pi" },
  { fill: PI_SECOND, harnessId: PI, name: "pi" },
  { fill: PI_THIRD, harnessId: PI, name: "pi" },
  { fill: CLAUDE_DEFAULT, harnessId: CLAUDE_CODE, name: "Claude Code" },
  { fill: CLAUDE_WORK, harnessId: CLAUDE_CODE, name: "work" },
  { fill: CLAUDE_WORK_AGAIN, harnessId: CLAUDE_CODE, name: "work" },
  { fill: CLAUDE_OTHER, harnessId: CLAUDE_CODE, name: "Claude Code" },
  { fill: CODEX_DEFAULT, harnessId: CODEX, name: "Codex" },
  { fill: CODEX_WORK, harnessId: CODEX, name: "work" },
];

const insertInstances = (
  instances: ReadonlyArray<Instance>,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* Effect.forEach(
      instances,
      (instance, index) =>
        sql`INSERT INTO provider_instances (id, provider_id, name, config, created_at, updated_at)
            VALUES (${bytes(instance.fill)}, ${instance.harnessId}, ${instance.name}, '{}',
                    ${minute(index)}, ${minute(index + 30)})`,
      { discard: true },
    );
  });

const insertRunners = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Effect.forEach(
    [RUNNER_A, RUNNER_B],
    (id, index) =>
      sql`INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                               credential_hash, created_at, updated_at)
          VALUES (${id}, ${`runner-${index}`}, 'offline', 'active', 0, '[]',
                  ${`hash-${index}`}, ${minute(0)}, ${minute(0)})`,
    { discard: true },
  );
});

/** What a runner's last probe of an instance reported: who is signed in, and on which plan. */
const insertSnapshot = (
  instance: number,
  runner: Uint8Array,
  probedAt: string,
  identity: string | null,
  plan: string | null,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO capability_snapshots
                 (instance_id, runner_id, probed_at, harness_version, auth_status, auth_identity,
                  auth_plan_label, models)
               VALUES (${bytes(instance)}, ${runner}, ${probedAt}, '1.2.3',
                       ${identity === null ? "unauthenticated" : "ok"}, ${identity}, ${plan},
                       '[{"id":"m"}]')`;
  });

const SESSION_ON_CLAUDE = bytes(0x51);
const SESSION_ON_DELETED = bytes(0x52);
const AGENT_ON_CODEX = bytes(0x61);
const AGENT_ON_DELETED = bytes(0x62);

/** A stored session spec as the previous head wrote it. */
const specOf = (instance: number): string =>
  JSON.stringify({
    instanceId: uuidToString(bytes(instance)),
    workspaceId: null,
    modelSelection: { model: "haiku" },
    accessMode: "auto",
    systemPrompt: "Be brief.",
  });

const insertSessionsAndAgents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [session, instance, status] of [
    [SESSION_ON_CLAUDE, CLAUDE_DEFAULT, "exited"],
    [SESSION_ON_DELETED, DELETED_INSTANCE, "exited"],
  ] as const) {
    yield* sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                     requested_access_mode, access_mode, spec, title, status,
                                     native_session_id, created_at, last_activity_at)
               VALUES (${session}, x'00', ${bytes(instance)}, ${RUNNER_A}, 'auto', 'auto',
                       ${specOf(instance)}, 'a session', ${status}, 'native-1', ${minute(1)},
                       ${minute(2)})`;
  }
  for (const [agent, instance, kind] of [
    [AGENT_ON_CODEX, CODEX_DEFAULT, "agent"],
    [AGENT_ON_DELETED, DELETED_INSTANCE, "assistant"],
  ] as const) {
    yield* sql`INSERT INTO agents (id, name, system_prompt, instance_id, permission_profile_id,
                                   access_mode, disallowed_tools, kind, created_at, updated_at)
               VALUES (${agent}, 'an agent', 'Prompt.', ${bytes(instance)}, x'00', 'auto', '[]',
                       ${kind}, ${minute(1)}, ${minute(1)})`;
  }
});

/** A fresh Master Key, as the boot opens it. */
const makeMasterKey = (): Promise<CryptoKey> =>
  crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);

/** Stores a secret the way the previous head did, under the instance's owner kind. */
const insertSecret = (
  key: CryptoKey,
  secret: {
    readonly fill: number;
    readonly ownerKind: "provider-instance" | "connection";
    readonly ownerId: string;
    readonly name: string;
    readonly value: string;
  },
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sealed = yield* encryptSecretValue(
      key,
      { kind: secret.ownerKind, id: secret.ownerId },
      secret.name,
      secret.value,
    );
    yield* sql`INSERT INTO secrets (id, owner_kind, owner_id, name, nonce, ciphertext, created_at,
                                    rotated_at)
               VALUES (${bytes(secret.fill)}, ${secret.ownerKind}, ${secret.ownerId}, ${secret.name},
                       ${sealed.nonce}, ${sealed.ciphertext}, ${minute(3)}, ${minute(4)})`;
  });

const PI_SECRET_ID = 0x71;
const CONNECTION_SECRET_ID = 0x72;

/**
 * Checks that a migration run failed because the migration refused the
 * database on purpose, and that its message contains `fragment`. The boot
 * prints the cause's message only when the cause is an `Error`.
 */
const expectRefusal = (
  result: Result.Result<unknown, { readonly cause?: unknown }>,
  fragment: string,
): void => {
  const cause = Result.isFailure(result) ? result.failure.cause : undefined;
  expect(cause).toBeInstanceOf(Error);
  expect(cause).toHaveProperty("_tag", "ProviderAccountMigrationError");
  expect((cause as Error).message).toContain(fragment);
};

/** Parses JSON text a row stored. */
const parseJson = (text: string): unknown => JSON.parse(text);

/** Runs an effect against a fresh temporary database. Rejects with any defect. */
const runOnFreshDatabase = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(TestDatabaseWriter), Effect.orDie));

interface AccountRow {
  readonly id: Uint8Array;
  readonly provider_id: string;
  readonly kind: string;
  readonly label: string | null;
  readonly identity: string | null;
  readonly plan_label: string | null;
  readonly default_harness_id: string;
  readonly legacy_home_folder: string | null;
  readonly legacy_home_harness_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Reads every account, in the order they were created, keyed by the id fill they were given. */
const readAccounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<AccountRow>`SELECT * FROM provider_accounts ORDER BY created_at`;
  return new Map(rows.map((row) => [row.id[0]!, row]));
});

/** Arranges the main scenario at the previous head, with no snapshots, sessions or secrets. */
const arrangeInstances = Effect.gen(function* () {
  yield* runMigrations(BEFORE);
  yield* insertRunners;
  yield* insertInstances(SCENARIO);
});

describe("the provider accounts migration", () => {
  describe("accounts", () => {
    it("turns each instance into an account with the same id, the provider of its harness and its timestamps", async () => {
      const accounts = await runOnFreshDatabase(
        Effect.gen(function* () {
          yield* arrangeInstances;
          yield* runMigrations();
          return yield* readAccounts;
        }),
      );

      expect([...accounts.keys()]).toEqual(SCENARIO.map((instance) => instance.fill));
      const claude = accounts.get(CLAUDE_DEFAULT)!;
      expect(claude).toMatchObject({
        provider_id: "anthropic/anthropic",
        kind: "subscription-per-machine",
        default_harness_id: CLAUDE_CODE,
        legacy_home_folder: uuidToString(bytes(CLAUDE_DEFAULT)),
        legacy_home_harness_id: CLAUDE_CODE,
        created_at: minute(3),
        updated_at: minute(33),
      });
      expect(accounts.get(CODEX_DEFAULT)).toMatchObject({
        provider_id: "openai/openai",
        kind: "subscription-per-machine",
        default_harness_id: CODEX,
        legacy_home_harness_id: CODEX,
      });
      expect(accounts.get(PI_FIRST)).toMatchObject({
        provider_id: "zai/zai",
        kind: "api-key",
        default_harness_id: PI,
        legacy_home_harness_id: PI,
      });
    });

    it("labels an account by the name the user typed, and leaves a harness-named instance without one", async () => {
      const accounts = await runOnFreshDatabase(
        Effect.gen(function* () {
          yield* arrangeInstances;
          yield* runMigrations();
          return yield* readAccounts;
        }),
      );

      const labels = Object.fromEntries(
        [...accounts].map(([fill, account]) => [fill, account.label]),
      );
      expect(labels).toEqual({
        // Z.ai: "pi", "pi", "pi". The first has no label, the later ones take their instance's
        // name, and the third adds a number because "pi" is taken.
        [PI_FIRST]: null,
        [PI_SECOND]: "pi",
        [PI_THIRD]: "pi 2",
        // Anthropic: "Claude Code", "work", "work", "Claude Code".
        [CLAUDE_DEFAULT]: null,
        [CLAUDE_WORK]: "work",
        [CLAUDE_WORK_AGAIN]: "work 2",
        [CLAUDE_OTHER]: "Claude Code",
        // OpenAI: "Codex", "work". Labels are unique per provider, not across providers.
        [CODEX_DEFAULT]: null,
        [CODEX_WORK]: "work",
      });
    });

    it("keeps a label within its limit when it adds a number", async () => {
      const longName = "x".repeat(128);
      const labels = await runOnFreshDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations(BEFORE);
          yield* insertInstances([
            { fill: 1, harnessId: CODEX, name: longName },
            { fill: 2, harnessId: CODEX, name: longName },
          ]);
          yield* runMigrations();
          return yield* sql<{ readonly label: string }>`
            SELECT label FROM provider_accounts ORDER BY created_at`;
        }),
      );

      expect(labels.map((row) => row.label)).toEqual([longName, `${"x".repeat(126)} 2`]);
    });

    it("refuses two accounts of one provider with the same label, or both without, and allows one without", async () => {
      const outcomes = await runOnFreshDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* arrangeInstances;
          yield* runMigrations();
          const insert = (id: number, provider: string, label: string | null) =>
            Effect.result(
              sql`INSERT INTO provider_accounts
                    (id, provider_id, kind, label, default_harness_id, created_at, updated_at)
                  VALUES (${bytes(id)}, ${provider}, 'api-key', ${label}, ${PI}, ${minute(1)},
                          ${minute(1)})`,
            );
          return {
            sameLabel: yield* insert(0x91, "anthropic/anthropic", "work"),
            noLabelTwice: yield* insert(0x92, "anthropic/anthropic", null),
            otherProvider: yield* insert(0x93, "minimax/minimax", "work"),
            emptyLabel: yield* insert(0x94, "minimax/minimax", ""),
          };
        }),
      );

      expect(Result.isFailure(outcomes.sameLabel)).toBe(true);
      expect(Result.isFailure(outcomes.noLabelTwice)).toBe(true);
      expect(Result.isSuccess(outcomes.otherProvider)).toBe(true);
      expect(Result.isFailure(outcomes.emptyLabel)).toBe(true);
    });

    it("takes the identity when every snapshot that reports one agrees, with the plan of the latest probe", async () => {
      const accounts = await runOnFreshDatabase(
        Effect.gen(function* () {
          yield* arrangeInstances;
          // Both runners name the same person; the later probe says the plan is now Max.
          yield* insertSnapshot(CLAUDE_DEFAULT, RUNNER_A, minute(10), "ada@example.com", "Pro");
          yield* insertSnapshot(CLAUDE_DEFAULT, RUNNER_B, minute(20), "ada@example.com", "Max");
          // One runner reports a person and the other is signed out: only one person is named.
          yield* insertSnapshot(CODEX_DEFAULT, RUNNER_A, minute(10), "cy@example.com", "Plus");
          yield* insertSnapshot(CODEX_DEFAULT, RUNNER_B, minute(20), null, null);
          // Two runners name two people.
          yield* insertSnapshot(CLAUDE_WORK, RUNNER_A, minute(10), "ada@example.com", "Pro");
          yield* insertSnapshot(CLAUDE_WORK, RUNNER_B, minute(20), "bob@example.com", "Pro");
          // Nobody is signed in anywhere.
          yield* insertSnapshot(PI_FIRST, RUNNER_A, minute(10), null, null);
          yield* runMigrations();
          return yield* readAccounts;
        }),
      );

      const who = (fill: number) => [accounts.get(fill)!.identity, accounts.get(fill)!.plan_label];
      expect(who(CLAUDE_DEFAULT)).toEqual(["ada@example.com", "Max"]);
      expect(who(CODEX_DEFAULT)).toEqual(["cy@example.com", "Plus"]);
      expect(who(CLAUDE_WORK)).toEqual([null, null]);
      expect(who(PI_FIRST)).toEqual([null, null]);
      expect(who(CODEX_WORK)).toEqual([null, null]);
    });

    it("drops the instance table", async () => {
      const tables = await runOnFreshDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* arrangeInstances;
          yield* runMigrations();
          return yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master WHERE name IN ('provider_instances', 'provider_accounts')`;
        }),
      );

      expect(tables.map((row) => row.name)).toEqual(["provider_accounts"]);
    });

    it("refuses an instance of a harness it has no provider for, and changes nothing", async () => {
      const { refusal, version, instances } = await runOnFreshDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations(BEFORE);
          yield* insertInstances([{ fill: 1, harnessId: "future/harness", name: "odd" }]);
          const refusal = yield* Effect.result(runMigrations(UP_TO_PROVIDER_ACCOUNTS));
          const [version] = yield* sql<{ readonly version: number }>`
            SELECT max(migration_id) AS version FROM effect_sql_migrations`;
          const instances = yield* sql`SELECT id FROM provider_instances`;
          return { refusal, version, instances };
        }),
      );

      expectRefusal(refusal, 'runs the harness "future/harness"');
      expect(version?.version).toBe(94);
      expect(instances).toHaveLength(1);
    });
  });

  describe("snapshots", () => {
    it("keys each snapshot by account, harness and runner, and keeps what it reported", async () => {
      const snapshots = await runOnFreshDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* arrangeInstances;
          yield* insertSnapshot(CLAUDE_DEFAULT, RUNNER_A, minute(10), "ada@example.com", "Pro");
          yield* insertSnapshot(CODEX_DEFAULT, RUNNER_B, minute(11), null, null);
          yield* runMigrations();
          return yield* sql<{
            readonly provider_account_id: Uint8Array;
            readonly harness_id: string;
            readonly runner_id: Uint8Array;
            readonly probed_at: string;
            readonly harness_version: string;
            readonly auth_status: string;
            readonly auth_identity: string | null;
            readonly models: string;
          }>`SELECT * FROM capability_snapshots ORDER BY probed_at`;
        }),
      );

      expect(
        snapshots.map((row) => [row.provider_account_id[0], row.harness_id, row.runner_id[0]]),
      ).toEqual([
        [CLAUDE_DEFAULT, CLAUDE_CODE, RUNNER_A[0]],
        [CODEX_DEFAULT, CODEX, RUNNER_B[0]],
      ]);
      expect(snapshots[0]).toMatchObject({
        probed_at: minute(10),
        harness_version: "1.2.3",
        auth_status: "ok",
        auth_identity: "ada@example.com",
        models: '[{"id":"m"}]',
      });
    });

    it("deletes an account's snapshots with the account", async () => {
      const remaining = await runOnFreshDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* arrangeInstances;
          yield* insertSnapshot(CLAUDE_DEFAULT, RUNNER_A, minute(10), null, null);
          yield* insertSnapshot(CODEX_DEFAULT, RUNNER_A, minute(10), null, null);
          yield* runMigrations();
          yield* sql`DELETE FROM provider_accounts WHERE id = ${bytes(CLAUDE_DEFAULT)}`;
          return yield* sql<{ readonly harness_id: string }>`
            SELECT harness_id FROM capability_snapshots`;
        }),
      );

      expect(remaining.map((row) => row.harness_id)).toEqual([CODEX]);
    });
  });

  describe("sessions and agents", () => {
    it("points a session at its account and the harness it ran, and rewrites the instance id in its spec", async () => {
      const sessions = await runOnFreshDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* arrangeInstances;
          yield* insertSessionsAndAgents;
          yield* runMigrations();
          return yield* sql<{
            readonly id: Uint8Array;
            readonly provider_account_id: Uint8Array;
            readonly harness_id: string;
            readonly spec: string;
            readonly status: string;
            readonly native_session_id: string;
            readonly title: string;
          }>`SELECT id, provider_account_id, harness_id, spec, status, native_session_id, title
             FROM sessions ORDER BY id`;
        }),
      );

      const [onClaude, onDeleted] = sessions;
      expect(onClaude).toMatchObject({
        provider_account_id: bytes(CLAUDE_DEFAULT),
        harness_id: CLAUDE_CODE,
        status: "exited",
        native_session_id: "native-1",
        title: "a session",
      });
      expect(parseJson(onClaude!.spec)).toEqual({
        providerAccountId: uuidToString(bytes(CLAUDE_DEFAULT)),
        workspaceId: null,
        modelSelection: { model: "haiku" },
        accessMode: "auto",
        systemPrompt: "Be brief.",
      });
      // The instance was deleted before the migration, so the harness is unknown. The row
      // survives with its account id, which now names an account that does not exist.
      expect(onDeleted).toMatchObject({
        provider_account_id: bytes(DELETED_INSTANCE),
        harness_id: "unknown",
        status: "exited",
      });
      expect(parseJson(onDeleted!.spec)).toMatchObject({
        providerAccountId: uuidToString(bytes(DELETED_INSTANCE)),
      });
    });

    it("lets an account be deleted while its sessions stay", async () => {
      const sessions = await runOnFreshDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* arrangeInstances;
          yield* insertSessionsAndAgents;
          yield* runMigrations();
          yield* sql`DELETE FROM provider_accounts WHERE id = ${bytes(CLAUDE_DEFAULT)}`;
          return yield* sql<{ readonly id: Uint8Array }>`SELECT id FROM sessions`;
        }),
      );

      expect(sessions).toHaveLength(2);
    });

    it("points an agent or assistant at its account and harness", async () => {
      const agents = await runOnFreshDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* arrangeInstances;
          yield* insertSessionsAndAgents;
          yield* runMigrations();
          return yield* sql<{
            readonly provider_account_id: Uint8Array;
            readonly harness_id: string | null;
            readonly kind: string;
          }>`SELECT provider_account_id, harness_id, kind FROM agents ORDER BY id`;
        }),
      );

      expect(agents).toMatchObject([
        { provider_account_id: bytes(CODEX_DEFAULT), harness_id: CODEX, kind: "agent" },
        { provider_account_id: bytes(DELETED_INSTANCE), harness_id: null, kind: "assistant" },
      ]);
    });
  });

  describe("settings", () => {
    const setControllerSetting = (key: string, value: unknown) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO settings (scope, key, value, updated_at)
                   VALUES ('controller', ${key}, ${JSON.stringify(value)}, ${minute(5)})`;
      });

    /** Writes a setting of one user, the way the settings repository does: JSON text per user. */
    const setUserSetting = (user: number, key: string, value: unknown) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT OR IGNORE INTO users (id, username, password_hash, created_at, updated_at)
                   VALUES (${bytes(user)}, ${`user-${user}`}, 'x', ${minute(0)}, ${minute(0)})`;
        yield* sql`INSERT INTO user_settings (user_id, key, value, updated_at)
                   VALUES (${bytes(user)}, ${key}, ${JSON.stringify(value)}, ${minute(5)})`;
      });

    const readUserSettings = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly user_id: Uint8Array;
        readonly key: string;
        readonly value: string;
        readonly updated_at: string;
      }>`SELECT user_id, key, value, updated_at FROM user_settings ORDER BY user_id, key`;
      return Object.fromEntries(rows.map((row) => [`${row.user_id[0]}:${row.key}`, row]));
    });

    const readSettings = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        readonly scope: string;
        readonly key: string;
        readonly value: string;
        readonly updated_at: string;
      }>`SELECT scope, key, value, updated_at FROM settings ORDER BY scope, key`;
      return Object.fromEntries(rows.map((row) => [`${row.scope}:${row.key}`, row]));
    });

    it("renames every user's Thread default instance, and adds the harness it ran", async () => {
      const settings = await runOnFreshDatabase(
        Effect.gen(function* () {
          yield* arrangeInstances;
          yield* setUserSetting(0xc1, "thread.instanceId", uuidToString(bytes(CODEX_WORK)));
          yield* setUserSetting(0xc1, "thread.model", "gpt-5");
          yield* setUserSetting(0xc2, "thread.instanceId", uuidToString(bytes(PI_SECOND)));
          // An instance deleted before the migration: the id stays, and no harness is known.
          yield* setUserSetting(0xc3, "thread.instanceId", uuidToString(bytes(DELETED_INSTANCE)));
          yield* runMigrations();
          return yield* readUserSettings;
        }),
      );

      expect(Object.keys(settings).filter((key) => key.includes("instanceId"))).toEqual([]);
      expect(settings["193:thread.providerAccountId"]).toMatchObject({
        value: JSON.stringify(uuidToString(bytes(CODEX_WORK))),
        updated_at: minute(5),
      });
      expect(settings["193:thread.harnessId"]?.value).toBe(JSON.stringify(CODEX));
      expect(settings["193:thread.model"]?.value).toBe('"gpt-5"');
      expect(settings["194:thread.providerAccountId"]?.value).toBe(
        JSON.stringify(uuidToString(bytes(PI_SECOND))),
      );
      expect(settings["194:thread.harnessId"]?.value).toBe(JSON.stringify(PI));
      expect(settings["195:thread.harnessId"]?.value).toBe("null");
    });

    it("rewrites a chosen text generation model to an account, its harness and the model", async () => {
      const settings = await runOnFreshDatabase(
        Effect.gen(function* () {
          yield* arrangeInstances;
          yield* setControllerSetting("textGeneration.model", {
            instanceId: uuidToString(bytes(PI_SECOND)),
            model: "glm-5.3-flash",
          });
          yield* runMigrations();
          return yield* readSettings;
        }),
      );

      expect(parseJson(settings["controller:textGeneration.model"]!.value)).toEqual({
        providerAccountId: uuidToString(bytes(PI_SECOND)),
        harnessId: PI,
        model: "glm-5.3-flash",
      });
    });

    it("leaves `automatic` and `off` as they are", async () => {
      const [automatic, off] = await Promise.all(
        ["automatic", "off"].map((choice) =>
          runOnFreshDatabase(
            Effect.gen(function* () {
              yield* arrangeInstances;
              yield* setControllerSetting("textGeneration.model", choice);
              yield* runMigrations();
              return (yield* readSettings)["controller:textGeneration.model"]?.value;
            }),
          ),
        ),
      );

      expect([automatic, off]).toEqual(['"automatic"', '"off"']);
    });
  });

  describe("secrets", () => {
    const readSecrets = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{
        readonly id: Uint8Array<ArrayBuffer>;
        readonly owner_kind: string;
        readonly owner_id: string;
        readonly name: string;
        readonly nonce: Bytes;
        readonly ciphertext: Bytes;
        readonly created_at: string;
        readonly rotated_at: string | null;
      }>`SELECT * FROM secrets ORDER BY owner_kind, owner_id, name`;
    });

    const piOwner = uuidToString(bytes(PI_SECOND));

    /** Arranges instances with a Z.ai key on one pi instance and a Connection secret beside it. */
    const arrangeKeys = (key: CryptoKey) =>
      Effect.gen(function* () {
        yield* arrangeInstances;
        yield* insertSecret(key, {
          fill: PI_SECRET_ID,
          ownerKind: "provider-instance",
          ownerId: piOwner,
          name: "zaiApiKey",
          value: "zai-secret-value",
        });
        yield* insertSecret(key, {
          fill: CONNECTION_SECRET_ID,
          ownerKind: "connection",
          ownerId: uuidToString(bytes(0x80)),
          name: "token",
          value: "connection-token",
        });
      });

    it("encrypts the Z.ai key again for the account, and leaves other secrets as they were", async () => {
      const key = await makeMasterKey();
      const { secrets, decrypted, underOldOwner, connection } = await runOnFreshDatabase(
        Effect.gen(function* () {
          yield* arrangeKeys(key);
          const before = (yield* readSecrets).find((row) => row.owner_kind === "connection")!;
          yield* runMigrations(migrations, key);
          const secrets = yield* readSecrets;
          const moved = secrets.find((row) => row.owner_kind === "provider-account")!;
          const decrypted = yield* decryptSecretValue(
            key,
            { kind: "provider-account", id: piOwner },
            "apiKey",
            moved,
          );
          const underOldOwner = yield* Effect.result(
            decryptSecretValue(key, { kind: "provider-instance", id: piOwner }, "zaiApiKey", moved),
          );
          const connection = {
            before,
            after: secrets.find((row) => row.owner_kind === "connection")!,
          };
          return { secrets, decrypted, underOldOwner, connection };
        }),
      );

      expect(secrets.map((row) => [row.owner_kind, row.owner_id, row.name])).toEqual([
        ["connection", uuidToString(bytes(0x80)), "token"],
        ["provider-account", piOwner, "apiKey"],
      ]);
      const moved = secrets.find((row) => row.owner_kind === "provider-account")!;
      expect(decrypted).toBe("zai-secret-value");
      expect(Result.isFailure(underOldOwner)).toBe(true);
      expect(moved).toMatchObject({
        id: bytes(PI_SECRET_ID),
        created_at: minute(3),
        rotated_at: minute(4),
      });
      expect(connection.after).toEqual(connection.before);
    });

    it("allows the owner kind `provider-account` and no longer `provider-instance`", async () => {
      const key = await makeMasterKey();
      const outcomes = await runOnFreshDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* arrangeInstances;
          yield* runMigrations(migrations, key);
          const insert = (ownerKind: string) =>
            Effect.result(
              sql`INSERT INTO secrets (id, owner_kind, owner_id, name, nonce, ciphertext, created_at)
                  VALUES (${bytes(0x99)}, ${ownerKind}, 'x', 'y', x'00', x'00', ${minute(1)})`,
            );
          return {
            account: yield* insert("provider-account"),
            instance: yield* insert("provider-instance"),
          };
        }),
      );

      expect(Result.isSuccess(outcomes.account)).toBe(true);
      expect(Result.isFailure(outcomes.instance)).toBe(true);
    });

    it("deletes a provider-instance secret nothing could read", async () => {
      const key = await makeMasterKey();
      const secrets = await runOnFreshDatabase(
        Effect.gen(function* () {
          yield* arrangeKeys(key);
          // A leftover field of a harness that no longer declares it, and a key on a harness
          // that never had one.
          yield* insertSecret(key, {
            fill: 0x73,
            ownerKind: "provider-instance",
            ownerId: piOwner,
            name: "oldField",
            value: "old",
          });
          yield* insertSecret(key, {
            fill: 0x74,
            ownerKind: "provider-instance",
            ownerId: uuidToString(bytes(CLAUDE_DEFAULT)),
            name: "zaiApiKey",
            value: "misplaced",
          });
          yield* runMigrations(migrations, key);
          return yield* readSecrets;
        }),
      );

      expect(secrets.map((row) => [row.owner_kind, row.name])).toEqual([
        ["connection", "token"],
        ["provider-account", "apiKey"],
      ]);
    });

    it("fails, and changes nothing, when a key does not decrypt", async () => {
      const key = await makeMasterKey();
      const wrongKey = await makeMasterKey();
      const { refusal, version, secrets } = await runOnFreshDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* arrangeKeys(key);
          const refusal = yield* Effect.result(runMigrations(UP_TO_PROVIDER_ACCOUNTS, wrongKey));
          const [version] = yield* sql<{ readonly version: number }>`
            SELECT max(migration_id) AS version FROM effect_sql_migrations`;
          return { refusal, version, secrets: yield* readSecrets };
        }),
      );

      expectRefusal(refusal, piOwner);
      expect(version?.version).toBe(94);
      expect(secrets.map((row) => row.owner_kind)).toEqual(["connection", "provider-instance"]);
    });

    it("fails when a key must be encrypted again and no Master Key was opened", async () => {
      const key = await makeMasterKey();
      const { refusal, version } = await runOnFreshDatabase(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* arrangeKeys(key);
          const refusal = yield* Effect.result(runMigrations(UP_TO_PROVIDER_ACCOUNTS));
          const [version] = yield* sql<{ readonly version: number }>`
            SELECT max(migration_id) AS version FROM effect_sql_migrations`;
          return { refusal, version };
        }),
      );

      expectRefusal(refusal, "needs the Master Key");
      expect(version?.version).toBe(94);
    });

    it("needs no Master Key when there is no key to encrypt again", async () => {
      const accounts = await runOnFreshDatabase(
        Effect.gen(function* () {
          yield* arrangeInstances;
          yield* runMigrations();
          return yield* readAccounts;
        }),
      );

      expect(accounts.size).toBe(SCENARIO.length);
    });
  });
});
