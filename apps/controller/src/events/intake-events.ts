/**
 * The events Intake shows (spec 10 section 9.10). An event is in Intake when
 * either of these holds:
 *
 * - its kind is switched on for triage ("available to triage") for the
 *   Connection it came through, or
 * - a signal is behind it: it raised one, is evidence for one, or ended one.
 *
 * The switches live in the plugins domain and in each Connection's `intake`
 * column, and applying them is code, not SQL. So the switches are worked out
 * here, and handed to the query as a list of keys, one per switched-on
 * (Connection, kind) pair. The query then checks each event's key against the
 * list.
 *
 * This domain cannot import the plugins or connections domains, because they
 * import this one. It reads the `plugins` and `connections` tables directly
 * and gets a plugin's level of the settings through the `PluginIntake` port.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Fragment } from "effect/unstable/sql/Statement";
import type { IntakeOverrides } from "@hercule/contract";
import { uuidToString } from "../db";
import { applyIntakeOverrides, type PluginIntake } from "../intake-settings";
import { buildHasSignalBehind } from "./event-facts";

/** Returns the key of a Connection's id as SQLite's `hex()` writes it. */
const writeHexKey = (id: Uint8Array): string => uuidToString(id).replaceAll("-", "").toUpperCase();

/** Returns the key for an event kind of a plugin, as read through one Connection. */
const buildConnectionKey = (hexId: string, source: string, kind: string): string =>
  `c:${hexId}:${source}:${kind}`;

/** Returns the key for an event kind of a plugin, as read through no Connection that exists. */
const buildPluginKey = (source: string, kind: string): string => `p:${source}:${kind}`;

interface ConnectionRow {
  readonly id: Uint8Array;
  readonly plugin_id: string;
  readonly intake: string;
}

/**
 * Returns the keys of every (Connection, event kind) pair that is switched
 * on for triage, and every (plugin, event kind) pair that is switched on at
 * the plugin's level. The second kind of key serves events whose Connection
 * was deleted: they fall back to the plugin's level.
 *
 * A plugin that has no row in the `plugins` table has no settings to read,
 * so its events never qualify this way.
 */
export const readSwitchedOnEventKeys = (
  sql: SqlClient.SqlClient,
  pluginIntake: PluginIntake["Service"],
): Effect.Effect<ReadonlyArray<string>, SqlError> =>
  Effect.gen(function* () {
    const plugins = yield* sql<{ readonly id: string }>`SELECT id FROM plugins`;
    const connections = yield* sql<ConnectionRow>`SELECT id, plugin_id, intake FROM connections`;
    const keys: Array<string> = [];
    for (const { id: pluginId } of plugins) {
      const pluginLevel = yield* pluginIntake.read(pluginId);
      for (const setting of pluginLevel.eventKinds) {
        if (setting.on) keys.push(buildPluginKey(pluginId, setting.kind));
      }
      for (const connection of connections) {
        if (connection.plugin_id !== pluginId) continue;
        const settings = applyIntakeOverrides(
          pluginLevel,
          JSON.parse(connection.intake) as IntakeOverrides,
          "connection",
        );
        for (const setting of settings.eventKinds) {
          if (setting.on) {
            keys.push(buildConnectionKey(writeHexKey(connection.id), pluginId, setting.kind));
          }
        }
      }
    }
    return keys;
  });

/**
 * Builds the condition that the event the outer query is reading is one of
 * Intake's events. `switchedOnKeys` is what `readSwitchedOnEventKeys`
 * returned.
 *
 * An event without a Connection never qualifies through its kind: a core
 * event is not something a plugin offers to triage.
 */
export const buildIsInIntake = (
  sql: SqlClient.SqlClient,
  switchedOnKeys: ReadonlyArray<string>,
): Fragment =>
  sql.or([
    sql`(
      events.connection_id IS NOT NULL
      AND CASE
        WHEN EXISTS (SELECT 1 FROM connections WHERE connections.id = events.connection_id)
          THEN 'c:' || hex(events.connection_id) || ':' || events.source || ':' || events.kind
        ELSE 'p:' || events.source || ':' || events.kind
      END IN (SELECT value FROM json_each(${JSON.stringify(switchedOnKeys)}))
    )`,
    buildHasSignalBehind(sql),
  ]);
