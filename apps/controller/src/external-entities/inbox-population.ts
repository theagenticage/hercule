/**
 * Who is on the Inbox, and which things Hercule reads, keeps and counts as
 * arrived.
 *
 * Three questions about the same inputs (concerns, live Tasks, open signals)
 * have three different answers, on purpose. Each has one definition here:
 *
 * - **Visible now** (`ELIGIBLE_ENTITIES_SQL`): the card is on the Inbox. A
 *   full record of a work kind that is not dismissed and that concerns the
 *   user, has a live Task, or holds a live signal (open and not snoozed now).
 *   A snooze ends with time, so every read takes `now`.
 * - **Retained while open** (`RETAINED_ROOT_REFS_SQL`): the daily sweep keeps
 *   the record. Any concern, any Task link (finished ones too) and any open
 *   signal, snoozed or not, holds it.
 * - **Wanted by a Connection** (`WANTED_REFS_SQL`): a poll reads the ref
 *   again. Concerns, live Tasks and open signals on a work record hold it,
 *   snoozed or not, and so does everything above and next to them.
 *
 * `makeInboxPopulation` builds the reads over the first question: the cards
 * and their counts, which refs are on the Inbox, and the arrival number a card
 * takes when it comes onto the clock.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  MAX_CONTEXT_DEPTH,
  MAX_CONTEXT_PARENTS,
  type InboxCounts,
  type InboxSide,
} from "@hercule/contract";
import { buildLiveThreadSignalExists, OPEN_THREAD_REFS_SQL } from "../signals";
import { LIVE_TASK_LINKS_SQL } from "../tasks";
import { CURRENT_PART_OF_SQL, WALK_STATE_ROOM } from "./claim-graph";
import { CURRENT_LINKED_SQL, type makeEntityLinkReads } from "./entity-links";
import { buildWorkRecordCondition } from "./entity-records";
import { decideRiding, type RidingCard } from "./riding";

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
 * because a finished Task still names its things) and refs of open signals,
 * snoozed or not. As a `SELECT` of one `ref` column.
 */
export const RETAINED_ROOT_REFS_SQL = `
  ${CONCERNED_REFS_SQL}
  UNION
  SELECT ref FROM task_entity_links
  UNION
  ${OPEN_THREAD_REFS_SQL}`;

/**
 * The one definition of what is on the Inbox, as common table expressions.
 * An entity is eligible when it is a full record of a work kind, is not
 * dismissed, and concerns the user, has a live Task, or holds a live signal.
 * A dismissed entity stays out whatever signals arrive. Access, lifecycle,
 * stale and whether the kind is still declared do not matter: a card keeps its
 * last known facts.
 *
 * `eligible` carries the active Task (`task_id`), the `side` the server puts
 * the card on, and whether a live Task follows the ref. The Inbox, its counts
 * and the Add sheet's suggestions all read it, so they cannot disagree.
 *
 * The statement it sits in must define `read_clock(now)` first, because a
 * snooze ends with time and nothing is written when it does.
 * `buildEligibleEntities` puts both in place.
 */
const ELIGIBLE_ENTITIES_SQL = `
  live_links AS MATERIALIZED (${LIVE_TASK_LINKS_SQL}),
  eligible AS (
    SELECT e.*, l.task_id AS task_id,
      CASE WHEN l.task_id IS NOT NULL THEN 'with-someone-else'
           WHEN e.card = 'compact' THEN 'requests'
           ELSE 'ongoing' END AS side,
      EXISTS (SELECT 1 FROM live_links f WHERE f.ref = e.ref AND f.following = 1) AS following
    FROM external_entities e
    LEFT JOIN live_links l ON l.ref = e.ref AND l.position = 1
    WHERE ${buildWorkRecordCondition("e")} AND e.dismissed_at IS NULL
      AND (e.ref IN (${CONCERNED_REFS_SQL}) OR l.task_id IS NOT NULL
           OR ${buildLiveThreadSignalExists("e.ref")})
  )`;

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
 * One eligible card as the Inbox reads it, with only what riding, the counts
 * and the page order need. The page's full entity rows are read afterwards,
 * for the cards that made the page.
 */
