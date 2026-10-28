/**
 * Spawn bounds: the most runs a start trigger may start in a sliding window
 * (spec 10 section 5).
 *
 * A trigger's source may set its own bound, which a save copies into the
 * trigger's `spawn_bound_*` columns. A trigger whose source sets none runs
 * under the default, which is the `spawnBound.default` setting, or
 * `DEFAULT_SPAWN_BOUND` while nobody has set it.
 *
 * The SQL here reads the trigger in `triggers`, so a query that uses it must
 * name the `triggers` table without an alias. Every query that counts a
 * trigger's runs or held events uses it, so the trigger list, the event
 * router and the delivery agree on the counts.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { Fragment } from "effect/sql/Statement";
import { DEFAULT_SPAWN_BOUND, type SpawnBound } from "@hercule/contract";
import type { Settings } from "../settings";

/**
 * Returns the spawn bound of the triggers whose source sets none: the
 * `spawnBound.default` setting, or `DEFAULT_SPAWN_BOUND` when it is not set.
 * A stored value this version cannot read counts as not set, as it does for
 * every setting. Fails only if the database fails.
 */
export const readDefaultSpawnBound = (
  settings: Settings["Service"],
): Effect.Effect<SpawnBound, SqlError> =>
  settings
    .get("spawnBound.default")
    .pipe(Effect.catchTag("SettingError", () => Effect.succeed(DEFAULT_SPAWN_BOUND)));

/** Matches the trigger effects of the trigger in `triggers`, read as `counted`. */
const OF_THE_TRIGGER = `counted.workflow_id = triggers.workflow_id
  AND counted.trigger_id = triggers.trigger_id`;

/** The number of events the trigger in `triggers` holds. */
export const HELD_COUNT = `(SELECT count(*) FROM trigger_effects AS counted
  WHERE ${OF_THE_TRIGGER} AND counted.state = 'held')`;

/** Whether the trigger in `triggers` holds any event. */
export const HOLDS_EVENTS = `EXISTS (SELECT 1 FROM trigger_effects AS counted
  WHERE ${OF_THE_TRIGGER} AND counted.state = 'held')`;

/** Builds the `maxRuns` of the bound the trigger in `triggers` runs under. */
export const buildMaxRuns = (sql: SqlClient.SqlClient, defaultBound: SpawnBound): Fragment =>
  sql`COALESCE(triggers.spawn_bound_max_runs, ${defaultBound.maxRuns})`;

/**
 * Builds the start of the trigger's window that ends at `now`: `now` less
 * the trigger's `windowSeconds`. A run started after it counts against the
 * bound. It is written in the format `nowIso` writes, so it compares as text
 * with the stored timestamps.
 */
export const buildWindowStart = (
  sql: SqlClient.SqlClient,
  defaultBound: SpawnBound,
  now: string,
): Fragment =>
  sql`strftime('%Y-%m-%dT%H:%M:%fZ', ${now}, '-' || COALESCE(
    triggers.spawn_bound_window_seconds, ${defaultBound.windowSeconds}) || ' seconds')`;

/**
 * Builds how many runs the trigger in `triggers` started in the window that
 * ends at `now`.
 */
export const buildRunsStartedInWindow = (
  sql: SqlClient.SqlClient,
  defaultBound: SpawnBound,
  now: string,
): Fragment => sql`(SELECT count(*) FROM trigger_effects AS counted
  WHERE ${sql.literal(OF_THE_TRIGGER)} AND counted.state = 'spawned'
    AND counted.spawned_at > ${buildWindowStart(sql, defaultBound, now)})`;

/**
 * Builds how many runs the trigger in `triggers` used of its bound in the
 * window that ends at `now`: the runs it started in the window, plus its
 * pending rows, which will each start one.
 */
export const buildRunsInWindow = (
  sql: SqlClient.SqlClient,
  defaultBound: SpawnBound,
  now: string,
): Fragment => sql`(${buildRunsStartedInWindow(sql, defaultBound, now)}
  + (SELECT count(*) FROM trigger_effects AS counted
     WHERE ${sql.literal(OF_THE_TRIGGER)} AND counted.state = 'pending'))`;
