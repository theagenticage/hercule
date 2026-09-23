/**
 * The shared wire vocabulary: ids, timestamps, the actor stamp, and the
 * canonical form of an identifier for a thing outside Hercule.
 */
import { Schema } from "effect";

/**
 * A canonical lowercase UUIDv7 string: what every Hercule id looks like on the
 * wire. Event ids are integers and are not this schema.
 */
export const Id = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, {
    title: "uuidv7",
    description: "a canonical lowercase UUIDv7",
    // A refusal says what an id looks like, and not the pattern that checks it.
    expected: "a canonical lowercase UUIDv7",
  }),
);

export type Id = Schema.Schema.Type<typeof Id>;

/** Whether a value is an id. */
export const isId = Schema.is(Id);

/** An instant on the wire: ISO-8601 UTC with milliseconds. */
export const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, {
    title: "timestamp",
    description: "an ISO-8601 UTC instant with milliseconds",
  }),
);

export type Timestamp = Schema.Schema.Type<typeof Timestamp>;

/**
 * Who performed an operation. Derived from the
 * credential, never supplied by the caller; widened when multi-user arrives,
 * never restructured.
 *
 * `system` is Hercule itself: a mutation that nothing holding a credential asked
 * for. Enlisting a machine that presented a join token, and everything a runner
 * reports about itself afterwards, are its writes - a runner is never an actor,
 * because it can do nothing on the public API.
 */
export const Actor = Schema.String.check(
  Schema.isPattern(
    /^(user|system|(session|run):[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|plugin:[a-z0-9][a-z0-9-]*)$/,
    {
      title: "actor",
      description: "`user`, `system`, `session:<id>`, `run:<id>` or `plugin:<id>`",
    },
  ),
);

export type Actor = Schema.Schema.Type<typeof Actor>;

/**
 * Who performed an operation, or nobody. An ingested event, a cron tick and a
 * failed login all have no actor: nothing that holds a credential caused them.
 */
export const NullableActor = Schema.NullOr(Actor);

export type NullableActor = Schema.Schema.Type<typeof NullableActor>;

/** The longest External Ref. It is an identity, not a document. */
export const MAX_EXTERNAL_REF_LENGTH = 512;

/** The grammar of an External Ref, written once. */
const EXTERNAL_REF_PATTERN = /^[a-z0-9][a-z0-9-]*:[^\s:]+:\S+$/;

/**
 * A fully-qualified identifier for a thing outside Hercule:
 * `<system>:<kind>:<identity>`, for example `github:issue:owner/repo#42` or
 * `gmail:thread:19b2c`.
 *
 * The core pins the grammar and nothing else. What a system's identities look
 * like is the plugin's to canonicalize, and for systems with no plugin it is
 * the triage agent's, so anything without whitespace is an identity here. The
 * system is lowercase so two spellings of the same system cannot become two
 * refs, which would defeat the duplicate-signal query the ref exists for.
 */
export const ExternalRef = Schema.String.check(
  Schema.isMaxLength(MAX_EXTERNAL_REF_LENGTH),
  // A filter rather than a pattern check, so that the refusal quotes the ref
  // the caller wrote: a pattern check reports the position of the value and
  // never the value, and a caller sending a list of refs cannot act on a
  // position alone. The ref comes last, so a reader that cuts a long message
  // short keeps what the message asks for.
  Schema.makeFilter((ref) =>
    EXTERNAL_REF_PATTERN.test(ref)
      ? undefined
      : "Write an external ref as <system>:<kind>:<identity>, with a lowercase system and no whitespace. " +
        `This value is not one: ${ref}`,
  ),
);

export type ExternalRef = Schema.Schema.Type<typeof ExternalRef>;