export interface EligibleCard extends RidingCard {
  /** The active Task of the thing, else null. */
  readonly taskId: Uint8Array | null;
  readonly side: InboxSide;
  /** True when a live Task follows the thing. */
  readonly following: boolean;
  readonly arrivalSequence: number;
}

/**
 * Checks that a card on the Inbox counts as on the clock: a fast kind with no
 * live Task. Only those cards take a number of the arrival counter.
 */
const isOnTheClock = (card: Pick<RidingCard, "pace" | "hasTask">): boolean =>
  card.pace === "fast" && !card.hasTask;

/**
 * Builds the reads over who is on the Inbox, over `sql`. `linkReads` supplies
 * the links that decide who rides on whom.
 */
export const makeInboxPopulation = (
  sql: SqlClient.SqlClient,
  linkReads: Pick<ReturnType<typeof makeEntityLinkReads>, "readLinksOf">,
) => {
  const refsJson = (refs: ReadonlyArray<string>): string => JSON.stringify(refs);

  /**
   * Builds the common table expressions of `ELIGIBLE_ENTITIES_SQL`, with the
   * `read_clock` they need: `now` decides which snoozes have ended.
   */
  const buildEligibleEntities = (now: string) =>
    sql`read_clock(now) AS (SELECT ${now}), ${sql.literal(ELIGIBLE_ENTITIES_SQL)}`;

  /**
   * Reads every eligible card at `now`, oldest first by `(firstObservedAt,
   * id)`, with the lean fields (`EligibleCard`). This is the one place an
   * Inbox read evaluates the membership (`ELIGIBLE_ENTITIES_SQL`): the page,
   * its peers, the riding and the counts all work from the cards it returns.
   */
  const readEligibleCards = (now: string): Effect.Effect<ReadonlyArray<EligibleCard>, SqlError> =>
    Effect.map(
      sql<{
        readonly ref: string;
        readonly card: "rich" | "compact";
        readonly pace: "fast" | "slow";
        readonly patience: number;
        readonly waiting_since: string;
        readonly task_id: Uint8Array | null;
        readonly side: InboxSide;
        readonly following: number;
        readonly arrival_sequence: number | null;
      }>`
        WITH ${buildEligibleEntities(now)}
        SELECT ref, card, pace, patience,
          COALESCE(waiting_since, concerned_since, first_observed_at) AS waiting_since,
          task_id, side, following, arrival_sequence
        FROM eligible ORDER BY first_observed_at, id`,
      (rows) =>
        rows.map((row) => ({
          ref: row.ref,
          card: row.card,
          pace: row.pace,
          patience: row.patience,
          waitingSince: row.waiting_since,
          hasTask: row.task_id !== null,
          taskId: row.task_id,
          side: row.side,
          following: row.following === 1,
          arrivalSequence: row.arrival_sequence ?? 0,
        })),
    );

  /**
   * Counts the eligible cards. Every rider has no live Task, so each one is a
   * Requests card that the count leaves out, because the client draws it under
   * its lead.
   */
  const countCards = (
    cards: ReadonlyArray<EligibleCard>,
    riding: ReadonlyMap<string, string>,
  ): InboxCounts => {
    const onTheClock = cards.filter(isOnTheClock);
    return {
      onTheClock: onTheClock.length,
      requests: cards.filter((card) => card.side === "requests").length - riding.size,
      withSomeoneElse: cards.filter((card) => card.side === "with-someone-else").length,
      newestArrival: Math.max(0, ...onTheClock.map((card) => card.arrivalSequence)),
    };
  };

  /**
   * Returns which of `refs` are eligible for the Inbox at `now` (the one
   * definition in `ELIGIBLE_ENTITIES_SQL`). One statement, none for no refs.
   */
  const listEligibleRefs = (
    refs: ReadonlyArray<string>,
    now: string,
  ): Effect.Effect<ReadonlySet<string>, SqlError> =>
    refs.length === 0
      ? Effect.succeed(new Set())
      : Effect.map(
          sql<{ readonly ref: string }>`
            WITH ${buildEligibleEntities(now)}
            SELECT ref FROM eligible
            WHERE ref IN (SELECT value FROM json_each(${refsJson(refs)}))`,
          (rows) => new Set(rows.map((row) => row.ref)),
        );

  /**
   * Returns which of `refs` already hold a place: they are eligible at `now`,
   * or they concern the user. A write cannot make such a ref arrive. One
   * statement, none for no refs.
   */
  const listHeldRefs = (
    refs: ReadonlyArray<string>,
    now: string,
  ): Effect.Effect<ReadonlySet<string>, SqlError> =>
    refs.length === 0
      ? Effect.succeed(new Set())
      : Effect.map(
          sql<{ readonly ref: string }>`
            WITH ${buildEligibleEntities(now)}
            SELECT ref FROM eligible
            WHERE ref IN (SELECT value FROM json_each(${refsJson(refs)}))
            UNION
            SELECT ref FROM (${sql.literal(CONCERNED_REFS_SQL)})
            WHERE ref IN (SELECT value FROM json_each(${refsJson(refs)}))`,
          (rows) => new Set(rows.map((row) => row.ref)),
        );

  /** Takes the next number of the arrival counter. The counter only goes up, even after a prune. */
  const takeArrivalSequence = Effect.map(
    sql<{ readonly last: number }>`
      UPDATE external_entity_arrival_counter SET last = last + 1 WHERE id = 1 RETURNING last`,
    (rows) => rows[0]!.last,
  );

  return {
    buildEligibleEntities,

    listEligibleRefs,

    /**
     * Reads what the Inbox is at `now`: every eligible card, who rides on whom
     * (`decideRiding`, over every card, before any page limit) and the counts.
     * Two statements, the cards and the links among them.
     */
    readInboxStanding: (
      now: string,
    ): Effect.Effect<
      {
        readonly cards: ReadonlyArray<EligibleCard>;
        readonly riding: ReadonlyMap<string, string>;
        readonly counts: InboxCounts;
      },
      SqlError
    > =>
      Effect.gen(function* () {
        const cards = yield* readEligibleCards(now);
        const links = yield* linkReads.readLinksOf(cards.map((card) => card.ref));
        const riding = decideRiding(cards, links, Date.parse(now));
        return { cards, riding, counts: countCards(cards, riding) };
      }),

    /**
     * Runs `write`, which changes what the Inbox holds of `refs`, and returns
     * its result. Each ref that was not held before the write (not on the
     * Inbox, not concerning the user) and is on the Inbox after it, as a card
     * on the clock (a fast kind with no live Task), takes a number of the
     * arrival counter, stamped at `now`. A ref that was held already takes
     * none, so a concern that joins a card a signal holds, or a second signal,
     * is no new arrival. A card that stays off the Inbox, such as a dismissed
     * one, takes none either.
     *
     * Both the write of observations and a raised signal arrive through this
     * one rule. It looks at the Inbox before `write` runs, and runs in the
     * caller's transaction. Announces nothing.
     */
    recordArrivalsAfter: <A, E, R>(
      refs: ReadonlyArray<string>,
      now: string,
      write: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | SqlError, R> =>
      Effect.gen(function* () {
        const heldBefore = yield* listHeldRefs(refs, now);
        const written = yield* write;
        const candidates = refs.filter((ref) => !heldBefore.has(ref));
        if (candidates.length === 0) return written;
        const eligible = yield* sql<{
          readonly ref: string;
          readonly pace: "fast" | "slow";
          readonly task_id: Uint8Array | null;
        }>`
          WITH ${buildEligibleEntities(now)}
          SELECT ref, pace, task_id FROM eligible
          WHERE ref IN (SELECT value FROM json_each(${refsJson(candidates)}))`;
        const arrived = new Set(
          eligible
            .filter((row) => isOnTheClock({ pace: row.pace, hasTask: row.task_id !== null }))
            .map((row) => row.ref),
        );
        for (const ref of candidates) {
          if (!arrived.has(ref)) continue;
          yield* sql`
            UPDATE external_entities
            SET arrival_sequence = ${yield* takeArrivalSequence}, updated_at = ${now}
            WHERE ref = ${ref}`;
        }
        return written;
      }),
  };
};
