/**
 * Reads and writes the `connection_state` table: the state an ingest handle
 * keeps for one Connection between polls, such as cursors and snapshots.
 *
 * The rows of a Connection are deleted with it, through the table's foreign
 * key. "Reset plugin state" deletes them explicitly, through `wipePluginState`.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { PluginError, type KeyValueStore } from "@hercule/plugin-host";
import { uuidFromString } from "../db";

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));

/**
 * Dies with a `PluginError` when a key is empty. The table refuses an empty
 * key anyway; checking first gives the plugin author a readable message
 * instead of a constraint error.
 */
const assertKeyNotEmpty = (key: string): Effect.Effect<void> =>
  key.length === 0
    ? Effect.die(new PluginError({ message: "A Connection state key cannot be empty." }))
    : Effect.void;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Builds the `KeyValueStore` an ingest handle receives for one
     * Connection. Every read and write is scoped to that Connection's id, so
     * nothing the plugin passes can reach another Connection's state. A
     * database failure is a defect: the plugin has no way to recover from it.
     */
    buildStore: (connectionId: string): KeyValueStore => {
      const id = uuidFromString(connectionId);
      return {
        get: (key) =>
          Effect.andThen(
            assertKeyNotEmpty(key),
            Effect.orDie(
              Effect.gen(function* () {
                const rows = yield* sql<{ readonly value: string }>`
                  SELECT value FROM connection_state WHERE connection_id = ${id} AND key = ${key}
                `;
                const row = rows[0];
                return row === undefined
                  ? Option.none()
                  : Option.some(yield* decodeJson(row.value));
              }),
            ),
          ),
        set: (key, value) =>
          Effect.andThen(
            assertKeyNotEmpty(key),
            Effect.orDie(
              Effect.asVoid(sql`
                INSERT INTO connection_state (connection_id, key, value)
                VALUES (${id}, ${key}, ${JSON.stringify(value)})
                ON CONFLICT (connection_id, key) DO UPDATE SET value = excluded.value
              `),
            ),
          ),
        delete: (key) =>
          Effect.andThen(
            assertKeyNotEmpty(key),
            Effect.orDie(
              Effect.asVoid(
                sql`DELETE FROM connection_state WHERE connection_id = ${id} AND key = ${key}`,
              ),
            ),
          ),
        list: () =>
          Effect.orDie(
            Effect.map(
              sql<{ readonly key: string }>`
                SELECT key FROM connection_state WHERE connection_id = ${id} ORDER BY key
              `,
              (rows) => rows.map((row) => row.key),
            ),
          ),
      };
    },

    /**
     * Deletes the state of every Connection the plugin owns. "Reset plugin
     * state" calls it, so the plugin's next ingest handles start from now
     * instead of from a stored cursor.
     */
    wipePluginState: (pluginId: string): Effect.Effect<void, SqlError> =>
      Effect.asVoid(
        sql`DELETE FROM connection_state
            WHERE connection_id IN (SELECT id FROM connections WHERE plugin_id = ${pluginId})`,
      ),
  };
});

/** The Connection state repository, used by the ingest loops and by "Reset plugin state". */
export const connectionStateRepository = make;
