/**
 * Who is on the Inbox, and which things Hercule reads, keeps and counts as
 * arrived.
 *
 * Three questions about the same inputs (concerns, live Tasks, open signals)
 * have three different answers, on purpose. Each has one definition here:
 *
 * - **Visible now** (`buildEligibleEntities`): the thing is on the Inbox. A
 *   full record of a work kind that concerns the user, has a live Task, or
 *   holds a live signal (open and not snoozed now), and that is not dismissed.
 *   A dismissed thing comes back when an ask is raised after the dismissal.
 *   A snooze ends with time, so every read takes `now`.
 * - **Retained while open** (`RETAINED_ROOT_REFS_SQL`): the daily sweep keeps
 *   the record. Any concern, any Task link (finished ones too) and any open
 *   signal, snoozed or not, holds it.
 * - **Wanted by a Connection** (`WANTED_REFS_SQL`): a poll reads the ref
 *   again. Concerns, live Tasks and open signals on a work record hold it,
 *   snoozed or not, and so does everything above and next to them.
 *
 * `makeInboxPopulation` builds the reads over the first question that the
 * write path needs: which refs are on the Inbox, and the arrival number a
 * thing takes when it arrives. The Inbox's own reads are in `inbox-query.ts`.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { MAX_CONTEXT_DEPTH, MAX_CONTEXT_PARENTS } from "@hercule/contract";
import { OPEN_THREAD_REFS_SQL } from "../signals";
import { LIVE_TASK_LINKS_SQL } from "../tasks";
import { CURRENT_PART_OF_SQL, WALK_STATE_ROOM } from "./claim-graph";
import { CURRENT_LINKED_SQL } from "./entity-links";
import { buildWorkRecordCondition } from "./entity-records";
import type { CompiledSql } from "./inbox-predicates";

/**
 * The refs that concern the user: some Connection's inventory reports a
 * concern for them. Every question below starts from this one query, so a
 * thing that is on the Inbox is also kept, read and suggested.
 *
 * Open signals are not in it. They answer each question their own way (see the
 * top of this file).
 */
export const CONCERNED_REFS_SQL = `SELECT ref FROM external_entity_observations WHERE concerns <> '[]'`;

/**
 * The refs the daily sweep keeps a record for, and keeps whatever sits above
 * them: refs that concern the user, refs any Task links (finished Tasks too,
 * because a finished Task still names its things), refs of open signals,
 * snoozed or not, and context records (a project, a team) that a Connection's
 * latest inventory lists, because the known values of a Facet come from them
 * and a listed project with no issues must not be deleted and recreated every
 * month. A listed work record with no concern is not kept: a call that cuts its
 * inventory short lists records for good, and those would never be pruned.
 * As a `SELECT` of one `ref` column.
 */
export const RETAINED_ROOT_REFS_SQL = `
  ${CONCERNED_REFS_SQL}
  UNION
  SELECT o.ref FROM external_entity_observations o
    JOIN external_entities e ON e.ref = o.ref
    WHERE o.listed = 1 AND e.pace = 'context'
  UNION
  SELECT ref FROM task_entity_links
  UNION
  ${OPEN_THREAD_REFS_SQL}`;

/**
 * The common table expressions behind every read of the Inbox, as SQL text
 * with two `?` placeholders: the read clock `now`, then the JSON array of the
 * asking signal kinds. `buildEligibleEntities` binds them.
 *
 * - `live_links`: the live Task links, each ref's active Task at `position =
 *   1`.
 * - `taken`: for each ref whose active Task the user made or joined by taking
 *   the thing on (Take on or Add to Work), when that happened. The Task's
 *   first provenance entry for the ref then carries no run, signal, event or
 *   merge: a hand-off's carries its run, a Task made from a signal or an event
 *   carries those.
 * - `live_signals`: the open signals that are not snoozed at `now`.
 * - `asks`: the live signals of an asking kind that nobody took. An ask is
 *   taken when the user took the thing on after it was raised, so it stays
 *   out of the list until a newer one arrives.
 * - `ask_summary`: per ref, how many asks, and when the oldest and the newest
 *   were raised.
 * - `eligible`: the entities on the Inbox. A full record of a work kind that
 *   concerns the user, has a live Task or holds a live signal; and is not
 *   dismissed, or has an ask raised after the dismissal. Access, lifecycle,
 *   stale and whether the kind is still declared do not matter: a thing keeps
 *   its last known facts. It carries the active Task (`task_id`) and the
 *   summary of its asks (`ask_count`, `oldest_ask`, `newest_ask`, null for no
 *   asks).
 */
