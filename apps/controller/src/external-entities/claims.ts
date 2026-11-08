/**
 * The claims between External Refs: the one module that writes them.
 *
 * A claim is one source's or one person's word about a relation (`part-of` or
 * `linked`) between two refs. Two Connections that report the same edge make
 * two claims, and the effective relationship of a pair is worked out on read
 * (see `entity-links.ts` and `claim-graph.ts`).
 *
 * The module has three operations that write, and each returns one
 * `ClaimChanges`:
 *
 * - `applyObservedClaims` writes the parents, peers, addresses and texts that
 *   a batch of observations reports (see `observed-claims.ts`);
 * - `changePersonLink` writes or removes a person's own link between two
 *   things;
 * - `settlePendingTarget` gives a claim that waited for a read its ref, or
 *   postpones it.
 *
 * Which links are new, and which refs changed, is decided in here, once per
 * operation. The caller applies the `ClaimChanges` to the rest of the domain
 * (timelines, announcements). This module reads no entity, decides nobody's
 * rights and announces nothing. Writes join the caller's transaction.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { uuidFromString } from "../db";
import { NO_CLAIM_CHANGES, findNewLinks, type ClaimChanges } from "./claim-changes";
import { makeClaimGraph } from "./claim-graph";
import { CLAIM_TYPES_FIRMEST_FIRST, CURRENT_LINKED_SQL, type ClaimType } from "./entity-links";
import { makeObservedClaims } from "./observed-claims";
import { postponeClaims } from "./retry-backoff";

export type { ClaimChanges, NewLink } from "./claim-changes";
export type { AncestorWalk } from "./claim-graph";
export type { ObservedClaims, RecognizedEvidence } from "./observed-claims";

/** What a lookup found for one pending claim. */
export type ClaimResolutionOutcome =
  /** The lookup found exactly one thing. The claim's target becomes its ref. */
  | { readonly kind: "found"; readonly ref: string }
  /** A web address was recognized as a scoped thing. The claim stays pending under the new target. */
  | { readonly kind: "recognized"; readonly target: string };

/** A person's change to the links between two things. */
export type PersonLinkChange =
  /** The actor claims that `fromRef` is linked to `toRef`. */
  | {
      readonly change: "link";
      readonly fromRef: string;
      readonly toRef: string;
      readonly actor: string;
      readonly now: string;
    }
  /** Removes every person claim between the two refs, in either direction. */
  | { readonly change: "unlink"; readonly fromRef: string; readonly toRef: string };

/** What `changePersonLink` changed, and what a person needs to know of it. */
export interface PersonLinkChanges extends ClaimChanges {
  /**
   * False when a `link` found that Hercule holds no record of `fromRef`, so it
   * wrote nothing. Always true for an `unlink`.
   */
  readonly fromRefKnown: boolean;
  /**
   * The firmest claim that still joins the two refs after an `unlink` (a
   * source's or a hint), when one does.
   */
  readonly remaining: ClaimType | undefined;
}

/** A pending claim that a lookup answered for, as stored. */
interface PendingClaim {
  readonly id: number;
  readonly from_ref: string;
  readonly claim_type: "source" | "text";
  readonly to_ref: string;
  readonly resolve_attempts: number;
  readonly connection_id: Uint8Array;
  readonly in_baseline: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const graph = makeClaimGraph(sql);

  /** Writes the person claim or removes the person claims between two refs. */
  const changePersonLink = (change: PersonLinkChange): Effect.Effect<PersonLinkChanges, SqlError> =>
    Effect.gen(function* () {
      const { fromRef, toRef } = change;
      const changedRefs = [fromRef, toRef].sort();
      if (change.change === "link") {
        const { actor, now } = change;
        const known = yield* sql<{ readonly id: Uint8Array }>`
          SELECT id FROM external_entities WHERE ref = ${fromRef}`;
        if (known.length === 0) {
          return { ...NO_CLAIM_CHANGES, fromRefKnown: false, remaining: undefined };
        }
        const existing = yield* sql<{ readonly id: number }>`
          SELECT id FROM external_entity_relation_claims
          WHERE claim_type = 'person' AND relation = 'linked' AND actor = ${actor}
            AND ((from_ref = ${fromRef} AND to_ref = ${toRef})
              OR (from_ref = ${toRef} AND to_ref = ${fromRef}))
          LIMIT 1`;
        if (existing.length > 0) {
          return { ...NO_CLAIM_CHANGES, fromRefKnown: true, remaining: undefined };
        }
        yield* sql`
          INSERT INTO external_entity_relation_claims
            (from_ref, relation, to_ref, claim_type, connection_id, actor, evidence_key,
             observed_revision, state, conflict_reason, observed_at)
          VALUES (${fromRef}, 'linked', ${toRef}, 'person', NULL, ${actor}, '',
                  NULL, 'current', NULL, ${now})`;
        // A person's own link is not news from outside, so it is no new link.
        return { ...NO_CLAIM_CHANGES, changedRefs, fromRefKnown: true, remaining: undefined };
      }

      const removed = yield* sql<{ readonly id: number }>`
        DELETE FROM external_entity_relation_claims
        WHERE claim_type = 'person' AND relation = 'linked'
          AND ((from_ref = ${fromRef} AND to_ref = ${toRef})
            OR (from_ref = ${toRef} AND to_ref = ${fromRef}))
        RETURNING id`;
      const left = yield* sql<{ readonly claim_type: ClaimType }>`
        SELECT DISTINCT c.claim_type FROM external_entity_relation_claims c
        WHERE ${sql.literal(CURRENT_LINKED_SQL)}
          AND ((c.from_ref = ${fromRef} AND c.to_ref = ${toRef})
            OR (c.from_ref = ${toRef} AND c.to_ref = ${fromRef}))`;
      return {
        ...NO_CLAIM_CHANGES,
        ...(removed.length > 0 ? { changedRefs } : {}),
        fromRefKnown: true,
        remaining: CLAIM_TYPES_FIRMEST_FIRST.find((type) =>
          left.some((row) => row.claim_type === type),
        ),
      };
    });

