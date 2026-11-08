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
import { claimRepository, type ClaimResolutionOutcome } from "./claims";
import { PENDING_URL_PREFIX } from "./pending-target";
import { externalEntityRepository } from "./repository";
import { postponeClaims } from "./retry-backoff";

export type { ClaimResolutionOutcome } from "./claims";

/** One pending claim that is due for resolution. */
export interface PendingClaim {
  readonly id: number;
  /** The pending target, as stored. */
  readonly target: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const claims = yield* claimRepository;
  const entities = yield* externalEntityRepository;

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
          const holders = yield* sql<{ readonly id: number; readonly resolve_attempts: number }>`
            SELECT id, resolve_attempts FROM external_entity_relation_claims
            WHERE to_ref = ${input.target} AND relation = 'linked' AND state = 'current'
              AND is_pending = 1`;
          yield* postponeClaims(sql, holders, input.now);
        }),
      ),

    /**
     * Settles one claim after a lookup, in one short transaction. The claim is
     * written only when it still holds `expectedTarget` and is still pending
     * (see `ClaimRepository.settlePendingTarget`).
     *
     * A claim that found its ref announces both ends. A new link is written on
     * the timelines of both ends, unless the claim belongs to the first full
     * record of its thing (`in_baseline`): what a thing arrived with is not
     * news, however late its claim resolves.
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
          const changes = yield* claims.settlePendingTarget({ ...input, now });
          yield* entities.applyClaimChanges(changes, now);
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
