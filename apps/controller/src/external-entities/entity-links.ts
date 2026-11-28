/**
 * Reads the direct links between outside things: the links and hints of a list
 * of refs, the records at the far end of those that have no card, the links
 * that decide riding on the Inbox, and the pairs of Tasks that may be drawn as
 * a stack on Work.
 *
 * A pair of peers is drawn under its firmest current claim (`source`, then
 * `person`, then `text`). It is a link when a source or a person claims it,
 * and a hint when only text does. A claim whose target is still pending
 * (`unresolved:...`) names no ref yet, so it is never a link, a hint or a peer.
 *
 * Every read is one statement however many refs it is given.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import {
  MAX_BOARD_STACK_CANDIDATES,
  type EntityChange,
  type EntityHint,
  type EntityLink,
  type EntityPeer,
  type WorkStackCandidate,
} from "@hercule/contract";
import { uuidFromString, uuidToString } from "../db";
import {
  deriveAccess,
  deriveYours,
  findActiveKind,
  isWorkRecord,
  parseStoredStatus,
  type ActiveEntityKind,
  type EntityRow,
  type ObservationRow,
} from "./entity-records";

/** The claim types, from firmest to weakest. A pair is drawn under its firmest claim. */
export const CLAIM_TYPES_FIRMEST_FIRST = ["source", "person", "text"] as const;

export type ClaimType = (typeof CLAIM_TYPES_FIRMEST_FIRST)[number];

/**
 * The test for a link between peers that reads may show: a claim, aliased
 * `c`, that two things are linked, that is current, and whose target is a
 * ref. A claim whose target is still pending (see `pending-target.ts`) is not
 * a link yet and must not reach a client, so every read of `linked` claims
 * builds on this.
 */
export const CURRENT_LINKED_SQL =
  "c.relation = 'linked' AND c.state = 'current' AND c.is_pending = 0";

/**
 * The test for a link that joins two things: `CURRENT_LINKED_SQL` for a claim
 * a source or a person made. A `text` claim is only a hint and joins nothing.
 */
export const EFFECTIVE_LINK_SQL = `${CURRENT_LINKED_SQL} AND c.claim_type IN ('source', 'person')`;

/** One row of the pairs statement: the firmest current `linked` claim of a pair, with the plugin of its Connection when it has one. */
interface PairRow {
  readonly id: number;
  readonly from_ref: string;
  readonly to_ref: string;
  readonly claim_type: ClaimType;
  readonly actor: string | null;
  readonly plugin_id: string | null;
  /** The URL or text key the claim came from. Empty for a claim with no evidence. */
  readonly evidence_key: string;
  /** 1 when some person also claims the pair, whatever the firmest claim is. */
  readonly has_person_claim: number;
}

/** A row whose firmest claim a source or a person made: the pair is a link. */
type LinkRow = PairRow & { readonly claim_type: EntityLink["claim"]["type"] };

/**
 * The SQL that ranks the claim types, 0 for the firmest. It is built from the
 * one list of claim types, so the order cannot differ from the rest of the code.
 */
const CLAIM_TYPE_RANK_SQL = `CASE t.claim_type ${CLAIM_TYPES_FIRMEST_FIRST.map(
  (type, rank) => `WHEN '${type}' THEN ${rank}`,
).join(" ")} END`;

/** Checks that the pair joins two things. A pair whose firmest claim is `text` is a hint. */
const isLinkRow = (row: PairRow): row is LinkRow => row.claim_type !== "text";

/** Converts a row whose firmest claim is a source's or a person's to a link. */
const buildLink = (row: LinkRow): EntityLink => ({
  fromRef: row.from_ref,
  toRef: row.to_ref,
  claim: {
    type: row.claim_type,
    ...(row.plugin_id === null ? {} : { plugin: row.plugin_id }),
    ...(row.actor === null ? {} : { actor: row.actor }),
  },
  hasPersonClaim: row.has_person_claim === 1,
});

/** Converts a row whose firmest claim is `text` to a hint. */
const buildHint = (row: PairRow): EntityHint => ({
  fromRef: row.from_ref,
  toRef: row.to_ref,
  ...(row.evidence_key === "" ? {} : { evidenceKey: row.evidence_key }),
});

/**
 * Reads the firmest current `linked` claim of every pair that has one end in
 * `refs`, once, in the order of the claim's id. Among claims of one type the
 * oldest wins. A thing linked to itself is no pair, and a pending target is no
 * end. `claimTest` is the SQL test a claim must pass to be read. At most
 * `limit + 1` rows of each list (links and hints) are returned, so the caller
 * can tell that more exist; with no `limit`, every row is. With `bothEnds`,
 * only pairs whose two ends are both in `refs` are read.
 *
 * One statement however many refs there are.
 */