const ELIGIBLE_ENTITIES_SQL = `
  read_clock(now) AS (SELECT ?),
  live_links AS MATERIALIZED (${LIVE_TASK_LINKS_SQL}),
  taken AS MATERIALIZED (
    SELECT l.ref, l.linked_at AS taken_at FROM live_links l
    WHERE l.position = 1 AND EXISTS (
      SELECT 1 FROM task_provenance p
      WHERE p.task_id = l.task_id AND p.ref = l.ref AND p.at = l.linked_at
        AND p.run_id IS NULL AND p.signal_id IS NULL AND p.event_id IS NULL
        AND p.merged_task_id IS NULL)),
  live_signals AS MATERIALIZED (
    SELECT s.thread_ref AS ref, s.id, s.kind, s.asker, s.created_at,
      s.kind IN (SELECT value FROM json_each(?)) AS asking
    FROM signals s LEFT JOIN signal_snoozes z ON z.signal_id = s.id
    WHERE s.status = 'open' AND s.thread_ref IS NOT NULL
      AND (z.until IS NULL OR z.until <= (SELECT now FROM read_clock))),
  asks AS MATERIALIZED (
    SELECT ls.ref, ls.id, ls.kind, ls.asker, ls.created_at
    FROM live_signals ls LEFT JOIN taken t ON t.ref = ls.ref
    WHERE ls.asking = 1 AND (t.taken_at IS NULL OR ls.created_at >= t.taken_at)),
  ask_summary AS MATERIALIZED (
    SELECT ref, COUNT(*) AS ask_count, MIN(created_at) AS oldest_ask, MAX(created_at) AS newest_ask
    FROM asks GROUP BY ref),
  eligible AS (
    SELECT e.*, l.task_id AS task_id, a.ask_count, a.oldest_ask, a.newest_ask
    FROM external_entities e
    LEFT JOIN live_links l ON l.ref = e.ref AND l.position = 1
    LEFT JOIN ask_summary a ON a.ref = e.ref
    WHERE ${buildWorkRecordCondition("e")}
      AND (e.dismissed_at IS NULL OR a.newest_ask > e.dismissed_at)
      AND (e.ref IN (${CONCERNED_REFS_SQL}) OR l.task_id IS NOT NULL
           OR e.ref IN (SELECT ref FROM live_signals)))`;

/**
 * Builds the common table expressions of `ELIGIBLE_ENTITIES_SQL` with their
 * parameters, to put after `WITH`. `now` decides which snoozes have ended;
 * `askingKinds` are the signal kinds that ask the user for a move
 * (`listAskingKinds`).
 */
export const buildEligibleEntities = (
  now: string,
  askingKinds: ReadonlyArray<string>,
): CompiledSql => ({
  sql: ELIGIBLE_ENTITIES_SQL,
  params: [now, JSON.stringify(askingKinds)],
});

/**
 * The SQL that finds the refs Hercule wants a Connection to read, as a list of
 * common table expressions. `wanted` holds:
 *
 * - the roots: refs that concern the user (`CONCERNED_REFS_SQL`), refs a
 *   live Task links, and refs of full work records that hold an open signal
 *   (snoozed or not, because a snoozed signal still needs its card kept
 *   current). A signal on a ref with no such record makes nothing wanted
 *   here: `listWanted` adds those for the Connection the signal came through;
 * - everything above the roots, up to `MAX_CONTEXT_DEPTH` levels of
 *   `part-of`, even where no record exists. A thing contributes its first
 *   `MAX_CONTEXT_PARENTS` parents (by ref), and the walk stops after
 *   `WALK_STATE_ROOM` states beyond the roots, so the work of one poll stays
 *   bounded however the graph grows;
 * - the direct peers of the roots, but only while they have no record: a
 *   peer gets one read for its title and access, and its own links and parents
 *   are never followed.
 *
 * The sweep that prunes observations asks this same question, so what is
 * wanted is decided once.
 */
export const WANTED_REFS_SQL = `
  wanted_roots(ref) AS (
    ${CONCERNED_REFS_SQL}
    UNION
    SELECT ref FROM (${LIVE_TASK_LINKS_SQL})
    UNION
    SELECT e.ref FROM external_entities e
    WHERE ${buildWorkRecordCondition("e")} AND e.ref IN (${OPEN_THREAD_REFS_SQL})
  ),
  wanted_context(ref, depth) AS (
    SELECT ref, 0 FROM wanted_roots
    UNION
    SELECT parent.value, w.depth + 1
    FROM wanted_context w,
      json_each((
        SELECT json_group_array(to_ref) FROM (
          SELECT DISTINCT c.to_ref FROM external_entity_relation_claims c
          WHERE c.from_ref = w.ref AND ${CURRENT_PART_OF_SQL}
          ORDER BY c.to_ref LIMIT ${MAX_CONTEXT_PARENTS})
      )) parent
    WHERE w.depth < ${MAX_CONTEXT_DEPTH}
    LIMIT (SELECT COUNT(*) FROM wanted_roots) + ${WALK_STATE_ROOM}
  ),
  wanted_peers(ref) AS (
    -- CROSS JOIN pins the order, so each root seeks its claims by index
    -- instead of SQLite scanning every current claim.
    SELECT c.to_ref FROM wanted_roots r CROSS JOIN external_entity_relation_claims c
      ON c.from_ref = r.ref AND ${CURRENT_LINKED_SQL}
    UNION
    SELECT c.from_ref FROM wanted_roots r CROSS JOIN external_entity_relation_claims c
      ON c.to_ref = r.ref AND ${CURRENT_LINKED_SQL}
  ),
  wanted(ref) AS (
    SELECT ref FROM wanted_context
    UNION
    SELECT ref FROM wanted_peers
    WHERE NOT EXISTS (SELECT 1 FROM external_entities e WHERE e.ref = wanted_peers.ref)
  )`;

