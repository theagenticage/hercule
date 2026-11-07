/**
 * The `person` claims: links a person made between two things with
 * `externalEntity.link`, and the removal of them with `unlink`.
 *
 * A source's claim about the same pair is never touched here. Writes join the
 * caller's transaction. This module checks no grant, stamps no actor of its
 * own and announces nothing: the service does.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { EntityUnlinkResult } from "@hercule/contract";
import { CURRENT_LINKED_SQL, type NewLink } from "./claim-sql";

/** Orders the claim types from firmest to weakest. */
const CLAIM_FIRMNESS = ["source", "person", "text"] as const;

/** Builds the person-link writes. Needs the database and the question "does a pair already join". */
export const makePersonLinks = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly hasEffectiveLink: (a: string, b: string) => Effect.Effect<boolean, SqlError>;
}) => {
  const { sql, hasEffectiveLink } = input;
  return {
    /**
     * Writes `actor`'s claim that `fromRef` is linked to `toRef`. Writes
     * nothing when the actor already linked the pair in either direction.
     * Returns whether a claim was added, and `newLink` when that claim joined
     * a pair that no source or person joined before.
     */
    addPersonLink: (args: {
      readonly fromRef: string;
      readonly toRef: string;
      readonly actor: string;
      readonly now: string;
    }): Effect.Effect<
      { readonly added: boolean; readonly newLink: NewLink | undefined },
      SqlError
    > =>
      Effect.gen(function* () {
        const { fromRef, toRef, actor, now } = args;
        const existing = yield* sql<{ readonly id: number }>`
          SELECT id FROM external_entity_relation_claims
          WHERE claim_type = 'person' AND relation = 'linked' AND actor = ${actor}
            AND ((from_ref = ${fromRef} AND to_ref = ${toRef})
              OR (from_ref = ${toRef} AND to_ref = ${fromRef}))
          LIMIT 1`;
        if (existing.length > 0) return { added: false, newLink: undefined };
        const wasLinked = yield* hasEffectiveLink(fromRef, toRef);
        yield* sql`
          INSERT INTO external_entity_relation_claims
            (from_ref, relation, to_ref, claim_type, connection_id, actor, evidence_key,
             observed_revision, state, conflict_reason, observed_at)
          VALUES (${fromRef}, 'linked', ${toRef}, 'person', NULL, ${actor}, '',
                  NULL, 'current', NULL, ${now})`;
        return { added: true, newLink: wasLinked ? undefined : { fromRef, toRef } };
      }),

    /**
     * Removes every person claim between the two refs, in either direction,
     * and returns whether any existed and the firmest claim that still joins
     * them (a source's or a hint), if one does.
     */
    removePersonLinks: (args: {
      readonly a: string;
      readonly b: string;
    }): Effect.Effect<EntityUnlinkResult, SqlError> =>
      Effect.gen(function* () {
        const { a, b } = args;
        const removed = yield* sql<{ readonly id: number }>`
          DELETE FROM external_entity_relation_claims
          WHERE claim_type = 'person' AND relation = 'linked'
            AND ((from_ref = ${a} AND to_ref = ${b}) OR (from_ref = ${b} AND to_ref = ${a}))
          RETURNING id`;
        const left = yield* sql<{ readonly claim_type: (typeof CLAIM_FIRMNESS)[number] }>`
          SELECT DISTINCT c.claim_type FROM external_entity_relation_claims c
          WHERE ${sql.literal(CURRENT_LINKED_SQL)}
            AND ((c.from_ref = ${a} AND c.to_ref = ${b}) OR (c.from_ref = ${b} AND c.to_ref = ${a}))`;
        const remaining = CLAIM_FIRMNESS.find((type) =>
          left.some((row) => row.claim_type === type),
        );
        return {
          removed: removed.length > 0,
          ...(remaining === undefined ? {} : { remaining }),
        };
      }),
  };
};
