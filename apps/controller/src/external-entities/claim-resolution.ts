/**
 * The database side of resolving pending claims: which pending claims are due,
 * and how one is settled after a plugin's lookup answered.
 *
 * The lookups themselves (`EntityLookups`) live in the plugins domain, which
 * this domain may use but whose calls take seconds, so the controller daemon's
 * resolver loop makes them and calls this service for the reads and writes.
 * Nothing here calls a plugin. Every write is its own short transaction that
 * first checks the claim still holds the target the loop read, because the
 * source may have rewritten it while the lookup waited.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { nowIso, uuidToString, withTransaction } from "../db";
import { makeRefsAnnouncer } from "./claim-announce";
import type { NewLink } from "./claim-sql";
import { PENDING_TARGET_PREFIX } from "./pending-target";
import { computeRetryDelaySeconds, externalEntityRepository } from "./repository";
import { relationClaimRepository } from "./relation-claims";
import { timelineRepository } from "./timeline";

/** One pending claim that is due for resolution. */
export interface PendingClaim {
  readonly id: number;
  /** The Connection whose claim it is. A lookup never marks it unhealthy. */
  readonly connectionId: string;
  readonly fromRef: string;
  readonly claimType: "source" | "text";
  /** The pending target, as stored. */
  readonly target: string;
  readonly attempts: number;
}

/** How a lookup ended for one claim. */
export type ClaimResolutionOutcome =
  /** The lookup found exactly one thing. The claim's target becomes its ref. */
  | { readonly kind: "found"; readonly ref: string }
  /** A web address was recognized as a scoped thing. The claim stays pending under the new target. */
  | { readonly kind: "recognized"; readonly target: string }
  /** The lookup could not place it (ambiguous, not found, incomplete or unavailable). It waits and is tried again. */
  | { readonly kind: "unplaced" };

/** What a write found when it settled a claim. */
export interface ClaimSettlement {
  /** False when the claim was gone or its target changed since the loop read it, so nothing was written. */
  readonly applied: boolean;
  /** The pairs the write joined for the first time. Empty unless a source claim resolved to a ref. */
  readonly newLinks: ReadonlyArray<NewLink>;
}

const NOT_APPLIED: ClaimSettlement = { applied: false, newLinks: [] };

interface DueRow {
  readonly id: number;
  readonly from_ref: string;
  readonly claim_type: "source" | "text";
  readonly to_ref: string;
  readonly resolve_attempts: number;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const claims = yield* relationClaimRepository;
  const entities = yield* externalEntityRepository;
  const timeline = yield* timelineRepository;

  const announceLink = makeRefsAnnouncer({
    sql,
    listTaskIdsLinkedTo: entities.listTaskIdsLinkedTo,
  });

  /** Records that a claim could not be placed this time, and when it may be tried again. */
  const postpone = (
    claim: { readonly id: number; readonly resolve_attempts: number },
    now: string,
  ) =>
    sql`
      UPDATE external_entity_relation_claims
      SET resolve_attempts = ${claim.resolve_attempts + 1},
          next_resolve_at = ${new Date(Date.parse(now) + computeRetryDelaySeconds(claim.resolve_attempts) * 1000).toISOString()}
      WHERE id = ${claim.id}`;

