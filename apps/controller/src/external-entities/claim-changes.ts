/**
 * What an operation on the claims changed, and the one rule that decides which
 * of the changes are new links.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { EntityConflict } from "@hercule/contract";
import { EFFECTIVE_LINK_SQL } from "./entity-links";

/** A link that did not join two things before a write and does now: the pair, in the direction first written. */
export interface NewLink {
  readonly fromRef: string;
  readonly toRef: string;
}

/** What one operation on the claims changed. The entity domain applies it (see `applyClaimChanges`). */
export interface ClaimChanges {
  /**
   * The refs whose card or detail now shows something different, sorted, each
   * once: the ends of the claims added or removed that are refs. A pending
   * target is not a ref and a claim that holds one draws nothing, so it is
   * not listed.
   */
  readonly changedRefs: ReadonlyArray<string>;
  /**
   * The refs below every ref whose `part-of` or `linked` claims changed (those
   * refs included), as they stood before any claim was removed, so the Tasks
   * that lost a parent are told too. Empty when no such claim changed.
   */
  readonly refsBelowBefore: ReadonlyArray<string>;
  /**
   * The pairs that a source's claim joined for the first time, leaving out
   * claims of a thing's baseline (`in_baseline`). The timelines of both ends
   * get a `linked` change for each.
   */
  readonly newLinks: ReadonlyArray<NewLink>;
  /** Every claim of the written refs that the graph refused, such as a loop, sorted by (fromRef, relation, toRef). */
  readonly conflicts: ReadonlyArray<EntityConflict>;
}

/** What an operation that changed nothing returns. */
export const NO_CLAIM_CHANGES: ClaimChanges = {
  changedRefs: [],
  refsBelowBefore: [],
  newLinks: [],
  conflicts: [],
};

/** A `linked` claim that an operation is about to add. */
export interface AddedLink extends NewLink {
  /** True when the claim belongs to its thing's first full record: what a thing arrived with is not news. */
  readonly inBaseline: boolean;
}

/** Returns one key for a pair of refs, whichever end is first. */
const buildPairKey = (a: string, b: string): string =>
  a < b ? JSON.stringify([a, b]) : JSON.stringify([b, a]);

/**
 * Returns the pairs among `added` that this operation joins for the first
 * time, in the order given. This is the one rule for a new link: a pair is
 * new when no claim of a source or a person joined it, in either direction,
 * before the operation added anything, and the claim that joins it is not part
 * of a thing's baseline. A text claim and a claim with a pending target join
 * nothing. A pair added twice is new once, under the first claim.
 *
 * Call it once per operation, after the operation removed its claims and
 * before it adds any, so the answer never depends on the order of the claims.
 * Reads the stored claims in one statement however many pairs there are.
 */
export const findNewLinks = (
  sql: SqlClient.SqlClient,
  added: ReadonlyArray<AddedLink>,
): Effect.Effect<ReadonlyArray<NewLink>, SqlError> =>
  Effect.gen(function* () {
    const pairs = added.filter(({ fromRef, toRef }) => fromRef !== toRef);
    if (pairs.length === 0) return [];
    const rows = yield* sql<{ readonly a: string; readonly b: string }>`
      WITH pairs(a, b) AS (
        SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]')
        FROM json_each(${JSON.stringify(pairs.map(({ fromRef, toRef }) => [fromRef, toRef]))})
      )
      SELECT p.a, p.b FROM pairs p
      WHERE EXISTS (
        SELECT 1 FROM external_entity_relation_claims c
        WHERE ${sql.literal(EFFECTIVE_LINK_SQL)}
          AND ((c.from_ref = p.a AND c.to_ref = p.b) OR (c.from_ref = p.b AND c.to_ref = p.a))
      )`;
    const joined = new Set(rows.map((row) => buildPairKey(row.a, row.b)));
    const newLinks: Array<NewLink> = [];
    for (const { fromRef, toRef, inBaseline } of pairs) {
      const key = buildPairKey(fromRef, toRef);
      const wasJoined = joined.has(key);
      joined.add(key);
      if (!wasJoined && !inBaseline) newLinks.push({ fromRef, toRef });
    }
    return newLinks;
  });
