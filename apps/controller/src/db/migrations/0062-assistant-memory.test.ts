/**
 * Tests what the assistant memory migration does to a database at the
 * previous head: every existing assistant gets an empty `core`, and the
 * full-text index follows the documents, including when an assistant's
 * delete removes them through the foreign key.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

const at = "2026-10-01T00:00:00.000Z";

/** Two assistants that exist before the migration. */
const ASSISTANTS = ["0199a000-0000-7000-8000-0000000000a1", "0199a000-0000-7000-8000-0000000000a2"];

/** Converts a canonical id to the hex the database stores it as, for `unhex`. */
const toHex = (id: string): string => id.replaceAll("-", "");

/**
 * Seeds two assistants at the previous head, runs this migration, and returns
 * what `read` reads from the migrated database.
 */
const seedAndMigrate = <A>(read: Effect.Effect<A, SqlError, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(migrations.filter(([id]) => id < 62));
      for (const assistant of ASSISTANTS) {
        yield* sql`INSERT INTO agents (id, kind, name, system_prompt, instance_id,
                                       permission_profile_id, access_mode, model_selection,
                                       disallowed_tools, created_at, updated_at)
          VALUES (unhex(${toHex(assistant)}), 'assistant', 'Hercule', '',
                  unhex(${toHex(assistant)}), unhex(${toHex(assistant)}),
                  'full-access', NULL, '[]', ${at}, ${at})`;
        yield* sql`INSERT INTO assistants (agent_id, heartbeat, rotation, reply, created_at)
          VALUES (unhex(${toHex(assistant)}), '{}', '{}', 'turn-end', ${at})`;
      }
      yield* runMigrations(migrations.filter(([id]) => id <= 62));
      return yield* read;
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

/** Returns the names of the documents whose name or body matches `match`. */
const search = (match: string) =>
  Effect.flatMap(
    SqlClient.SqlClient,
    (sql) => sql<{ readonly name: string }>`
      SELECT d.name FROM memory_documents_fts
      JOIN memory_documents d ON d.id = memory_documents_fts.rowid
      WHERE memory_documents_fts MATCH ${match} ORDER BY d.name`,
  );

describe("the assistant memory migration", () => {
  it("gives every existing assistant an empty core", async () => {
    const rows = await seedAndMigrate(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql<{
          readonly assistant: string;
          readonly name: string;
          readonly body: string;
          readonly size: number;
          readonly version: number;
          readonly updated_at: string;
        }>`
          SELECT lower(hex(assistant_id)) AS assistant, name, body, size, version, updated_at
          FROM memory_documents ORDER BY assistant`,
      ),
    );

    expect(rows).toEqual(
      ASSISTANTS.map((assistant) => ({
        assistant: toHex(assistant),
        name: "core",
        body: "",
        size: 0,
        version: 1,
        updated_at: at,
      })),
    );
  });

  it("keeps the full-text index current through insert, update and a cascading delete", async () => {
    const results = await seedAndMigrate(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const [first, second] = ASSISTANTS.map(toHex);
        yield* sql`UPDATE memory_documents SET body = 'likes tulips'
          WHERE assistant_id = unhex(${first!})`;
        yield* sql`INSERT INTO memory_documents
          (assistant_id, name, gist, body, size, version, updated_at, updated_by)
          VALUES (unhex(${second!}), 'garden', '', 'tulips and roses', 16, 1, ${at}, 'user')`;
        const before = yield* search("tulips");
        yield* sql`UPDATE memory_documents SET body = 'likes roses'
          WHERE assistant_id = unhex(${first!}) AND name = 'core'`;
        const afterUpdate = yield* search("tulips");
        yield* sql`DELETE FROM assistants WHERE agent_id = unhex(${second!})`;
        const afterDelete = yield* search("roses");
        // Fails when the index and the documents disagree.
        yield* sql`
          INSERT INTO memory_documents_fts (memory_documents_fts) VALUES ('integrity-check')`;
        return { before, afterUpdate, afterDelete };
      }),
    );

    expect(results.before.map((row) => row.name)).toEqual(["core", "garden"]);
    expect(results.afterUpdate.map((row) => row.name)).toEqual(["garden"]);
    expect(results.afterDelete.map((row) => row.name)).toEqual(["core"]);
  });

  it("refuses a gist on core", async () => {
    const refused = await seedAndMigrate(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.match(sql`UPDATE memory_documents SET gist = 'no' WHERE name = 'core'`, {
          onFailure: () => true,
          onSuccess: () => false,
        }),
      ),
    );
    expect(refused).toBe(true);
  });
});
