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

/**
 * The longest piece of free text a harness may put in an event. A `Fact` is too
 * short: an error body or a stack trace over 512 bytes would make the frame
 * undecodable, which would cost the runner its socket and every session on it.
 */
export const MAX_MESSAGE_LENGTH = 4096;

/** Free text a peer reports, such as an error message: at most `MAX_MESSAGE_LENGTH` characters. */
export const Message = Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_LENGTH));

/** A name, a version or a path a peer reports about itself, and never a document. */
export const Fact = Schema.String.check(Schema.isBetweenLength(1, MAX_FACT_LENGTH));

/** An instant on the wire: ISO-8601 UTC with milliseconds. */
export const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, {
    title: "timestamp",
    description: "an ISO-8601 UTC instant with milliseconds",
  }),
);

export type Timestamp = Schema.Schema.Type<typeof Timestamp>;

/**
 * A Provider Account's id. Stricter than a fact, because the runner uses it in
 * the folder of a Harness Home: the credential a sign-in writes, and the home
 * a session runs against, must stay under that folder, with no way for the
 * path to escape it.
 */
export const ProviderAccountId = Schema.String.check(
  Schema.isBetweenLength(1, 64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/, {
    title: "provider account id",
    description: "an identifier",
  }),
);

export type ProviderAccountId = Schema.Schema.Type<typeof ProviderAccountId>;

/**
 * The folder a harness runs in for one Provider Account, as a path relative to
 * the runner's storage directory. The controller names it and the runner joins
 * it to the storage directory; the runner never works one out from an id. Only
 * two shapes are accepted, so a value can never leave the storage directory:
 *
 * - `providers/<providerAccountId>`: the home of an account carried over from
 *   an earlier release, for its original harness.
 * - `providers/homes/<providerAccountId>/<word>/<word>`: every other home,
 *   where the two words are the harness id's plugin id and its own word.
 *
 * A word starts with a letter or digit, so `.` and `..` never match. Each
 * segment is at most 64 characters, the limit ids have. The
 * folder `providers/homes` is the parent of the derived homes, never an account's.
 */
export const HarnessHome = Schema.String.check(
  Schema.isMaxLength(256),
  Schema.isPattern(
    /^providers\/(?:(?!homes$)[A-Za-z0-9_-]{1,64}|homes\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})$/,
    {
      title: "harness home",
      description:
        "providers/<account id> or providers/homes/<account id>/<word>/<word>, relative to the storage directory",
    },
  ),
);

export type HarnessHome = Schema.Schema.Type<typeof HarnessHome>;

/**
 * A session's id. Strict for the same reason as a Provider Account's: the runner uses
 * it as a directory name for a session without a workspace, and removes that
 * directory when the session exits. An id that could escape the scratch root
 * would be a path traversal followed by an `rm -rf`.
 */
export const SessionId = Schema.String.check(
  Schema.isBetweenLength(1, 64),
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
  Schema.isBetweenLength(1, 64),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/, { title: "storage id", description: "an identifier" }),
);

/**
 * Where one checkout sits inside a multi-repo workspace: one path segment with
 * no separator, and not one of three reserved names. `.` and `..` are the
 * workspace and its parent, and `.git` belongs to git. A repository may well be
 * called `.github`, so a leading dot alone is no reason to reject a name.
 */
export const Subdirectory = Schema.String.check(
  Schema.isBetweenLength(1, 64),
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
 * The environment variable a harness reads the key or token of an account
 * from, and the key itself. The controller sends it whenever the harness
 * declares a variable for the account's kind. `value` is left out when the
 * account has no key stored, so the runner removes the variable from the
 * harness's environment instead of letting a key of the runner's own stand in.
 *
 * The controller decrypts the value as it builds the frame, so the plaintext
 * exists on the wire and in the runner's memory for that one operation and
 * nowhere else: it is never logged and never written to disk.
 */
export const HarnessCredential = Schema.Struct({
  variable: Schema.String.check(
    Schema.isPattern(/^[A-Z][A-Z0-9_]*$/, {
      title: "credential variable",
      description: "an environment variable name in upper case",
    }),
    Schema.isMaxLength(128),
  ),
  value: Schema.optionalKey(Schema.String.check(Schema.isBetweenLength(1, MAX_FACT_LENGTH))),
});

export type HarnessCredential = Schema.Schema.Type<typeof HarnessCredential>;

/**
 * What the runner needs to run a harness for one Provider Account, so it never
 * looks anything up: the account, the folder to run in, how the harness names
 * a model for this account's provider, and the credential of a key or token
 * account.
 *
 * - `modelArgument` is the harness's form of the model argument, with
 *   exactly one `{model}` standing for the model id (`{model}`, `zai/{model}`).
 * - `credential` is absent for an account whose harness declares no variable
 *   for its kind, such as a per-machine account whose login is in the Harness
 *   Home.
 */
export const HarnessAccount = Schema.Struct({
  providerAccountId: ProviderAccountId,
  harnessHome: HarnessHome,
  modelArgument: Schema.String.check(
    Schema.isMaxLength(128),
    // Braces are allowed only in the one placeholder, so there is exactly one.
    Schema.isPattern(/^[^{}]*\{model\}[^{}]*$/, {
      title: "model argument",
      description: "text with exactly one `{model}` placeholder and no other braces",
    }),
  ),
  credential: Schema.optionalKey(HarnessCredential),
});

export type HarnessAccount = Schema.Schema.Type<typeof HarnessAccount>;

/**
 * Identifies one step record of a run: the run, the step's id in the run's
 * plan, and the iteration of that step. The run id and the step id are storage
 * ids because the runner names the step's result file after them, so neither
 * may escape the directory that file goes in. This is the key on the wire,
 * and names the run; the controller's run engine names a record within a run
 * it already holds with its own `StepRecordKey`, which has no run id.
 */
export const WorkspaceStepKey = Schema.Struct({
  runId: StorageId,
  stepId: StorageId,
  iteration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export type WorkspaceStepKey = Schema.Schema.Type<typeof WorkspaceStepKey>;