  return {
    /**
     * Lists the pending claims that are due, at most `perConnection` for each
     * Connection that made them, oldest due first. With nothing pending this
     * is one statement over an empty index.
     */
    listDue: (input: {
      readonly now: string;
      readonly perConnection: number;
    }): Effect.Effect<ReadonlyArray<PendingClaim>, SqlError> =>
      Effect.gen(function* () {
        const connections = yield* sql<{ readonly connection_id: Uint8Array }>`
          SELECT DISTINCT connection_id FROM external_entity_relation_claims
          WHERE is_pending = 1 AND next_resolve_at <= ${input.now}`;
        const due: Array<PendingClaim> = [];
        for (const { connection_id } of connections) {
          const rows = yield* sql<DueRow>`
            SELECT id, from_ref, claim_type, to_ref, resolve_attempts
            FROM external_entity_relation_claims
            WHERE connection_id = ${connection_id} AND is_pending = 1
              AND next_resolve_at <= ${input.now}
            ORDER BY next_resolve_at, id
            LIMIT ${input.perConnection}`;
          for (const row of rows) {
            due.push({
              id: row.id,
              connectionId: uuidToString(connection_id),
              fromRef: row.from_ref,
              claimType: row.claim_type,
              target: row.to_ref,
              attempts: row.resolve_attempts,
            });
          }
        }
        return due;
      }),

    /**
     * Makes every pending web address due again. The loop calls it when the set
     * of plugins that recognize addresses changed, because an address no plugin
     * knew may be known now. Returns how many claims it made due.
     */
    makeUrlClaimsDue: (): Effect.Effect<number, SqlError> =>
      Effect.map(
        withTransaction(
          sql,
          sql<{ readonly id: number }>`
            UPDATE external_entity_relation_claims SET next_resolve_at = ''
            WHERE is_pending = 1 AND next_resolve_at <> ''
              AND substr(to_ref, 1, ${PENDING_TARGET_PREFIX.length + 4}) = ${`${PENDING_TARGET_PREFIX}url:`}
            RETURNING id`,
        ),
        (rows) => rows.length,
      ),

    /**
     * Settles one claim after a lookup, in one short transaction. The claim is
     * written only when it still holds `expectedTarget` and is still pending.
     *
     * - `found` rewrites the target to the ref, keeping the claim's type,
     *   Connection and id, and announces both ends. It is treated as
     *   `unplaced` when the ref is the claim's own origin, or when another
     *   claim of the same Connection and text already holds the ref, which the
     *   unique key refuses: the claim then waits instead of being deleted, so
     *   the next report of its text does not create it again.
     * - `recognized` rewrites a web address to the scoped target it names, and
     *   leaves it pending and due.
     * - `unplaced` postpones the claim: 120 seconds, doubling, at most 6 hours.
     */
    settle: (input: {
      readonly claimId: number;
      readonly expectedTarget: string;
      readonly outcome: ClaimResolutionOutcome;
    }): Effect.Effect<ClaimSettlement, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const now = yield* nowIso;
          const found = yield* sql<DueRow & { readonly connection_id: Uint8Array }>`
            SELECT id, from_ref, claim_type, to_ref, resolve_attempts, connection_id
            FROM external_entity_relation_claims
            WHERE id = ${input.claimId} AND to_ref = ${input.expectedTarget} AND is_pending = 1`;
          const claim = found[0];
          if (claim === undefined) return NOT_APPLIED;
          const { outcome } = input;

          if (outcome.kind === "recognized") {
            yield* sql`
              UPDATE external_entity_relation_claims SET to_ref = ${outcome.target}
              WHERE id = ${claim.id}`;
            return { applied: true, newLinks: [] };
          }
          if (outcome.kind === "found" && outcome.ref !== claim.from_ref) {
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
              const newLink =
                claim.claim_type === "source" &&
                !(yield* claims.hasEffectiveLink(claim.from_ref, outcome.ref));
              yield* sql`
                UPDATE external_entity_relation_claims
                SET to_ref = ${outcome.ref}, resolve_attempts = 0, next_resolve_at = ''
                WHERE id = ${claim.id}`;
              if (newLink) {
                yield* timeline.recordLinks([{ fromRef: claim.from_ref, toRef: outcome.ref }], now);
              }
              yield* announceLink([claim.from_ref, outcome.ref]);
              return {
                applied: true,
                newLinks: newLink ? [{ fromRef: claim.from_ref, toRef: outcome.ref }] : [],
              };
            }
          }
          yield* postpone(claim, now);
          return { applied: true, newLinks: [] };
        }),
      ),
  };
});

/** Reads and settles the pending claims that the resolver loop works through. */
export class ClaimResolution extends Context.Service<
  ClaimResolution,
  Effect.Success<typeof make>
>()("hercule/controller/external-entities/ClaimResolution") {}

export const ClaimResolutionLayer: Layer.Layer<ClaimResolution, never, SqlClient.SqlClient> =
  Layer.effect(ClaimResolution)(make);
