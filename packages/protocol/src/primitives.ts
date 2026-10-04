/**
 * The pieces both halves of the catalogue are built from.
 *
 * They are in a module of their own rather than in `index.ts`, because the
 * session schemas need them and `index.ts` needs the session frames to build
 * its unions. Keeping them in a separate module avoids an import cycle.
 */
import { Schema } from "effect";

/**
 * The longest fact a peer may report about itself. Exported because the sender
 * has to truncate to it: one long fact would otherwise make a whole hello
 * impossible to send.
 */
export const MAX_FACT_LENGTH = 512;

/** The most facts one list may hold, so a peer cannot send a list without end. */
export const MAX_FACT_ITEMS = 64;

/** A name, a version or a path a peer reports about itself, and never a document. */
export const Fact = Schema.String.check(Schema.isLengthBetween(1, MAX_FACT_LENGTH));

/**
 * A provider instance's id. Stricter than a fact, because the runner uses it as
 * a directory name: the credential a login writes, and the provider home a
 * session runs against, must stay under the instance's own home, with no way
 * for the path to escape it.
 */
export const InstanceId = Schema.String.check(
  Schema.isLengthBetween(1, 64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/, { title: "instance id", description: "an identifier" }),
);

/**
 * A session's id. Strict for the same reason as an instance's: the runner uses
 * it as a directory name for a session without a workspace, and removes that
 * directory when the session exits. An id that could escape the scratch root
 * would be a path traversal followed by an `rm -rf`.
 */
export const SessionId = Schema.String.check(
  Schema.isLengthBetween(1, 64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/, { title: "session id", description: "an identifier" }),
);

/**
 * An id a machine uses as a directory name, or to remove a directory: a
 * workspace, a resource's cache, a checkout. Strict for the same reason as a
 * session's id: these ids are joined into paths under the runner's storage
 * directory, and a dispose removes those paths. A segment that could escape
 * that root would be a path traversal followed by an `rm -rf`.
 */
export const StorageId = Schema.String.check(
  Schema.isLengthBetween(1, 64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/, { title: "storage id", description: "an identifier" }),
);

/**
 * Where one checkout sits inside a multi-repo workspace: one path segment with
 * no separator, and not one of three reserved names. `.` and `..` are the
 * workspace and its parent, and `.git` belongs to git. A repository may well be
 * called `.github`, so a leading dot alone is no reason to reject a name.
 */
export const Subdirectory = Schema.String.check(
  Schema.isLengthBetween(1, 64),
  Schema.isPattern(/^(?!\.$|\.\.$|\.git$)[A-Za-z0-9._-]+$/i, {
    title: "subdirectory",
    description: "one path segment",
  }),
);

/** A sequence number. Counting starts at one: a connection that has acknowledged nothing sends no ack. */
export const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

/**
 * The envelope every replayable runner event has. `sessionEvent` is the first
 * frame to extend it; the shape was fixed earlier, so the wire format was
 * settled before the first event needed it.
 */
export const Sequenced = Schema.Struct({ seq: Seq });

export type Sequenced = Schema.Schema.Type<typeof Sequenced>;

/**
 * The name a secret is stored under, with the same limits as the secrets
 * table's names, because these keys are those names. `|` is the separator in
 * the associated data that binds a stored value to its owner, so no name may
 * contain one.
 */
const SecretName = Schema.String.check(
  Schema.isLengthBetween(1, 256),
  Schema.isPattern(/^[^|]+$/, { title: "secret name", description: "no `|`" }),
);

/**
 * The secret config fields of one provider instance, keyed by the name the
 * plugin gave each. The controller decrypts them as it builds the frame, so
 * the plaintext exists on the wire and in the runner's memory for that one
 * operation and nowhere else: never on the machine's disk, never in a log.
 * The field is always present: an instance with no credential stored sends
 * `{}`, so a runner handles one shape rather than two forms of the same state.
 */
export const InstanceSecrets = Schema.Record(SecretName, Schema.String);

export type InstanceSecrets = Schema.Schema.Type<typeof InstanceSecrets>;

/**
 * Identifies one step record of a run: the run, the step's id in the run's
 * plan, and the iteration of that step. The run id and the step id are storage
 * ids because the runner names the step's result file after them, so neither
 * may escape the directory that file goes in.
 */
export const WorkspaceStepKey = Schema.Struct({
  runId: StorageId,
  stepId: StorageId,
  iteration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export type WorkspaceStepKey = Schema.Schema.Type<typeof WorkspaceStepKey>;
