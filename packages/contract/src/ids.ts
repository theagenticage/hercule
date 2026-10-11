/**
 * The shared wire vocabulary: ids, timestamps, the actor stamp, and the
 * canonical form of an identifier for a thing outside Hercule.
 */
import { Schema, SchemaGetter } from "effect";
import { Timestamp } from "@hercule/protocol";
import { markShorthandOnItself } from "./shorthand";
export { Timestamp };

/**
 * An exact time as a person or an agent writes it: an ISO 8601 date and time
 * with its offset or `Z`. Seconds and milliseconds are optional. The capture
 * groups are the year, month, day, hour, minute, second, millisecond and
 * offset.
 */
const TIME_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** The same time written without an offset, which says nothing about where it is. */
const TIME_WITHOUT_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/;

/**
 * Converts a time written with its offset into the canonical UTC
 * `Timestamp`, such as `2026-10-13T09:00+02:00` into
 * `2026-10-13T07:00:00.000Z`. Returns `undefined` when the text is not such
 * a time, or names a date or a time of day that does not exist, such as
 * `2026-02-30` or `25:00`.
 */
const convertTimeWithOffset = (text: string): string | undefined => {
  const parts = TIME_WITH_OFFSET.exec(text);
  if (parts === null) return undefined;
  const [, year, month, day, hour, minute, second = "0", fraction = "0", offset] = parts;
  const local = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(fraction.padEnd(3, "0")),
    ),
  );
  // Date.UTC rolls an impossible date over into the next month or day, so a
  // date that exists reads back with the same fields it was built from.
  const exists =
    local.getUTCFullYear() === Number(year) &&
    local.getUTCMonth() === Number(month) - 1 &&
    local.getUTCDate() === Number(day) &&
    local.getUTCHours() === Number(hour) &&
    local.getUTCMinutes() === Number(minute) &&
    local.getUTCSeconds() === Number(second);
  if (!exists) return undefined;
  if (offset === "Z") return local.toISOString();
  const [offsetHours, offsetMinutes] = offset!.slice(1).split(":").map(Number) as [number, number];
  if (offsetHours > 23 || offsetMinutes > 59) return undefined;
  const sign = offset!.startsWith("-") ? -1 : 1;
  return new Date(
    local.getTime() - sign * (offsetHours * 60 + offsetMinutes) * 60_000,
  ).toISOString();
};

/**
 * An exact time an input takes, such as when a snoozed signal comes back. It
 * accepts any ISO 8601 date and time with its offset or `Z`, and decodes to
 * the canonical UTC `Timestamp` the controller stores and compares. A time
 * without an offset is refused, because it could mean any of 24 instants.
 *
 * It is its own shorthand, so the CLI checks and converts the text a person
 * types by the same rules before anything is sent.
 */
export const TimestampWithOffset = markShorthandOnItself(
  Schema.String.check(
    Schema.makeFilter((text: string) => {
      if (convertTimeWithOffset(text) !== undefined) return undefined;
      if (TIME_WITHOUT_OFFSET.test(text)) {
        return `${text} has no offset, so it could be any of 24 times. Add the offset or Z, such as 2026-10-13T09:00+02:00 or 2026-10-13T07:00Z.`;
      }
      return `${text} is not an exact time. Write a real date and time with its offset, such as 2026-10-13T09:00+02:00 or 2026-10-13T07:00Z.`;
    }),
  ).pipe(
    Schema.decodeTo(Timestamp, {
      // The check above has already refused every text this cannot convert.
      decode: SchemaGetter.transform((text: string) => convertTimeWithOffset(text)!),
      encode: SchemaGetter.transform((timestamp: string) => timestamp),
    }),
  ),
);

export type TimestampWithOffset = Schema.Schema.Type<typeof TimestampWithOffset>;

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
 * The word a session writes in place of its own session id. An agent binds
 * `session.input` to itself this way to get the user's answer back as its
 * next input, and filters `transcript.query` by `actor: "me"` to find what the
 * sessions it created said. The controller replaces it with the session's id.
 */
export const OWN_SESSION_ALIAS = "me";

/**
 * The word a session writes in place of an id to name the Agent or the
 * assistant it runs as. The controller replaces it with that id; a user
 * credential, or a session that runs as no Agent, gets a `validation` error.
 * It is the same word as `OWN_SESSION_ALIAS`; the two are kept apart because
 * they resolve to different ids.
 */
export const OWN_AGENT_ALIAS = "me";

/** An id, or `me` for the calling session's own Agent or assistant. */
export const IdOrMe = Schema.Union([Id, Schema.Literal(OWN_AGENT_ALIAS)]);

export type IdOrMe = Schema.Schema.Type<typeof IdOrMe>;

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
const QUALIFIED_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*\/[^/]+$/;

/** Checks whether `id` is a qualified id, such as `github/pr.merge`. */
export const isQualifiedId = (id: string): boolean => QUALIFIED_ID_PATTERN.test(id);

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
