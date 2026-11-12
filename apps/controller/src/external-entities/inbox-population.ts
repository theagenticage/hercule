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
import { buildEligibleEntities, CONCERNED_REFS_SQL, type InboxMembership } from "./inbox-relation";

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
   * has an ask (the one definition in `buildEligibleEntities`). One statement,
   * none for no refs.
   */
  const readEligibleRefs = (
    refs: ReadonlyArray<string>,
    membership: InboxMembership,
  ): Effect.Effect<ReadonlyMap<string, { readonly asks: boolean }>, SqlError> => {
    if (refs.length === 0) return Effect.succeed(new Map());
    const eligible = buildEligibleEntities(membership, refs);
    return Effect.map(
      sql.unsafe<{ readonly ref: string; readonly ask_count: number | null }>(
        `WITH ${eligible.sql} SELECT ref, ask_count FROM eligible`,
        eligible.params,
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

  /**
   * Runs `write`, which changes what the Inbox holds of `refs`, and returns
   * its result. A ref arrives, and takes a number of the arrival counter
   * stamped at `membership.now`, when after the write it is on the Inbox and
   * either it was not held before (not on the Inbox, not concerning the user),
   * or it has an ask now that it had none before. So a thing that came back
   * after a dismissal arrives, and so does a thing that begins to ask. A concern
   * that joins a thing a signal holds, or a second ask, is no new arrival. A
   * thing that stays off the Inbox, such as a dismissed one, takes none.
   *
   * It looks at the Inbox before `write` runs, and runs in the caller's
   * transaction. Announces nothing.
   */
  const recordArrivalsAfter = <A, E, R>(
    refs: ReadonlyArray<string>,
    membership: InboxMembership,
    write: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | SqlError, R> =>
    Effect.gen(function* () {
      const eligibleBefore = yield* readEligibleRefs(refs, membership);
      const concerned = yield* listConcernedRefs(refs);
      const written = yield* write;
      const eligibleAfter = yield* readEligibleRefs(refs, membership);
      for (const ref of refs) {
        const after = eligibleAfter.get(ref);
        if (after === undefined) continue;
        const before = eligibleBefore.get(ref);
        const wasHeld = before !== undefined || concerned.has(ref);
        if (wasHeld && !(after.asks && before?.asks !== true)) continue;
        yield* sql`
          UPDATE external_entities
          SET arrival_sequence = ${yield* takeArrivalSequence}, updated_at = ${membership.now}
          WHERE ref = ${ref}`;
      }
      return written;
    });

  return {
    /** Returns which of `refs` are eligible for the Inbox in `membership`. One statement, none for no refs. */
    listEligibleRefs: (
      refs: ReadonlyArray<string>,
      membership: InboxMembership,
    ): Effect.Effect<ReadonlySet<string>, SqlError> =>
      Effect.map(readEligibleRefs(refs, membership), (found) => new Set(found.keys())),

    /**
     * Runs `write`, an observation write that raises no signal, and records
     * the arrivals it causes at `now` (see `recordArrivalsAfter`).
     *
     * No signal is raised, so no ask begins and which kinds ask cannot change
     * who arrives: a dismissed thing is back, or not, both before and after the
     * write. The rule is therefore evaluated with no asking kinds.
     */
    recordArrivalsAfterObservations: <A, E, R>(
      refs: ReadonlyArray<string>,
      now: string,
      write: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | SqlError, R> =>
      recordArrivalsAfter(refs, { now, askingKinds: [] }, write),

    /**
     * Runs `write`, which writes an open signal on the thread `ref`, and
     * records the arrival it causes (see `recordArrivalsAfter`). `membership`
     * names the kinds that ask, so a signal that begins an ask is an arrival.
     */
    recordArrivalAfterSignal: <A, E, R>(
      ref: string,
      membership: InboxMembership,
      write: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | SqlError, R> => recordArrivalsAfter([ref], membership, write),
  };
};
