/**
 * The walks over `part-of` claims and the reads of one entity's links and
 * refused claims. Reads only: every write to the claims is in `claims.ts`.
 *
 * - `part-of` points from a child to a parent. It is a graph: a thing can have
 *   many parents. It stays acyclic.
 * - `linked` is between peers and may contain loops.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  MAX_CONTEXT_DEPTH,
  MAX_GRAPH_EDGES,
  type EntityConflict,
  type EntityEdge,
  type EntityLink,
} from "@hercule/contract";
import { readFirmestLinks } from "./entity-links";

/** The two relations a claim can state. */
export type Relation = "part-of" | "linked";

/** The result of walking up `part-of` from a list of refs (see `readAncestors`). */
export interface AncestorWalk {
  /** Each start ref's ancestors, each once, nearest first (fewest steps, then ref order). */
  readonly ancestors: ReadonlyMap<string, ReadonlyArray<string>>;
  /** Every distinct `part-of` edge the walk crossed, at most `MAX_GRAPH_EDGES`. */
  readonly edges: ReadonlyArray<EntityEdge>;
  /** The start refs that have more ancestors above depth `MAX_CONTEXT_DEPTH` than the walk read. */
  readonly cutRefs: ReadonlySet<string>;
  /**
   * True when the walk as a whole hit its edge or state limit, so no start
   * ref's ancestors or edges can be trusted to be complete.
   */
  readonly cutAll: boolean;
}

/**
 * The states a walk up may produce beyond one per start: room for the edges a
 * reply may carry at each level. Every walk up the graph (the reads of a
 * reply here, and the question of which refs to keep true in the repository)
 * stops at its starts plus this, so a wide graph cannot cost unbounded work.
 */
export const WALK_STATE_ROOM = MAX_GRAPH_EDGES * MAX_CONTEXT_DEPTH;

/**
 * The most (start ref, ancestor, depth) states one walk up may produce. Every
 * start gets one state of its own, and the rest is `WALK_STATE_ROOM`.
 */
const computeStateBudget = (startCount: number) => startCount + WALK_STATE_ROOM;

/**
 * The test for an edge the walks follow: a claim, aliased `c`, that a child is
 * part of a parent and is current (not refused). Every statement that walks
 * `part-of` builds on it, so what counts as an edge is decided here once.
 */
export const CURRENT_PART_OF_SQL = "c.relation = 'part-of' AND c.state = 'current'";

/**
 * A recursive common table expression, `walk_up(ref)`: the refs in
 * `walk_start(ref)` and every ref above them, however many levels. The
 * statement that uses it defines `walk_start` before it, and uses one walk
 * (up or down) at a time.
 */
export const WALK_UP_SQL = `
  walk_up(ref) AS (
    SELECT ref FROM walk_start
    UNION
    SELECT c.to_ref
    FROM walk_up u JOIN external_entity_relation_claims c ON c.from_ref = u.ref
    WHERE ${CURRENT_PART_OF_SQL}
  )`;

/** Like `WALK_UP_SQL`, but `walk_down(ref)` holds the refs in `walk_start(ref)` and everything below them. */
export const WALK_DOWN_SQL = `
  walk_down(ref) AS (
    SELECT ref FROM walk_start
    UNION
    SELECT c.from_ref
    FROM walk_down d JOIN external_entity_relation_claims c ON c.to_ref = d.ref
    WHERE ${CURRENT_PART_OF_SQL}
  )`;

/**
 * Builds the walks and reads over the claims. Needs the database only.
 */