  /**
   * Settles one claim after a lookup. The claim is written only when it still
   * holds `expectedTarget` and is still pending; otherwise nothing changes.
   *
   * - `found` rewrites the target to the ref, keeping the claim's type,
   *   Connection and id. The claim is postponed instead when the ref is the
   *   claim's own origin, or when another claim of the same Connection and
   *   text already holds the ref, which the unique key refuses: it waits
   *   instead of being deleted, so the next report of its text does not
   *   create it again.
   * - `recognized` rewrites a web address to the scoped target it names, and
   *   leaves it pending and due.
   */
  const settlePendingTarget = (input: {
    readonly claimId: number;
    readonly expectedTarget: string;
    readonly outcome: ClaimResolutionOutcome;
    readonly now: string;
  }): Effect.Effect<ClaimChanges, SqlError> =>
    Effect.gen(function* () {
      const { outcome, now } = input;
      const found = yield* sql<PendingClaim>`
        SELECT id, from_ref, claim_type, to_ref, resolve_attempts, connection_id, in_baseline
        FROM external_entity_relation_claims
        WHERE id = ${input.claimId} AND to_ref = ${input.expectedTarget} AND is_pending = 1`;
      const claim = found[0];
      if (claim === undefined) return NO_CLAIM_CHANGES;

      if (outcome.kind === "recognized") {
        yield* sql`
          UPDATE external_entity_relation_claims SET to_ref = ${outcome.target}
          WHERE id = ${claim.id}`;
        return NO_CLAIM_CHANGES;
      }
      if (outcome.ref !== claim.from_ref) {
        const duplicate =
          claim.claim_type === "text"
            ? yield* sql<{ readonly id: number }>`
                SELECT c.id FROM external_entity_relation_claims c
                WHERE c.from_ref = ${claim.from_ref} AND c.relation = 'linked'
                  AND c.to_ref = ${outcome.ref} AND c.connection_id = ${claim.connection_id}
                  AND c.claim_type = 'text' AND c.id <> ${claim.id}
                  AND c.evidence_key = (
                    SELECT evidence_key FROM external_entity_relation_claims WHERE id = ${claim.id})`
            : [];
        if (duplicate.length === 0) {
          const newLinks =
            claim.claim_type === "source"
              ? yield* findNewLinks(sql, [
                  {
                    fromRef: claim.from_ref,
                    toRef: outcome.ref,
                    inBaseline: claim.in_baseline === 1,
                  },
                ])
              : [];
          yield* sql`
            UPDATE external_entity_relation_claims
            SET to_ref = ${outcome.ref}, resolve_attempts = 0, next_resolve_at = ''
            WHERE id = ${claim.id}`;
          return {
            ...NO_CLAIM_CHANGES,
            changedRefs: [claim.from_ref, outcome.ref].sort(),
            newLinks,
          };
        }
      }
      yield* postponeClaims(sql, [claim], now);
      return NO_CLAIM_CHANGES;
    });

  return {
    applyObservedClaims: makeObservedClaims({ sql, graph }),
    changePersonLink,
    settlePendingTarget,

    // Reads. They write nothing and are not part of the operations above.
    readAncestors: graph.readAncestors,
    listRefsBelow: graph.listRefsBelow,
    readClaimsFor: graph.readClaimsFor,

    /**
     * Returns the revision that the stored `text` claims of one Connection were
     * made from, for each of `refs` and each evidence key, in one statement.
     * A key is left out when it has no claim, when one of its claims has no
     * revision, or when its claims were made from different revisions. The
     * ingest reads it to search only the texts that changed.
     */
    readStoredTextRevisions: (
      connectionId: string,
      refs: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyMap<string, ReadonlyMap<string, string>>, SqlError> =>
      Effect.map(
        sql<{
          readonly from_ref: string;
          readonly evidence_key: string;
          readonly revision: string;
        }>`
          SELECT from_ref, evidence_key, MIN(observed_revision) AS revision
          FROM external_entity_relation_claims
          WHERE from_ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))
            AND relation = 'linked' AND connection_id = ${uuidFromString(connectionId)}
            AND claim_type = 'text'
          GROUP BY from_ref, evidence_key
          HAVING COUNT(*) = COUNT(observed_revision)
            AND MIN(observed_revision) = MAX(observed_revision)`,
        (rows) => {
          const byRef = new Map<string, Map<string, string>>();
          for (const row of rows) {
            const keys = byRef.get(row.from_ref) ?? new Map<string, string>();
            keys.set(row.evidence_key, row.revision);
            byRef.set(row.from_ref, keys);
          }
          return byRef;
        },
      ),
  };
});

/** The claim repository. Requires the database only. */
export const claimRepository = make;
