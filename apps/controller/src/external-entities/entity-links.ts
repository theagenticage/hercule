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
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
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
  isWorkRecord,
  parseStoredStatus,
  type EntityRow,
  type ObservationRow,
} from "./entity-records";
import { PENDING_TARGET_PREFIX } from "./pending-target";
import type { RidingCard, RidingLink } from "./riding";

/**
 * The SQL condition that the target `to_ref` of the claim `c` is a ref. A
 * pending target is not, so a pending claim is neither a link nor a peer.
 */
export const IS_REF_TARGET_SQL = `substr(c.to_ref, 1, ${PENDING_TARGET_PREFIX.length}) <> '${PENDING_TARGET_PREFIX}'`;

/** The claims that make a pair a link, and the claims that make one join: a hint (`text`) joins nothing. */
const CONFIRMED_CLAIMS_SQL = `c.claim_type IN ('source', 'person')`;

/** The longest `evidenceKey` a link carries (see `EntityLink`). */
const MAX_LINK_EVIDENCE_KEY_LENGTH = 128;

/** Orders the claim types from firmest to weakest. */
const CLAIM_FIRMNESS = { source: 0, person: 1, text: 2 } as const;

/** One current `linked` claim, with the plugin of its Connection when it has one. */
export interface LinkClaimRow {
  readonly id: number;
  readonly from_ref: string;
  readonly to_ref: string;
  readonly claim_type: keyof typeof CLAIM_FIRMNESS;
  readonly actor: string | null;
  readonly plugin_id: string | null;
  /** The URL or text key the claim came from. Empty for a claim with no evidence. */
  readonly evidence_key: string;
}

/**
 * Builds the links from claims: a pair of peers appears once, in either
 * direction, under its firmest claim. Among claims of one type the oldest
 * wins. A claim names only its plugin or its actor, never the Connection. A
 * thing linked to itself is no link. The links come in the order of their
 * claims' ids.
 */
export const pickFirmestLinks = (claims: ReadonlyArray<LinkClaimRow>): Array<EntityLink> => {
  const firmest = new Map<string, LinkClaimRow>();
  for (const claim of claims) {
    if (claim.from_ref === claim.to_ref) continue;
    const pair = [claim.from_ref, claim.to_ref].sort().join("\u0000");
    const best = firmest.get(pair);
    if (
      best === undefined ||
      CLAIM_FIRMNESS[claim.claim_type] < CLAIM_FIRMNESS[best.claim_type] ||
      (claim.claim_type === best.claim_type && claim.id < best.id)
    ) {
      firmest.set(pair, claim);
    }
  }
  return [...firmest.values()]
    .sort((a, b) => a.id - b.id)
    .map((claim) => ({
      fromRef: claim.from_ref,
      toRef: claim.to_ref,
      claim: {
        type: claim.claim_type,
        ...(claim.plugin_id === null ? {} : { plugin: claim.plugin_id }),
        ...(claim.actor === null ? {} : { actor: claim.actor }),
        // Only a hint names its text. A source's evidence is a URL and stays on the server.
        ...(claim.claim_type === "text" && claim.evidence_key !== ""
          ? { evidenceKey: claim.evidence_key.slice(0, MAX_LINK_EVIDENCE_KEY_LENGTH) }
          : {}),
      },
    }));
};

/** Returns the end of `link` that is not `ref`. */
export const readFarEnd = (link: EntityLink, ref: string): string =>
  link.fromRef === ref ? link.toRef : link.fromRef;

/**
 * Builds the peer a record draws as. A record no Connection can read now is
 * restricted: it keeps its kind and noun and shows no title, identifier,
 * status or change, and it is never the user's.
 */
