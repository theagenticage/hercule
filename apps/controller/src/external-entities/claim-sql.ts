/**
 * The SQL tests and the shapes that every reader and writer of `linked` claims
 * shares. They live in a file of their own so the modules that write claims
 * can use them without importing each other.
 */

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

/** A link that did not join two things before a write and does now: the pair, in the direction first written. */
export interface NewLink {
  readonly fromRef: string;
  readonly toRef: string;
}

/** Returns one key for a pair of refs, whichever end is first. */
export const buildPairKey = (a: string, b: string): string =>
  a < b ? JSON.stringify([a, b]) : JSON.stringify([b, a]);
