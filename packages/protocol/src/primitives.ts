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

/**
 * A session's id. Narrow for the same reason an instance's is: the runner makes
 * a directory of it for a workspace-less session and removes that directory
 * when the session exits, so an id that could climb out of the scratch root
 * would be a path traversal with an `rm -rf` behind it.
 */
export const SessionId = Schema.String.check(
  Schema.isLengthBetween(1, 64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/, { title: "session id", description: "an identifier" }),
);

/**
 * An id a machine makes a directory of, or removes one by: a workspace, a
 * resource's cache, a checkout. Narrow for the reason a session's id is: these
 * are joined into paths under the runner's storage directory and a dispose
 * removes what they name, so a segment that could climb out of that root would
 * be a path traversal with an `rm -rf` behind it.
 */
export const StorageId = Schema.String.check(
  Schema.isLengthBetween(1, 64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/, { title: "storage id", description: "an identifier" }),
);

/**
 * Where one checkout sits inside a multi-repo workspace: one path segment with
 * no separator in it, and none of the three names a directory cannot be called
 * - `.` and `..` are the workspace and what is above it, and `.git` is git's
 * own. A repository may well be called `.github`, so a leading dot on its own
 * is no reason to refuse one.
 */
export const Subdirectory = Schema.String.check(
  Schema.isLengthBetween(1, 64),
  Schema.isPattern(/^(?!\.$|\.\.$|\.git$)[A-Za-z0-9._-]+$/i, {
    title: "subdirectory",
    description: "one path segment",
  }),
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

/**
 * What a secret is stored under: the same bound the secrets table holds its
 * names to, because these keys are those names. `|` is the separator in the
 * associated data that binds a stored value to its owner, so no name carries
 * one.
 */
const SecretName = Schema.String.check(
  Schema.isLengthBetween(1, 256),
  Schema.isPattern(/^[^|]+$/, { title: "secret name", description: "no `|`" }),
);

/**
 * The secret-valued config fields of one provider instance, by the name the
 * plugin gave each. The controller decrypts them as it builds the frame, so
 * plaintext exists on the wire and in the runner's memory for that one
 * operation and nowhere else: never on the machine's disk, never in a log.
 * Absent means the same as empty, which is what an instance with no credential
 * stored carries.
 */
export const InstanceSecrets = Schema.Record(SecretName, Schema.String);

export type InstanceSecrets = Schema.Schema.Type<typeof InstanceSecrets>;