const readFirmestPairs = (
  sql: SqlClient.SqlClient,
  refs: ReadonlyArray<string>,
  claimTest: string,
  limit: number | undefined,
  bothEnds = false,
): Effect.Effect<ReadonlyArray<PairRow>, SqlError> => {
  if (refs.length === 0) return Effect.succeed([]);
  const refsJson = JSON.stringify(refs);
  const claimTestSql = sql.literal(claimTest);
  const rowsPerList = limit === undefined ? Number.MAX_SAFE_INTEGER : limit + 1;
  const onlyBothEnds = bothEnds ? 1 : 0;
  // CROSS JOIN pins the order, so each ref seeks its claims by index. UNION
  // drops the claim that both of its ends find when both are in `refs`.
  return sql<PairRow>`
    WITH touching AS (
      SELECT c.id, c.from_ref, c.to_ref, c.claim_type, c.actor, c.connection_id, c.evidence_key
      FROM json_each(${refsJson}) r CROSS JOIN external_entity_relation_claims c
        ON c.from_ref = r.value AND ${claimTestSql}
      WHERE c.from_ref <> c.to_ref
        AND (${onlyBothEnds} = 0 OR c.to_ref IN (SELECT value FROM json_each(${refsJson})))
      UNION
      SELECT c.id, c.from_ref, c.to_ref, c.claim_type, c.actor, c.connection_id, c.evidence_key
      FROM json_each(${refsJson}) r CROSS JOIN external_entity_relation_claims c
        ON c.to_ref = r.value AND ${claimTestSql}
      WHERE c.from_ref <> c.to_ref
        AND (${onlyBothEnds} = 0 OR c.from_ref IN (SELECT value FROM json_each(${refsJson})))
    ),
    ranked AS (
      SELECT t.*,
        ROW_NUMBER() OVER (
          PARTITION BY min(t.from_ref, t.to_ref), max(t.from_ref, t.to_ref)
          ORDER BY ${sql.literal(CLAIM_TYPE_RANK_SQL)}, t.id) AS pair_rank,
        MAX(t.claim_type = 'person') OVER (
          PARTITION BY min(t.from_ref, t.to_ref), max(t.from_ref, t.to_ref)) AS has_person_claim
      FROM touching t
    ),
    firmest AS (
      SELECT t.*,
        ROW_NUMBER() OVER (PARTITION BY t.claim_type = 'text' ORDER BY t.id) AS list_rank
      FROM ranked t
      WHERE t.pair_rank = 1
    )
    SELECT t.id, t.from_ref, t.to_ref, t.claim_type, t.actor, k.plugin_id, t.evidence_key,
      t.has_person_claim
    FROM firmest t LEFT JOIN connections k ON k.id = t.connection_id
    WHERE t.list_rank <= ${rowsPerList}
    ORDER BY t.id`;
};

/**
 * Reads the links of `refs` that join two things: every pair that a source or
 * a person claims, with one end in `refs`, once, under its firmest claim, in
 * the order of that claim's id. A `text` claim is not read, so a pair that
 * only text mentions has no link here. `hasPersonClaim` is true when a person
 * also claims the pair, so the person's own claim can be removed even when a
 * source's claim hides it. Every link is returned.
 *
 * One statement however many refs there are.
 */
export const readLinks = (
  sql: SqlClient.SqlClient,
  refs: ReadonlyArray<string>,
): Effect.Effect<Array<EntityLink>, SqlError> =>
  Effect.map(readFirmestPairs(sql, refs, EFFECTIVE_LINK_SQL, undefined), (rows) =>
    rows.filter(isLinkRow).map(buildLink),
  );

/**
 * Reads the links between two things of `refs`: every pair that a source or a
 * person claims and whose two ends are both in `refs`, once, under its firmest
 * claim, in the order of that claim's id, as `readLinks` reads them. At most
 * `limit` links are returned, and `complete` is false when more exist.
 *
 * One statement however many refs there are.
 */
export const readLinksAmong = (
  sql: SqlClient.SqlClient,
  refs: ReadonlyArray<string>,
  limit: number,
): Effect.Effect<{ readonly links: Array<EntityLink>; readonly complete: boolean }, SqlError> =>
  Effect.map(readFirmestPairs(sql, refs, EFFECTIVE_LINK_SQL, limit, true), (rows) => ({
    links: rows.filter(isLinkRow).slice(0, limit).map(buildLink),
    complete: rows.length <= limit,
  }));

