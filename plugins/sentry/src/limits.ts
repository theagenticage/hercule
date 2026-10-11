/**
 * The limits the host applies to an event a plugin emits, when
 * `@hercule/plugin-host` does not export them. A plugin may not import the API
 * contract, which defines them, so they are written out here. A test compares
 * every one with the contract's, so a change there fails a test here instead
 * of failing events in production.
 */

/** The longest dedup key of an event. */
export const MAX_DEDUP_KEY_LENGTH = 200;

/** The longest `url` of an event. */
export const MAX_EVENT_URL_LENGTH = 2048;

/** The longest `system` of an event. */
export const MAX_EVENT_SYSTEM_LENGTH = 64;

/** The longest `author` of an event. */
export const MAX_EVENT_AUTHOR_LENGTH = 256;

/** The longest external ref in an event's `refs`. */
export const MAX_EXTERNAL_REF_LENGTH = 512;

/** The grammar of an external ref: `<system>:<kind>:<identity>`, with a lowercase system and no whitespace. */
export const EXTERNAL_REF_PATTERN = /^[a-z0-9][a-z0-9-]*:[^\s:]+:\S+$/;

/** An ISO 8601 date and time with an explicit time zone, which the host requires of `occurredAt`. */
export const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
