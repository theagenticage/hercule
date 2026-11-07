/**
 * The claims of two relations between External Refs, and the walks over them.
 *
 * - `part-of` points from a child to a parent. It is a graph: a thing can have
 *   many parents. It stays acyclic.
 * - `linked` is between peers and may contain loops.
 *
 * A claim is one source's word about a relation. Two Connections that report
 * the same edge make two claims, and the effective relationship of a pair is
 * worked out on read. This module reads and writes claims only. It does not
 * read entities, does not decide who may write, and does not announce
 * anything. Write methods join the caller's transaction.
 */
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  MAX_CONTEXT_DEPTH,
  MAX_GRAPH_EDGES,
  type EntityConflict,
  type EntityEdge,
  type EntityLink,
} from "@hercule/contract";
import type { EntityObservationRelations } from "@hercule/plugin-host";
import { uuidFromString } from "../db";
import { CURRENT_LINKED_SQL, EFFECTIVE_LINK_SQL, type NewLink } from "./claim-sql";
import { makeEvidenceClaims } from "./evidence-claims";
import { makePersonLinks } from "./person-links";
import { IS_REF_TARGET_SQL, pickFirmestLinks, type LinkClaimRow } from "./entity-links";

/** The relations one observation reports (see `EntityObservationRelations`). */
type ObservedRelations = Schema.Schema.Type<typeof EntityObservationRelations>;

/** The two relations a claim can state. */
type Relation = "part-of" | "linked";

/** What `applySourceRelations` found out about the claims from one ref. */
export interface RelationWrite {
  /**
   * True when a claim from this ref was added or removed, whether it is
   * current or conflicted. False when the observation repeated what is stored.
   */
  readonly changed: boolean;
  /**
   * Every claim from this ref, reported by this Connection, that is stored as
   * `conflicted` after the write: the ones refused now and the ones refused
   * earlier and still reported.
   */
  readonly conflicts: ReadonlyArray<EntityConflict>;
}

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

/** The reason stored with a claim that was refused because it closes a loop. */
const LOOP_REASON = "Part of this would make a loop: the parent is already part of this thing.";
const SELF_REASON = "A thing cannot be part of itself.";

interface ClaimRow {
  readonly id: number;
  readonly relation: Relation;
  readonly to_ref: string;
  readonly state: "current" | "conflicted";
}

interface StoredClaimRow extends ClaimRow {
  readonly from_ref: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /** Returns true when making `fromRef` part of `toRef` would close a loop of current `part-of` claims. */
  const closesLoop = (fromRef: string, toRef: string) =>
    sql<{ readonly cycle: number }>`
      WITH RECURSIVE walk_start(ref) AS (SELECT ${toRef}), ${sql.literal(WALK_UP_SQL)}
      SELECT EXISTS (SELECT 1 FROM walk_up WHERE ref = ${fromRef}) AS cycle`.pipe(
      Effect.map((rows) => rows[0]?.cycle === 1),
    );

  /**
   * Returns true when a current claim of a source or a person links the two
   * refs, in either direction. A text claim and a pending target do not count.
   */
  const hasEffectiveLink = (a: string, b: string): Effect.Effect<boolean, SqlError> =>
    sql<{ readonly found: number }>`
      SELECT EXISTS (
        SELECT 1 FROM external_entity_relation_claims c
        WHERE ${sql.literal(EFFECTIVE_LINK_SQL)}
          AND ((c.from_ref = ${a} AND c.to_ref = ${b}) OR (c.from_ref = ${b} AND c.to_ref = ${a}))
      ) AS found`.pipe(Effect.map((rows) => rows[0]?.found === 1));

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
    hasEffectiveLink,
    ...makeEvidenceClaims({ sql, hasEffectiveLink }),
    ...makePersonLinks({ sql, hasEffectiveLink }),

