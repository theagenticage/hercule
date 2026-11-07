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
import { nowIso, withTransaction } from "../db";
import { PENDING_URL_PREFIX } from "./pending-target";
import { computeRetryDelaySeconds, externalEntityRepository } from "./repository";
import { relationClaimRepository } from "./relation-claims";
import { timelineRepository } from "./timeline";

/** One pending claim that is due for resolution. */
export interface PendingClaim {
  readonly id: number;
  /** The pending target, as stored. */
  readonly target: string;
}

/** What a lookup found for one claim. */
export type ClaimResolutionOutcome =
  /** The lookup found exactly one thing. The claim's target becomes its ref. */
  | { readonly kind: "found"; readonly ref: string }
  /** A web address was recognized as a scoped thing. The claim stays pending under the new target. */
  | { readonly kind: "recognized"; readonly target: string };

/** A pending claim that the loop is working on, as stored. */
interface ClaimRow {
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

  /**
   * Records that claims could not be placed this time, and when each may be
   * tried again, in one statement. Each claim waits as long as its own
   * attempts say: 120 seconds, doubling, at most 6 hours.
   */
  const postpone = (
    postponed: ReadonlyArray<Pick<ClaimRow, "id" | "resolve_attempts">>,
    now: string,
  ) =>
    postponed.length === 0
      ? Effect.void
      : sql`
          UPDATE external_entity_relation_claims
          SET resolve_attempts = u.attempts, next_resolve_at = u.next_resolve_at
          FROM (
            SELECT json_extract(value, '$.id') AS id,
                   json_extract(value, '$.attempts') AS attempts,
                   json_extract(value, '$.nextResolveAt') AS next_resolve_at
            FROM json_each(${JSON.stringify(
              postponed.map((claim) => ({
                id: claim.id,
                attempts: claim.resolve_attempts + 1,
                nextResolveAt: new Date(
                  Date.parse(now) + computeRetryDelaySeconds(claim.resolve_attempts) * 1000,
                ).toISOString(),
              })),
            )})
          ) AS u
          WHERE external_entity_relation_claims.id = u.id`;

  return {
    /**
     * Lists the due pending claims whose target starts with `targetPrefix`
     * (see `buildScopedTargetPrefix` and `PENDING_URL_PREFIX`), at most
     * `limit`, oldest due first. A claim is due when its backoff has passed.
     * With nothing pending this is one statement over an empty index.
     */
    listDue: (input: {
      readonly now: string;
      readonly targetPrefix: string;
      readonly limit: number;
    }): Effect.Effect<ReadonlyArray<PendingClaim>, SqlError> =>
      Effect.map(
        sql<{ readonly id: number; readonly to_ref: string }>`
          SELECT id, to_ref FROM external_entity_relation_claims
          WHERE is_pending = 1 AND next_resolve_at <= ${input.now}
            AND substr(to_ref, 1, ${input.targetPrefix.length}) = ${input.targetPrefix}
          ORDER BY next_resolve_at, id
          LIMIT ${input.limit}`,
        (rows) => rows.map((row) => ({ id: row.id, target: row.to_ref })),
      ),

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
              AND substr(to_ref, 1, ${PENDING_URL_PREFIX.length}) = ${PENDING_URL_PREFIX}
            RETURNING id`,
        ),
        (rows) => rows.length,
      ),

    /**
     * Postpones every pending claim that holds `target`, in one statement:
     * the lookup of that target could not place it, and the answer holds for
     * all of the claims. Each claim waits as long as its own attempts say.
     */
    postponeTarget: (input: {
      readonly target: string;
      readonly now: string;
    }): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const holders = yield* sql<Pick<ClaimRow, "id" | "resolve_attempts">>`
            SELECT id, resolve_attempts FROM external_entity_relation_claims
            WHERE to_ref = ${input.target} AND relation = 'linked' AND state = 'current'
              AND is_pending = 1`;
          yield* postpone(holders, input.now);
        }),
      ),

    /**
     * Settles one claim after a lookup, in one short transaction. The claim is
     * written only when it still holds `expectedTarget` and is still pending.
     *
     * - `found` rewrites the target to the ref, keeping the claim's type,
     *   Connection and id, and announces both ends. A new link is written on the
     *   timelines of both ends, unless the claim belongs to the first full
     *   record of its thing (`in_baseline`): what a thing arrived with is not
     *   news, however late its claim resolves. The claim is postponed instead
     *   when the ref is the claim's own origin, or when another claim of the
     *   same Connection and text already holds the ref, which the unique key
     *   refuses: it waits instead of being deleted, so the next report of its
     *   text does not create it again.
     * - `recognized` rewrites a web address to the scoped target it names, and
     *   leaves it pending and due.
     */
    settle: (input: {
      readonly claimId: number;
      readonly expectedTarget: string;
      readonly outcome: ClaimResolutionOutcome;
    }): Effect.Effect<void, SqlError> =>
      withTransaction(
        sql,
        Effect.gen(function* () {
          const now = yield* nowIso;
          const found = yield* sql<
            ClaimRow & { readonly connection_id: Uint8Array; readonly in_baseline: number }
          >`
            SELECT id, from_ref, claim_type, to_ref, resolve_attempts, connection_id, in_baseline
            FROM external_entity_relation_claims
            WHERE id = ${input.claimId} AND to_ref = ${input.expectedTarget} AND is_pending = 1`;
          const claim = found[0];
          if (claim === undefined) return;
          const { outcome } = input;

          if (outcome.kind === "recognized") {
            yield* sql`
              UPDATE external_entity_relation_claims SET to_ref = ${outcome.target}
              WHERE id = ${claim.id}`;
            return;
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
              const isNewLink =
                claim.claim_type === "source" &&
                !(yield* claims.hasEffectiveLink(claim.from_ref, outcome.ref));
              yield* sql`
                UPDATE external_entity_relation_claims
                SET to_ref = ${outcome.ref}, resolve_attempts = 0, next_resolve_at = ''
                WHERE id = ${claim.id}`;
              if (isNewLink && claim.in_baseline === 0) {
                yield* timeline.recordLinks([{ fromRef: claim.from_ref, toRef: outcome.ref }], now);
              }
              yield* entities.announceRefs([claim.from_ref, outcome.ref]);
              return;
            }
          }
          yield* postpone([claim], now);
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
