/**
 * The events Intake shows (spec 10 section 9.10). An event is in Intake when
 * either of these holds:
 *
 * - its kind is switched on for triage ("available to triage") for the
 *   Connection it came through, or
 * - a signal is behind it: it raised one, is evidence for one, or ended one,
 *   or an Ignore Rule caught it before the signal it would have raised
 *   existed.
 *
 * The switches live in the plugins domain and in each Connection's `intake`
 * column, and applying them is code, not SQL. So the switches are worked out
 * here, and handed to the query as a list of rows, one per switched-on
 * (Connection, kind) pair. The query then looks each event up in the list.
 *
 * This domain cannot import the plugins or connections domains, because they
 * import this one. It reads the `plugins` and `connections` tables directly
 * and gets a plugin's level of the settings through the `PluginIntake` port.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { Fragment } from "effect/sql/Statement";
import type { IntakeOverrides } from "@hercule/contract";
import { applyIntakeOverrides, type PluginIntake } from "../intake-settings";
import { buildHasSignalBehind } from "./event-facts";

/**
 * An event kind of a plugin that is switched on for triage. `connectionHex` is
 * the id of the Connection the switch is for, as SQLite's `hex()` writes it.
 * It is null for the switch at the plugin's level, which serves events whose
 * Connection was deleted.
 */
export interface SwitchedOnEventKind {
  readonly connectionHex: string | null;
  readonly source: string;
  readonly kind: string;
}

interface ConnectionRow {
  readonly hex_id: string;
  readonly plugin_id: string;
  readonly intake: string;
}

/**
 * Returns every event kind that is switched on for triage, at each plugin's
 * level and for each of its Connections.
 *
 * A plugin that has no row in the `plugins` table has no settings to read,
 * so its events never qualify this way.
 */
export const readSwitchedOnEventKinds = (
  sql: SqlClient.SqlClient,
  pluginIntake: PluginIntake["Service"],
): Effect.Effect<ReadonlyArray<SwitchedOnEventKind>, SqlError> =>
  Effect.gen(function* () {
    const plugins = yield* sql<{ readonly id: string }>`SELECT id FROM plugins`;
    const connections = yield* sql<ConnectionRow>`
      SELECT hex(id) AS hex_id, plugin_id, intake FROM connections
    `;
    const switchedOn: Array<SwitchedOnEventKind> = [];
    for (const { id: pluginId } of plugins) {
      const pluginLevel = yield* pluginIntake.read(pluginId);
      for (const setting of pluginLevel.eventKinds) {
        if (setting.on) {
          switchedOn.push({ connectionHex: null, source: pluginId, kind: setting.kind });
        }
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
            switchedOn.push({
              connectionHex: connection.hex_id,
              source: pluginId,
              kind: setting.kind,
            });
          }
        }
      }
    }
    return switchedOn;
  });

/**
 * Builds the condition that the event the outer query is reading is one of
 * Intake's events. `switchedOn` is what `readSwitchedOnEventKinds` returned.
 *
 * An event with a Connection that still exists matches the rows for that
 * Connection. An event whose Connection was deleted matches the rows for the
 * plugin's level. An event with no Connection never qualifies through its
 * kind: a core event is not something a plugin offers to triage.
 *
 * The unary plus before `events.source` and `events.kind` keeps SQLite from
 * using their indexes for this condition. Left to choose, it can pick the
 * indexes, gather every switched-on event and sort them, instead of walking
 * the log newest first and stopping after one page.
 */
export const buildIsInIntake = (
  sql: SqlClient.SqlClient,
  switchedOn: ReadonlyArray<SwitchedOnEventKind>,
): Fragment => {
  const rows = (connectionTest: Fragment, columns: Fragment) => sql`(
    SELECT ${columns}
    FROM json_each(${JSON.stringify(switchedOn)}) AS switched_on
    WHERE ${connectionTest}
  )`;
  return sql.or([
    sql`(
      (+events.source, +events.kind, hex(events.connection_id)) IN ${rows(
        sql`json_extract(switched_on.value, '$.connectionHex') IS NOT NULL`,
        sql`json_extract(switched_on.value, '$.source'),
            json_extract(switched_on.value, '$.kind'),
            json_extract(switched_on.value, '$.connectionHex')`,
      )}
      OR (
        events.connection_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM connections WHERE connections.id = events.connection_id)
        AND (+events.source, +events.kind) IN ${rows(
          sql`json_extract(switched_on.value, '$.connectionHex') IS NULL`,
          sql`json_extract(switched_on.value, '$.source'),
              json_extract(switched_on.value, '$.kind')`,
        )}
      )
    )`,
    buildHasSignalBehind(sql),
  ]);
};