export const buildPeer = (
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

/** The cards and links that decide riding, read from the Inbox's population. */
export interface RidingInputs {
  readonly cards: ReadonlyArray<RidingCard>;
  readonly links: ReadonlyArray<RidingLink>;
}

/**
 * Builds the reads of links. `readLatestChanges` is the timeline's read, so a
 * peer shows the latest change at its source.
 */
export const makeEntityLinkReads = (
  sql: SqlClient.SqlClient,
  readLatestChanges: (
    refs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, EntityChange>, SqlError>,
) => {
  const refsJson = (refs: ReadonlyArray<string>): string => JSON.stringify(refs);

  return {
    /**
     * Returns the direct links of `refs`: every pair that has a current
     * `linked` claim with one end in `refs`, once, under its firmest claim,
     * pending targets left out. One statement however many refs there are.
     * With `confirmedOnly`, a `text` claim is not read, so a pair that only
     * a hint reports has no link.
     */
    readLinksOf: (
      refs: ReadonlyArray<string>,
      options: { readonly confirmedOnly: boolean } = { confirmedOnly: false },
    ): Effect.Effect<Array<EntityLink>, SqlError> => {
      if (refs.length === 0) return Effect.succeed([]);
      const claimTypes = sql.literal(options.confirmedOnly ? `AND ${CONFIRMED_CLAIMS_SQL}` : "");
      // CROSS JOIN pins the order, so each ref seeks its claims by index.
      return Effect.map(
        sql<LinkClaimRow>`
          SELECT c.id, c.from_ref, c.to_ref, c.claim_type, c.actor, k.plugin_id, c.evidence_key
          FROM json_each(${refsJson(refs)}) r CROSS JOIN external_entity_relation_claims c
            ON c.from_ref = r.value AND c.relation = 'linked' AND c.state = 'current'
          LEFT JOIN connections k ON k.id = c.connection_id
          WHERE ${sql.literal(IS_REF_TARGET_SQL)} ${claimTypes}
          UNION ALL
          SELECT c.id, c.from_ref, c.to_ref, c.claim_type, c.actor, k.plugin_id, c.evidence_key
          FROM json_each(${refsJson(refs)}) r CROSS JOIN external_entity_relation_claims c
            ON c.to_ref = r.value AND c.relation = 'linked' AND c.state = 'current'
          LEFT JOIN connections k ON k.id = c.connection_id
          WHERE c.from_ref <> c.to_ref ${claimTypes}`,
        pickFirmestLinks,
      );
    },

    /**
     * Reads what decides riding over the whole Inbox: the cards that have a
     * confirmed link (`source` or `person`) to a card of the other kind, and
     * those links. A card with no such link can neither ride nor lead, so it
     * is not read. `eligible` is the Inbox's membership, as the common table
     * expressions that define `eligible`. One statement, whatever the number
     * of cards.
     */
    readRidingInputs: (eligible: Statement.Fragment): Effect.Effect<RidingInputs, SqlError> =>
      Effect.map(
        sql<{
          readonly from_ref: string;
          readonly to_ref: string;
          readonly claim_type: LinkClaimRow["claim_type"];
          readonly from_card: "rich" | "compact";
          readonly from_pace: "fast" | "slow";
          readonly from_patience: number;
          readonly from_waiting_since: string;
          readonly from_has_task: number;
          readonly to_card: "rich" | "compact";
          readonly to_pace: "fast" | "slow";
          readonly to_patience: number;
          readonly to_waiting_since: string;
          readonly to_has_task: number;
        }>`
          WITH ${eligible}
          SELECT c.from_ref, c.to_ref, c.claim_type,
            a.card AS from_card, a.pace AS from_pace,
            a.patience AS from_patience,
            COALESCE(a.waiting_since, a.concerned_since, a.first_observed_at) AS from_waiting_since,
            a.task_id IS NOT NULL AS from_has_task,
            b.card AS to_card, b.pace AS to_pace,
            b.patience AS to_patience,
            COALESCE(b.waiting_since, b.concerned_since, b.first_observed_at) AS to_waiting_since,
            b.task_id IS NOT NULL AS to_has_task
          FROM eligible a
          JOIN external_entity_relation_claims c
            ON c.from_ref = a.ref AND c.relation = 'linked' AND c.state = 'current'
              AND ${sql.literal(CONFIRMED_CLAIMS_SQL)}
          JOIN eligible b ON b.ref = c.to_ref
          WHERE a.card <> b.card`,
        (rows) => {
          const cards = new Map<string, RidingCard>();
          for (const row of rows) {
            cards.set(row.from_ref, {
              ref: row.from_ref,
              card: row.from_card,
              pace: row.from_pace,
              patience: row.from_patience,
              waitingSince: row.from_waiting_since,
              hasTask: row.from_has_task === 1,
            });
            cards.set(row.to_ref, {
              ref: row.to_ref,
              card: row.to_card,
              pace: row.to_pace,
              patience: row.to_patience,
              waitingSince: row.to_waiting_since,
              hasTask: row.to_has_task === 1,
            });
          }
          return {
            cards: [...cards.values()],
            links: rows.map((row) => ({
              fromRef: row.from_ref,
              toRef: row.to_ref,
              claim: { type: row.claim_type },
            })),
          };
        },
      ),

    /**
     * Returns the records of `refs` that have no card, as peers, sorted by
     * ref: a ref with no record is left out (a reply invents none), and so is
     * a ref that is on the Inbox. `eligible` is the Inbox's membership, as in
     * `readRidingInputs`. Three statements: the records, their observations
     * and their latest changes.
     */
    listPeers: (
      eligible: Statement.Fragment,
      refs: ReadonlyArray<string>,
    ): Effect.Effect<Array<EntityPeer>, SqlError> =>
      Effect.gen(function* () {
        if (refs.length === 0) return [];
        const rows = yield* sql<EntityRow>`
          WITH ${eligible}
          SELECT e.* FROM external_entities e
          WHERE e.ref IN (SELECT value FROM json_each(${refsJson(refs)}))
            AND NOT EXISTS (SELECT 1 FROM eligible x WHERE x.ref = e.ref)
          ORDER BY e.ref`;
        const peerRefs = rows.map((row) => row.ref);
        if (peerRefs.length === 0) return [];
        const observations = yield* sql<Pick<ObservationRow, "ref" | "access" | "owned_by_you">>`
          SELECT ref, access, owned_by_you FROM external_entity_observations
          WHERE ref IN (SELECT value FROM json_each(${refsJson(peerRefs)}))`;
        const latestChanges = yield* readLatestChanges(peerRefs);
        return rows.map((row) =>
          buildPeer(
            row,
            observations.filter((observation) => observation.ref === row.ref),
            latestChanges.get(row.ref),
          ),
        );
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
              ON c.from_ref = b.ref AND c.relation = 'linked' AND c.state = 'current'
            WHERE ${sql.literal(CONFIRMED_CLAIMS_SQL)}
            UNION
            SELECT c.to_ref, c.from_ref
            FROM board_links b CROSS JOIN external_entity_relation_claims c
              ON c.to_ref = b.ref AND c.relation = 'linked' AND c.state = 'current'
            WHERE ${sql.literal(CONFIRMED_CLAIMS_SQL)}
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