/**
 * Builds the reads over who is on the Inbox that the write path needs, over
 * `sql`.
 */
export const makeInboxPopulation = (sql: SqlClient.SqlClient) => {
  /**
   * Reads which of `refs` are eligible for the Inbox at `now`, and whether each
   * has an ask (the one definition in `ELIGIBLE_ENTITIES_SQL`). One statement,
   * none for no refs.
   */
  const readEligibleRefs = (
    refs: ReadonlyArray<string>,
    now: string,
    askingKinds: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyMap<string, { readonly asks: boolean }>, SqlError> => {
    if (refs.length === 0) return Effect.succeed(new Map());
    const eligible = buildEligibleEntities(now, askingKinds);
    return Effect.map(
      sql.unsafe<{ readonly ref: string; readonly ask_count: number | null }>(
        `WITH ${eligible.sql}
         SELECT ref, ask_count FROM eligible
         WHERE ref IN (SELECT value FROM json_each(?))`,
        [...eligible.params, JSON.stringify(refs)],
      ),
      (rows) => new Map(rows.map((row) => [row.ref, { asks: row.ask_count !== null }])),
    );
  };

  /**
   * Returns which of `refs` concern the user and are not dismissed. One
   * statement, none for no refs.
   */
  const listConcernedRefs = (
    refs: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlySet<string>, SqlError> =>
    refs.length === 0
      ? Effect.succeed(new Set())
      : Effect.map(
          sql<{ readonly ref: string }>`
            SELECT ref FROM (${sql.literal(CONCERNED_REFS_SQL)})
            WHERE ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))
              AND ref NOT IN (SELECT ref FROM external_entities WHERE dismissed_at IS NOT NULL)`,
          (rows) => new Set(rows.map((row) => row.ref)),
        );

  /** Takes the next number of the arrival counter. The counter only goes up, even after a prune. */
  const takeArrivalSequence = Effect.map(
    sql<{ readonly last: number }>`
      UPDATE external_entity_arrival_counter SET last = last + 1 WHERE id = 1 RETURNING last`,
    (rows) => rows[0]!.last,
  );

  return {
    /**
     * Returns which of `refs` are eligible for the Inbox at `now`. One
     * statement, none for no refs.
     */
    listEligibleRefs: (
      refs: ReadonlyArray<string>,
      now: string,
      askingKinds: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlySet<string>, SqlError> =>
      Effect.map(readEligibleRefs(refs, now, askingKinds), (found) => new Set(found.keys())),

    /**
     * Runs `write`, which changes what the Inbox holds of `refs`, and returns
     * its result. A ref arrives, and takes a number of the arrival counter
     * stamped at `now`, when after the write it is on the Inbox and either it
     * was not held before (not on the Inbox, not concerning the user), or it
     * has an ask now that it had none before. So a thing that came back after a
     * dismissal arrives, and so does a thing that begins to ask. A concern that
     * joins a thing a signal holds, or a second ask, is no new arrival. A thing
     * that stays off the Inbox, such as a dismissed one, takes none.
     *
     * Both the write of observations and a raised signal arrive through this
     * one rule. It looks at the Inbox before `write` runs, and runs in the
     * caller's transaction. `askingKinds` are the kinds that ask
     * (`listAskingKinds`): a write that raises no signal may pass none.
     * Announces nothing.
     */
    recordArrivalsAfter: <A, E, R>(
      refs: ReadonlyArray<string>,
      now: string,
      askingKinds: ReadonlyArray<string>,
      write: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | SqlError, R> =>
      Effect.gen(function* () {
        const eligibleBefore = yield* readEligibleRefs(refs, now, askingKinds);
        const concerned = yield* listConcernedRefs(refs);
        const written = yield* write;
        const eligibleAfter = yield* readEligibleRefs(refs, now, askingKinds);
        for (const ref of refs) {
          const after = eligibleAfter.get(ref);
          if (after === undefined) continue;
          const before = eligibleBefore.get(ref);
          const wasHeld = before !== undefined || concerned.has(ref);
          if (wasHeld && !(after.asks && before?.asks !== true)) continue;
          yield* sql`
            UPDATE external_entities
            SET arrival_sequence = ${yield* takeArrivalSequence}, updated_at = ${now}
            WHERE ref = ${ref}`;
        }
        return written;
      }),
  };
};
