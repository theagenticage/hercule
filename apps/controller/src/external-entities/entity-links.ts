/**
 * Reads the direct links between outside things: the links of a list of refs,
 * the records at the far end of those links that have no card, the links that
 * decide riding on the Inbox, and the pairs of Tasks that may be drawn as a
 * stack on Work.
 *
 * A link here is a pair of peers under its firmest current claim (`source`,
 * then `person`, then `text`). A claim whose target is still pending
 * (`unresolved:...`) names no ref yet, so it is never a link or a peer.
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

/** One row of the links statement: the firmest current `linked` claim of a pair, with the plugin of its Connection when it has one. */
interface LinkRow {
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

/**
 * The SQL that ranks the claim types, 0 for the firmest. It is built from the
 * one list of claim types, so the order cannot differ from the rest of the code.
 */
const CLAIM_TYPE_RANK_SQL = `CASE t.claim_type ${CLAIM_TYPES_FIRMEST_FIRST.map(
  (type, rank) => `WHEN '${type}' THEN ${rank}`,
).join(" ")} END`;

/** Converts a row of the links statement to a link. */
const buildLink = (row: LinkRow): EntityLink => ({
  fromRef: row.from_ref,
  toRef: row.to_ref,
  claim: {
    type: row.claim_type,
    ...(row.plugin_id === null ? {} : { plugin: row.plugin_id }),
    ...(row.actor === null ? {} : { actor: row.actor }),
    // Only a hint names its text. A source's evidence is a URL and stays on the server.
    ...(row.claim_type === "text" && row.evidence_key !== ""
      ? { evidenceKey: row.evidence_key }
      : {}),
  },
  hasPersonClaim: row.has_person_claim === 1,
});

/**
 * Reads the direct links of `refs`: every pair that has a current `linked`
 * claim with one end in `refs`, once, under its firmest claim, in the order of
 * that claim's id. Among claims of one type the oldest wins. A claim names only
 * its plugin or its actor, never the Connection. A thing linked to itself is no
 * link, and a pending target is no end. `hasPersonClaim` is true when a person
 * also claims the pair, so the person's own claim can be removed even when a
 * source's claim hides it.
 *
 * - With `limit`, the statement cuts the list, so rows past the limit are
 *   never loaded. It returns at most `limit + 1` links, so the caller can
 *   tell that more exist. Without it, every link is returned.
 * - With `confirmedOnly`, a `text` claim is not read, so a pair that only a
 *   hint reports has no link.
 *
 * One statement however many refs there are.
 */
export const readFirmestLinks = (
  sql: SqlClient.SqlClient,
  refs: ReadonlyArray<string>,
  options: { readonly limit?: number; readonly confirmedOnly?: boolean } = {},
): Effect.Effect<Array<EntityLink>, SqlError> => {
  if (refs.length === 0) return Effect.succeed([]);
  const refsJson = JSON.stringify(refs);
  const claimTest = sql.literal(options.confirmedOnly ? EFFECTIVE_LINK_SQL : CURRENT_LINKED_SQL);
  // SQLite reads a negative LIMIT as no limit at all.
  const rowLimit = options.limit === undefined ? -1 : options.limit + 1;
  // CROSS JOIN pins the order, so each ref seeks its claims by index. UNION
  // drops the claim that both of its ends find when both are in `refs`.
  return Effect.map(
    sql<LinkRow>`
      WITH touching AS (
        SELECT c.id, c.from_ref, c.to_ref, c.claim_type, c.actor, c.connection_id, c.evidence_key
        FROM json_each(${refsJson}) r CROSS JOIN external_entity_relation_claims c
          ON c.from_ref = r.value AND ${claimTest}
        WHERE c.from_ref <> c.to_ref
        UNION
        SELECT c.id, c.from_ref, c.to_ref, c.claim_type, c.actor, c.connection_id, c.evidence_key
        FROM json_each(${refsJson}) r CROSS JOIN external_entity_relation_claims c
          ON c.to_ref = r.value AND ${claimTest}
        WHERE c.from_ref <> c.to_ref
      ),
      ranked AS (
        SELECT t.*,
          ROW_NUMBER() OVER (
            PARTITION BY min(t.from_ref, t.to_ref), max(t.from_ref, t.to_ref)
            ORDER BY ${sql.literal(CLAIM_TYPE_RANK_SQL)}, t.id) AS pair_rank,
          MAX(t.claim_type = 'person') OVER (
            PARTITION BY min(t.from_ref, t.to_ref), max(t.from_ref, t.to_ref)) AS has_person_claim
        FROM touching t
      )
      SELECT t.id, t.from_ref, t.to_ref, t.claim_type, t.actor, k.plugin_id, t.evidence_key,
        t.has_person_claim
      FROM ranked t LEFT JOIN connections k ON k.id = t.connection_id
      WHERE t.pair_rank = 1
      ORDER BY t.id
      LIMIT ${rowLimit}`,
    (rows) => rows.map(buildLink),
  );
};

/** Returns the end of `link` that is not `ref`. */
export const readFarEnd = (link: EntityLink, ref: string): string =>
  link.fromRef === ref ? link.toRef : link.fromRef;

/**
 * Builds the peer a record draws as. A record no Connection can read now is
 * restricted: it keeps its kind and noun and shows no title, identifier,
 * status or change, and it is never the user's.
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
    /** Returns the direct links of `refs` (see `readFirmestLinks` for the options). */
    readLinksOf: (
      refs: ReadonlyArray<string>,
      options?: { readonly limit?: number; readonly confirmedOnly?: boolean },
    ): Effect.Effect<Array<EntityLink>, SqlError> => readFirmestLinks(sql, refs, options),

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