/**
 * Reads the links and the hints of `refs`: every pair that has a current
 * `linked` claim with one end in `refs`, once, under its firmest claim, each
 * list in the order of that claim's id. Among claims of one type the oldest
 * wins. A pair is a link when a source or a person claims it, even if text
 * mentions it too, and a hint when only text does. A claim names only its
 * plugin or its actor, never the Connection. A thing linked to itself is no
 * pair, and a pending target is no end.
 *
 * Each list is cut by the statement, so rows past `limit` are never loaded.
 * It returns at most `limit + 1` of each, so the caller can tell that more
 * exist.
 *
 * One statement however many refs there are.
 */
export const readLinksAndHints = (
  sql: SqlClient.SqlClient,
  refs: ReadonlyArray<string>,
  limit: number,
): Effect.Effect<
  { readonly links: Array<EntityLink>; readonly hints: Array<EntityHint> },
  SqlError
> =>
  Effect.map(readFirmestPairs(sql, refs, CURRENT_LINKED_SQL, limit), (rows) => ({
    links: rows.filter(isLinkRow).map(buildLink),
    hints: rows.filter((row) => !isLinkRow(row)).map(buildHint),
  }));

/** Returns the end of `pair` that is not `ref`. */
export const readFarEnd = (
  pair: { readonly fromRef: string; readonly toRef: string },
  ref: string,
): string => (pair.fromRef === ref ? pair.toRef : pair.fromRef);

/**
 * Builds the peer a record draws as. A record no Connection can read now is
 * restricted: it keeps its kind and noun and shows no title, identifier,
 * URL, status or change, and it is never the user's.
 */
const buildPeer = (
  row: EntityRow,
  observations: ReadonlyArray<Pick<ObservationRow, "access" | "owned_by_you">>,
  latestChange: EntityChange | undefined,
): EntityPeer => {
  const base = { ref: row.ref, kind: row.kind as string, noun: row.noun as string };
  if (deriveAccess(observations) !== "ok") return { ...base, yours: false, restricted: true };
  const { status } = parseStoredStatus(row.status as string | null);
  return {
    // Only a full record of a work kind has a detail to open.
    ...(isWorkRecord(row) ? { id: uuidToString(row.id) } : {}),
    ...base,
    ...(row.identifier === null ? {} : { identifier: row.identifier as string }),
    ...(row.title === null ? {} : { title: row.title as string }),
    ...(row.url === null ? {} : { url: row.url as string }),
    ...(status === undefined ? {} : { status }),
    yours: deriveYours(observations),
    restricted: false,
    ...(latestChange === undefined ? {} : { latestChange }),
  };
};

/**
 * Builds the peer for a link target that has no record. No Connection ever
 * read it, so it is restricted like a record nobody can read now, with the
 * kind and noun of the active kind that owns its ref.
 */
const buildUnreadPeer = (ref: string, owner: ActiveEntityKind): EntityPeer => ({
  ref,
  kind: owner.kind,
  noun: owner.noun,
  yours: false,
  restricted: true,
});

/**
 * Builds the reads of links. `readLatestChanges` is the timeline's read, so a
 * peer shows the latest change at its source.
 */