export const makeClaimGraph = (sql: SqlClient.SqlClient) => {
  /** Returns true when making `fromRef` part of `toRef` would close a loop of current `part-of` claims. */
  const closesLoop = (fromRef: string, toRef: string) =>
    sql<{ readonly cycle: number }>`
      WITH RECURSIVE walk_start(ref) AS (SELECT ${toRef}), ${sql.literal(WALK_UP_SQL)}
      SELECT EXISTS (SELECT 1 FROM walk_up WHERE ref = ${fromRef}) AS cycle`.pipe(
      Effect.map((rows) => rows[0]?.cycle === 1),
    );

  /** Returns `refs` and every ref below them, sorted. Never cut. */
  const listRefsBelow = (
    refs: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<string>, SqlError> =>
    refs.length === 0
      ? Effect.succeed([])
      : sql<{ readonly ref: string }>`
          WITH RECURSIVE
          walk_start(ref) AS (SELECT value FROM json_each(${JSON.stringify([...new Set(refs)])})),
          ${sql.literal(WALK_DOWN_SQL)}
          SELECT ref FROM walk_down ORDER BY ref`.pipe(
          Effect.map((rows) => rows.map((row) => row.ref)),
        );

  return {
    closesLoop,
    listRefsBelow,
    /**
     * Walks up the current `part-of` claims from each of `refs` in one
     * statement, however many refs there are, and returns every ancestor of
     * each ref once, with the distinct edges the walk crossed.
     *
     * The walk stops at `MAX_CONTEXT_DEPTH` levels. A ref whose ancestor at that
     * depth has parents of its own is in `cutRefs`. The walk also stops at a
     * budget of states and at `MAX_GRAPH_EDGES` edges: then `cutAll` is true.
     * A thing reached by paths of different lengths is walked once per
     * length, so the limits bound the work. Reads no entity: a ref with no
     * record is still a ref.
     */
    readAncestors: (refs: ReadonlyArray<string>): Effect.Effect<AncestorWalk, SqlError> =>
      Effect.gen(function* () {
        const starts = [...new Set(refs)];
        const ancestors = new Map<string, Array<string>>(starts.map((ref) => [ref, []]));
        if (starts.length === 0) {
          return { ancestors, edges: [], cutRefs: new Set(), cutAll: false };
        }
        const budget = computeStateBudget(starts.length);

        // The walk keeps states, not paths, so a diamond is walked once per
        // distinct length. The `UNION` drops repeated states, which is also what
        // makes two Connections reporting one edge cost nothing extra. The walk
        // is materialized so the three results below read it once.
        const rows = yield* sql<{
          readonly row_type: "ancestor" | "edge" | "depth-cut" | "state-cut";
          readonly start_ref: string | null;
          readonly ref: string | null;
          readonly to_ref: string | null;
          readonly depth: number | null;
        }>`
          WITH RECURSIVE
          walk(start_ref, ancestor_ref, depth) AS (
            SELECT value, value, 0 FROM json_each(${JSON.stringify(starts)})
            UNION
            SELECT w.start_ref, c.to_ref, w.depth + 1
            FROM walk w JOIN external_entity_relation_claims c
              ON c.from_ref = w.ancestor_ref AND ${sql.literal(CURRENT_PART_OF_SQL)}
            WHERE w.depth < ${MAX_CONTEXT_DEPTH}
            LIMIT ${budget + 1}
          ),
          walked AS MATERIALIZED (SELECT start_ref, ancestor_ref, depth FROM walk),
          -- CROSS JOIN pins the order: without it SQLite scans every current
          -- claim and builds an index over the walk instead of seeking each node.
          crossed(from_ref, to_ref) AS MATERIALIZED (
            SELECT DISTINCT c.from_ref, c.to_ref
            FROM (SELECT DISTINCT ancestor_ref FROM walked WHERE depth < ${MAX_CONTEXT_DEPTH}) n
            CROSS JOIN external_entity_relation_claims c
              ON c.from_ref = n.ancestor_ref AND ${sql.literal(CURRENT_PART_OF_SQL)}
            ORDER BY c.from_ref, c.to_ref
            LIMIT ${MAX_GRAPH_EDGES + 1}
          )
          SELECT 'ancestor' AS row_type, start_ref, ancestor_ref AS ref, NULL AS to_ref, MIN(depth) AS depth
          FROM walked WHERE depth > 0 GROUP BY start_ref, ancestor_ref
          UNION ALL
          SELECT 'edge', NULL, from_ref, to_ref, NULL FROM crossed
          UNION ALL
          SELECT DISTINCT 'depth-cut', w.start_ref, NULL, NULL, NULL FROM walked w
          WHERE w.depth = ${MAX_CONTEXT_DEPTH} AND EXISTS (
            SELECT 1 FROM external_entity_relation_claims c
            WHERE c.from_ref = w.ancestor_ref AND ${sql.literal(CURRENT_PART_OF_SQL)})
          UNION ALL
          SELECT 'state-cut', NULL, NULL, NULL, NULL
          WHERE (SELECT COUNT(*) FROM walked) > ${budget}`;

        const depths = new Map<string, Array<{ ref: string; depth: number }>>();
        const edges: Array<EntityEdge> = [];
        const cutRefs = new Set<string>();
        let cutAll = false;
        for (const row of rows) {
          if (row.row_type === "ancestor") {
            const list = depths.get(row.start_ref!) ?? [];
            list.push({ ref: row.ref!, depth: row.depth! });
            depths.set(row.start_ref!, list);
          } else if (row.row_type === "edge") {
            edges.push({ fromRef: row.ref!, toRef: row.to_ref! });
          } else if (row.row_type === "depth-cut") {
            cutRefs.add(row.start_ref!);
          } else {
            cutAll = true;
          }
        }
        for (const [start, list] of depths) {
          list.sort((a, b) => a.depth - b.depth || a.ref.localeCompare(b.ref));
          ancestors.set(
            start,
            list.map((entry) => entry.ref),
          );
        }
        // The extra edge past the limit is only a sign that the limit was hit.
        if (edges.length > MAX_GRAPH_EDGES) {
          cutAll = true;
          edges.length = MAX_GRAPH_EDGES;
        }
        return { ancestors, edges, cutRefs, cutAll };
      }),

    /**
     * Returns the peers `ref` is linked to and the claims refused on `ref`,
     * for the detail read of one entity.
     *
     * A pair of peers appears once, in either direction, under its firmest
     * claim: `source`, then `person`, then `text` (see `readFirmestLinks`).
     * It returns at most `limit + 1` links, so the caller can tell that some
     * were cut. A claim names only its plugin or its actor, never the
     * Connection. The conflicts are the claims stored as `conflicted` that
     * start or end at `ref`.
     */
    readClaimsFor: (
      ref: string,
      limit: number,
    ): Effect.Effect<
      {
        readonly links: ReadonlyArray<EntityLink>;
        readonly conflicts: ReadonlyArray<EntityConflict>;
      },
      SqlError
    > =>
      Effect.gen(function* () {
        const links = yield* readFirmestLinks(sql, [ref], { limit });

        const refused = yield* sql<{
          readonly from_ref: string;
          readonly relation: Relation;
          readonly to_ref: string;
          readonly conflict_reason: string;
        }>`
          SELECT from_ref, relation, to_ref, conflict_reason
          FROM external_entity_relation_claims
          WHERE state = 'conflicted' AND from_ref = ${ref}
          UNION
          SELECT from_ref, relation, to_ref, conflict_reason
          FROM external_entity_relation_claims
          WHERE state = 'conflicted' AND to_ref = ${ref}
          ORDER BY from_ref, relation, to_ref`;
        const conflicts = refused.map((row) => ({
          fromRef: row.from_ref,
          relation: row.relation,
          toRef: row.to_ref,
          reason: row.conflict_reason,
        }));
        return { links, conflicts };
      }),
  };
};