    /**
     * Writes the relations one Connection reports for several refs at once, as
     * `source` claims, and returns for each ref what changed and which claims
     * were refused.
     *
     * - A claim already stored keeps its id and time, and nothing is written.
     * - `complete: true` removes this Connection's other source claims from
     *   that ref. Other Connections' claims and people's claims stay.
     * - `complete: false` only adds.
     * - A new `part-of` claim that would close a loop is stored as `conflicted`
     *   with a reason, and the rest still applies. A conflicted claim is not
     *   promoted later when the loop opens, but a complete read that no longer
     *   reports it removes it, and reporting it again checks it again.
     *
     * All removals of the whole batch happen before any claim is added, and the
     * claims are added in the order of (ref, relation, target). So a batch that
     * turns B-is-part-of-A into A-is-part-of-B stores the new claim as current,
     * and which of two claims that close a loop together is refused never
     * depends on the order the source listed them.
     *
     * Fails only with a database error. The caller supplies the transaction
     * and the Connection id, so the claim is stamped with who really reported
     * it. Each ref may appear once.
     */
    applySourceRelations: (input: {
      readonly connectionId: string;
      readonly entries: ReadonlyArray<{
        readonly fromRef: string;
        readonly relations: ObservedRelations;
        readonly observedRevision: string | undefined;
      }>;
      readonly now: string;
    }): Effect.Effect<
      {
        readonly writes: ReadonlyMap<string, RelationWrite>;
        /**
         * The refs below every ref whose claims changed (those refs included),
         * as they stood before any claim was removed. Empty when nothing changed.
         */
        readonly refsBelowBefore: ReadonlyArray<string>;
        /** The far ends of the `linked` claims added or removed, sorted: their cards changed too. */
        readonly linkedPeers: ReadonlyArray<string>;
        /** The pairs that this write joined for the first time (see `NewLink`). */
        readonly newLinks: ReadonlyArray<NewLink>;
      },
      SqlError
    > =>
      Effect.gen(function* () {
        const { entries, now } = input;
        const writes = new Map<string, RelationWrite>();
        if (entries.length === 0) {
          return { writes, refsBelowBefore: [], linkedPeers: [], newLinks: [] };
        }
        const connectionId = uuidFromString(input.connectionId);
        const buildClaimKey = (relation: string, toRef: string) => `${relation}\u0000${toRef}`;

        const storedRows = yield* sql<StoredClaimRow>`
          SELECT id, from_ref, relation, to_ref, state FROM external_entity_relation_claims
          WHERE from_ref IN (SELECT value FROM json_each(${JSON.stringify(entries.map((entry) => entry.fromRef))}))
            AND connection_id = ${connectionId}
            AND claim_type = 'source' AND evidence_key = ''`;

        const storedByRef = new Map<string, Array<StoredClaimRow>>();
        for (const row of storedRows) {
          const group = storedByRef.get(row.from_ref) ?? [];
          group.push(row);
          storedByRef.set(row.from_ref, group);
        }

        // First work out the whole difference, so that no write depends on
        // which ref was handled first.
        const plans = entries.map((entry) => {
          const stored = storedByRef.get(entry.fromRef) ?? [];
          const storedKeys = new Set(stored.map((row) => buildClaimKey(row.relation, row.to_ref)));
          const desired = new Map<string, { relation: Relation; toRef: string }>();
          for (const toRef of entry.relations.partOf) {
            desired.set(buildClaimKey("part-of", toRef), { relation: "part-of", toRef });
          }
          for (const toRef of entry.relations.linked) {
            desired.set(buildClaimKey("linked", toRef), { relation: "linked", toRef });
          }
          const removed = entry.relations.complete
            ? stored.filter((row) => !desired.has(buildClaimKey(row.relation, row.to_ref)))
            : [];
          const added = [...desired.entries()]
            .filter(([key]) => !storedKeys.has(key))
            .map(([, claim]) => claim);
          return { entry, stored, removed, added };
        });

        // The refs below the ones whose claims change, read before a claim is
        // removed. Nothing is read when the observations repeat what is stored.
        const refsBelowBefore = yield* listRefsBelow(
          plans
            .filter((plan) => plan.removed.length > 0 || plan.added.length > 0)
            .map((plan) => plan.entry.fromRef),
        );

        const removedIds = plans.flatMap((plan) => plan.removed.map((row) => row.id));
        if (removedIds.length > 0) {
          yield* sql`DELETE FROM external_entity_relation_claims
            WHERE id IN (SELECT value FROM json_each(${JSON.stringify(removedIds)}))`;
        }

        const additions = plans
          .flatMap((plan) => plan.added.map((claim) => ({ fromRef: plan.entry.fromRef, ...claim })))
          .sort(
            (a, b) =>
              a.fromRef.localeCompare(b.fromRef) ||
              a.relation.localeCompare(b.relation) ||
              a.toRef.localeCompare(b.toRef),
          );
        const revisionByRef = new Map(
          entries.map((entry) => [entry.fromRef, entry.observedRevision]),
        );
        const refusedByRef = new Map<string, Array<EntityConflict>>();
        const newLinks: Array<NewLink> = [];
        const linkedPeers = new Set<string>(
          plans.flatMap((plan) =>
            plan.removed.filter((row) => row.relation === "linked").map((row) => row.to_ref),
          ),
        );
        for (const { fromRef, relation, toRef } of additions) {
          if (relation === "linked") linkedPeers.add(toRef);
          const wasLinked =
            relation === "linked" && fromRef !== toRef && (yield* hasEffectiveLink(fromRef, toRef));
          const conflictReason =
            relation !== "part-of"
              ? null
              : toRef === fromRef
                ? SELF_REASON
                : (yield* closesLoop(fromRef, toRef))
                  ? LOOP_REASON
                  : null;
          const observedRevision = revisionByRef.get(fromRef);
          yield* sql`
            INSERT INTO external_entity_relation_claims
              (from_ref, relation, to_ref, claim_type, connection_id, actor, evidence_key,
               observed_revision, state, conflict_reason, observed_at)
            VALUES (${fromRef}, ${relation}, ${toRef}, 'source', ${connectionId}, NULL, '',
                    ${observedRevision ?? null},
                    ${conflictReason === null ? "current" : "conflicted"}, ${conflictReason}, ${now})`;
          if (relation === "linked" && fromRef !== toRef && !wasLinked) {
            newLinks.push({ fromRef, toRef });
          }
          if (conflictReason !== null) {
            const refused = refusedByRef.get(fromRef) ?? [];
            refused.push({ fromRef, relation, toRef, reason: conflictReason });
            refusedByRef.set(fromRef, refused);
          }
        }

        for (const { entry, stored, removed, added } of plans) {
          const { fromRef, observedRevision } = entry;
          // A claim that stays keeps its id and time. Only its record of the
          // source's revision follows the source.
          if (observedRevision !== undefined) {
            yield* sql`
              UPDATE external_entity_relation_claims SET observed_revision = ${observedRevision}
              WHERE from_ref = ${fromRef} AND connection_id = ${connectionId}
                AND claim_type = 'source' AND evidence_key = ''
                AND observed_revision IS NOT ${observedRevision}`;
          }
          const removedHere = new Set(removed.map((row) => row.id));
          const keptConflicts: Array<EntityConflict> = stored
            .filter((row) => row.state === "conflicted" && !removedHere.has(row.id))
            .map((row) => ({
              fromRef,
              relation: row.relation,
              toRef: row.to_ref,
              reason: row.to_ref === fromRef ? SELF_REASON : LOOP_REASON,
            }));
          const conflicts = [...keptConflicts, ...(refusedByRef.get(fromRef) ?? [])].sort(
            (a, b) => a.relation.localeCompare(b.relation) || a.toRef.localeCompare(b.toRef),
          );
          writes.set(fromRef, { changed: removed.length > 0 || added.length > 0, conflicts });
        }
        return { writes, refsBelowBefore, linkedPeers: [...linkedPeers].sort(), newLinks };
      }),

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
     * Returns `refs` and every ref below them, in one walk down the current
     * `part-of` claims, sorted. Nothing is cut: a caller that announces a
     * change to everything under a parent must not miss a deep descendant.
     */
    listRefsBelow,