export const makeEntityLinkReads = (
  sql: SqlClient.SqlClient,
  readLatestChanges: (
    refs: ReadonlyArray<string>,
    kinds?: ReadonlyArray<ActiveEntityKind>,
  ) => Effect.Effect<ReadonlyMap<string, EntityChange>, SqlError>,
) => {
  const refsJson = (refs: ReadonlyArray<string>): string => JSON.stringify(refs);

  return {
    /** Returns the links of `refs` that join two things, with no hints (see `readLinks`). */
    readLinksOf: (refs: ReadonlyArray<string>): Effect.Effect<Array<EntityLink>, SqlError> =>
      readLinks(sql, refs),

    /** Returns the links and the hints of `refs`, each list cut at `limit + 1` (see `readLinksAndHints`). */
    readLinksAndHintsOf: (
      refs: ReadonlyArray<string>,
      limit: number,
    ): Effect.Effect<
      { readonly links: Array<EntityLink>; readonly hints: Array<EntityHint> },
      SqlError
    > => readLinksAndHints(sql, refs, limit),

    /**
     * Returns the things at the far end of links as peers, sorted by ref.
     * `refs` are the far ends. A ref in `onInbox` has a card and is left out.
     *
     * - A ref with a record is a peer built from it (`buildPeer`).
     * - A ref with no record was never read by any Connection. It is a
     *   restricted peer when an active kind in `kinds` owns the ref (see
     *   `buildUnreadPeer`), else it is left out.
     *
     * Three statements: the records, their observations and their latest
     * changes.
     */
    listPeers: (
      onInbox: ReadonlySet<string>,
      refs: ReadonlyArray<string>,
      kinds: ReadonlyArray<ActiveEntityKind> | undefined,
    ): Effect.Effect<Array<EntityPeer>, SqlError> =>
      Effect.gen(function* () {
        if (refs.length === 0) return [];
        const rows = yield* sql<EntityRow>`
          SELECT * FROM external_entities
          WHERE ref IN (SELECT value FROM json_each(${refsJson(refs)}))`;
        const recordRefs = new Set(rows.map((row) => row.ref));
        const records = rows.filter((row) => !onInbox.has(row.ref));
        const unread = refs.flatMap((ref) => {
          const owner = recordRefs.has(ref) ? undefined : findActiveKind(kinds, ref);
          return owner === undefined ? [] : [buildUnreadPeer(ref, owner)];
        });
        const peerRefs = records.map((row) => row.ref);
        const observations =
          peerRefs.length === 0
            ? []
            : yield* sql<Pick<ObservationRow, "ref" | "access" | "owned_by_you">>`
                SELECT ref, access, owned_by_you FROM external_entity_observations
                WHERE ref IN (SELECT value FROM json_each(${refsJson(peerRefs)}))`;
        const latestChanges = yield* readLatestChanges(peerRefs, kinds);
        const observationsByRef = Arr.groupBy(observations, (observation) => observation.ref);
        const peers = records.map((row) =>
          buildPeer(row, observationsByRef[row.ref] ?? [], latestChanges.get(row.ref)),
        );
        return [...peers, ...unread].sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
      }),

    /**
     * Returns the pairs of Tasks among `taskIds` that may be drawn as a stack,
     * at most `MAX_BOARD_STACK_CANDIDATES`, and whether more exist. A pair is a
     * lead Task that links a rich thing, and a member Task that links a
     * compact thing with a direct, confirmed link to it. `noun` is the kind
     * noun of the member's compact thing (the lowest, when a member links
     * several).
     *
     * A hint never makes a pair. A Task is never paired with itself, so a
     * Task that links both things makes none, and a pair found through two
     * links is one candidate. Both are decided before the limit. One
     * statement over the given Tasks.
     */
    listStackCandidates: (
      taskIds: ReadonlyArray<string>,
    ): Effect.Effect<
      { readonly candidates: Array<WorkStackCandidate>; readonly truncated: boolean },
      SqlError
    > => {
      if (taskIds.length === 0) return Effect.succeed({ candidates: [], truncated: false });
      const ids = taskIds.map(uuidFromString);
      return Effect.map(
        sql<{
          readonly lead_task_id: Uint8Array;
          readonly member_task_id: Uint8Array;
          readonly noun: string;
        }>`
          WITH board_links AS (
            SELECT task_id, ref FROM task_entity_links WHERE task_id IN ${sql.in(ids)}
          ),
          pairs(rich_ref, compact_ref) AS (
            SELECT c.from_ref, c.to_ref
            FROM board_links b CROSS JOIN external_entity_relation_claims c
              ON c.from_ref = b.ref AND ${sql.literal(EFFECTIVE_LINK_SQL)}
            UNION
            SELECT c.to_ref, c.from_ref
            FROM board_links b CROSS JOIN external_entity_relation_claims c
              ON c.to_ref = b.ref AND ${sql.literal(EFFECTIVE_LINK_SQL)}
          )
          SELECT lead.task_id AS lead_task_id, member.task_id AS member_task_id,
            MIN(compact.noun) AS noun
          FROM pairs p
          JOIN external_entities rich ON rich.ref = p.rich_ref AND rich.card = 'rich'
          JOIN external_entities compact ON compact.ref = p.compact_ref AND compact.card = 'compact'
          JOIN board_links lead ON lead.ref = p.rich_ref
          JOIN board_links member ON member.ref = p.compact_ref
          WHERE lead.task_id <> member.task_id
          GROUP BY lead.task_id, member.task_id
          ORDER BY lead.task_id, member.task_id
          LIMIT ${MAX_BOARD_STACK_CANDIDATES + 1}`,
        (rows) => ({
          candidates: rows.slice(0, MAX_BOARD_STACK_CANDIDATES).map((row) => ({
            leadTaskId: uuidToString(row.lead_task_id),
            memberTaskId: uuidToString(row.member_task_id),
            noun: row.noun,
          })),
          truncated: rows.length > MAX_BOARD_STACK_CANDIDATES,
        }),
      );
    },
  };
};
