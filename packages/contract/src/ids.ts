/**
 * The shared wire vocabulary: ids, timestamps, the actor stamp, and the
 * canonical form of an identifier for a thing outside Hercule.
 */
import { Schema } from "effect";
export { Timestamp } from "@hercule/protocol";

/**
 * A canonical lowercase UUIDv7 string: what every Hercule id looks like on the
 * wire. Event ids are integers and are not this schema.
 */
export const Id = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, {
    title: "uuidv7",
    description: "a canonical lowercase UUIDv7",
    // The error message describes an id in words instead of showing the regex.
    expected: "a canonical lowercase UUIDv7",
  }),
);

export type Id = Schema.Schema.Type<typeof Id>;

export const isId = Schema.is(Id);

/**
 * Who performed an operation. The controller derives it from the credential;
 * the caller never supplies it. It will be widened when multi-user support
 * arrives, never restructured.
 *
 * `system` is Hercule itself: a mutation that nothing holding a credential
 * asked for. Enlisting a machine that presented a join token, and everything a
 * runner reports about itself afterwards, are written as `system`. A runner is
 * never an actor, because it cannot call the public API.
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

/**
 * The id of a catalog contribution: `<pluginId>/<word>`, such as
 * `github/pr.merge`. The plugin declares the word and the host prefixes its
 * plugin id, so the word holds no `/`. An operation id (`task.create`) never
 * matches, because it holds no `/` at all.
 */
export const QualifiedId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(-[a-z0-9]+)*\/[^/]+$/, {
    title: "qualified id",
    description: "`<pluginId>/<word>`, such as github/pr.merge",
  }),
);

export type QualifiedId = Schema.Schema.Type<typeof QualifiedId>;

export const isQualifiedId = Schema.is(QualifiedId);

/** The longest External Ref. It is an identity, not a document. */
export const MAX_EXTERNAL_REF_LENGTH = 512;

/** The grammar of an External Ref, written once. */
const EXTERNAL_REF_PATTERN = /^[a-z0-9][a-z0-9-]*:[^\s:]+:\S+$/;

/**
 * A fully-qualified identifier for a thing outside Hercule:
 * `<system>:<kind>:<identity>`, for example `github:issue:owner/repo#42` or
 * `gmail:thread:19b2c`.
 *
 * The core fixes the grammar and nothing else. The plugin for a system puts
 * that system's identities in canonical form; for a system with no plugin, the
 * triage agent does. So here, anything without whitespace is a valid identity.
 * The system must be lowercase, so that two spellings of the same system
 * cannot become two refs, which would break the duplicate-signal query the ref
 * exists for.
 */
export const ExternalRef = Schema.String.check(
  Schema.isMaxLength(MAX_EXTERNAL_REF_LENGTH),
  // A filter rather than a pattern check, so that the error message quotes the
  // ref the caller wrote: a pattern check reports the position of the value
  // but never the value, and a caller sending a list of refs cannot act on a
  // position alone. The ref comes last, so a client that truncates a long
  // message still shows the instruction.
  Schema.makeFilter((ref) =>
    EXTERNAL_REF_PATTERN.test(ref)
      ? undefined
      : "Write an external ref as <system>:<kind>:<identity>, with a lowercase system and no whitespace. " +
        `Invalid value: ${ref}`,
  ),
);

export type ExternalRef = Schema.Schema.Type<typeof ExternalRef>;