    /**
     * Returns the peers `ref` is linked to and the claims refused on `ref`,
     * for the detail read of one entity.
     *
     * A pair of peers appears once, in either direction, under its firmest
     * claim: `source`, then `person`, then `text`. A claim names only its
     * plugin or its actor, never the Connection. The conflicts are the
     * claims stored as `conflicted` that start or end at `ref`.
     */
    readClaimsFor: (
      ref: string,
    ): Effect.Effect<
      {
        readonly links: ReadonlyArray<EntityLink>;
        readonly conflicts: ReadonlyArray<EntityConflict>;
      },
      SqlError
    > =>
      Effect.gen(function* () {
        const linkClaims = yield* sql<LinkClaimRow>`
          SELECT c.id, c.from_ref, c.to_ref, c.claim_type, c.actor, k.plugin_id, c.evidence_key
          FROM external_entity_relation_claims c
          LEFT JOIN connections k ON k.id = c.connection_id
          WHERE ${sql.literal(CURRENT_LINKED_SQL)} AND c.from_ref = ${ref}
            AND ${sql.literal(IS_REF_TARGET_SQL)}
          UNION ALL
          SELECT c.id, c.from_ref, c.to_ref, c.claim_type, c.actor, k.plugin_id, c.evidence_key
          FROM external_entity_relation_claims c
          LEFT JOIN connections k ON k.id = c.connection_id
          WHERE ${sql.literal(CURRENT_LINKED_SQL)} AND c.to_ref = ${ref}
            AND c.from_ref <> ${ref}`;
        const links = pickFirmestLinks(linkClaims);

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
});

export { CURRENT_LINKED_SQL, EFFECTIVE_LINK_SQL, type NewLink };

/** The relation claim repository. Requires the database only. */
export const relationClaimRepository = make;
