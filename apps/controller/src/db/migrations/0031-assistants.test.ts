/**
 * Tests what the assistants migration does to a database at the previous head:
 * it moves each user's GitHub default from the thread setting to the new
 * `github.defaultConnectionId` key, adds the `assistants` and `conversations`
 * tables, and marks every existing agent as a plain agent.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 31);

const at = "2026-09-01T00:00:00.000Z";

/** The Connection the user picked as the thread default before the migration. */
const CONNECTION = "0199a000-0000-7000-8000-00000000c0de";

/** A user who picked a GitHub default, and one who never did. */
const WITH_DEFAULT = "0199a000-0000-7000-8000-000000000001";
const WITHOUT_DEFAULT = "0199a000-0000-7000-8000-000000000002";

/** Two agents that exist before the migration. */
const AGENTS = ["0199a000-0000-7000-8000-0000000000a1", "0199a000-0000-7000-8000-0000000000a2"];

/** A setting row after the migration, with the user as a canonical id. */
interface SettingRow {
  readonly user: string;
  readonly key: string;
  readonly value: string;
}

/** Reads every user setting, with the user as the hex of its id. */
const readSettings = Effect.flatMap(
  SqlClient.SqlClient,
  (sql) => sql<SettingRow>`
    SELECT lower(hex(user_id)) AS user, key, value FROM user_settings ORDER BY user, key`,
);

/** Converts a canonical id to the hex the database stores it as, for `unhex`. */
const toHex = (id: string): string => id.replaceAll("-", "");

/**
 * Seeds two users and two agents at the previous head, runs the migration, and
 * returns what `read` reads from the migrated database.
 */
const seedAndMigrate = <A>(read: Effect.Effect<A, SqlError, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(BEFORE);

      for (const [user, name] of [
        [WITH_DEFAULT, "rogier"],
        [WITHOUT_DEFAULT, "ada"],
      ] as const) {
        yield* sql`INSERT INTO users (id, username, password_hash, created_at, updated_at)
          VALUES (unhex(${toHex(user)}), ${name}, 'hash', ${at}, ${at})`;
        // A setting unrelated to GitHub, so a migration that rewrites every row
        // of a user would show here.
        yield* sql`INSERT INTO user_settings (user_id, key, value, updated_at)
          VALUES (unhex(${toHex(user)}), 'timezone', '"Europe/Amsterdam"', ${at})`;
      }
      yield* sql`INSERT INTO user_settings (user_id, key, value, updated_at)
        VALUES (unhex(${toHex(WITH_DEFAULT)}), 'thread.githubConnectionId',
                ${JSON.stringify(CONNECTION)}, ${at})`;

      for (const agent of AGENTS) {
        yield* sql`INSERT INTO agents (id, name, system_prompt, instance_id, permission_profile_id,
                                       access_mode, model_selection, disallowed_tools,
                                       created_at, updated_at)
          VALUES (unhex(${toHex(agent)}), 'reviewer', 'Review the change.',
                  unhex(${toHex(CONNECTION)}), unhex(${toHex(CONNECTION)}),
                  'full-access', NULL, '[]', ${at}, ${at})`;
      }

      yield* runMigrations();

      return yield* read;
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

describe("the assistants migration", () => {
  it("moves the thread GitHub default to github.defaultConnectionId and leaves no old row", async () => {
    const settings = await seedAndMigrate(readSettings);

    expect(settings.filter((row) => row.user === toHex(WITH_DEFAULT))).toEqual([
      { user: toHex(WITH_DEFAULT), key: "github.defaultConnectionId", value: `"${CONNECTION}"` },
      { user: toHex(WITH_DEFAULT), key: "timezone", value: '"Europe/Amsterdam"' },
    ]);
    expect(settings.some((row) => row.key === "thread.githubConnectionId")).toBe(false);
  });

  it("gives a user without the old key no new row", async () => {
    const settings = await seedAndMigrate(readSettings);

    expect(settings.filter((row) => row.user === toHex(WITHOUT_DEFAULT))).toEqual([
      { user: toHex(WITHOUT_DEFAULT), key: "timezone", value: '"Europe/Amsterdam"' },
    ]);
  });

  it("creates the assistants and conversations tables", async () => {
    const tables = await seedAndMigrate(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name IN ('assistants', 'conversations') ORDER BY name`,
      ),
    );

    expect(tables.map((row) => row.name)).toEqual(["assistants", "conversations"]);
  });

  it("marks every existing agent as a plain agent", async () => {
    const agents = await seedAndMigrate(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{ readonly kind: string }>`SELECT kind FROM agents`,
      ),
    );

    expect(agents.map((row) => row.kind)).toEqual(["agent", "agent"]);
  });

  describe("the conversations table", () => {
    const ASSISTANT = AGENTS[0]!;

    /**
     * Inserts one conversation for `ASSISTANT` and returns whether the
     * database accepted it.
     */
    const insertConversation = (id: string, containerKey: string | null) =>
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.match(
          sql`INSERT INTO conversations (id, assistant_id, channel, container_key, created_at)
            VALUES (unhex(${toHex(id)}), unhex(${toHex(ASSISTANT)}), 'web', ${containerKey}, ${at})`,
          { onFailure: () => "refused", onSuccess: () => "accepted" },
        ),
      );

    it("refuses a second web conversation for one assistant", async () => {
      const outcomes = await seedAndMigrate(
        Effect.all([
          insertConversation("0199a000-0000-7000-8000-0000000000c1", null),
          insertConversation("0199a000-0000-7000-8000-0000000000c2", null),
        ]),
      );

      expect(outcomes).toEqual(["accepted", "refused"]);
    });

    it("refuses a web conversation with a container key, because the web channel has no containers", async () => {
      const outcome = await seedAndMigrate(
        insertConversation("0199a000-0000-7000-8000-0000000000c1", "a-container"),
      );

      expect(outcome).toBe("refused");
    });
  });
});
