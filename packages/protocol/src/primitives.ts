/**
 * The pieces both halves of the catalogue are built from.
 *
 * They sit in a leaf of their own rather than in `index.ts` because the
 * session schemas need them and `index.ts` needs the session frames to build
 * its unions; a shared leaf is what keeps that from being a cycle.
 */
import { Schema } from "effect";

/**
 * The longest a peer's statement about itself may be. Exported because the
 * producing side has to cut to it: one long fact would otherwise make a whole
 * hello unsendable.
 */
export const MAX_FACT_LENGTH = 512;

/** A name, a version or a path a peer states about itself, and never a document. */
export const Fact = Schema.String.check(Schema.isLengthBetween(1, MAX_FACT_LENGTH));

/**
 * A provider instance's id. Narrower than a fact because the runner makes a
 * directory of it: the credential a login writes, and the provider home a
 * session runs against, must land under the instance's own home and nowhere a
 * path could climb out to.
 */
export const InstanceId = Schema.String.check(
  Schema.isLengthBetween(1, 64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/, { title: "instance id", description: "an identifier" }),
);

/** A position. Counting starts at one: a connection that acked nothing sends no ack. */
export const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * The envelope every replayable runner event carries. `sessionEvent` is the
 * first frame to extend it; the shape was fixed before that so the wire was
 * settled before the first event needed it.
 */
export const Sequenced = Schema.Struct({ seq: Seq });

export type Sequenced = Schema.Schema.Type<typeof Sequenced>;
