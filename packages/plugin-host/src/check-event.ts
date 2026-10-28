/**
 * Checks an emitted event the way the host does before it stores one. A feed
 * that keeps an outbox checks every event it computes before writing it there,
 * because an event the host refuses would stay in the outbox and fail every
 * later poll. A plugin's test harness uses the same check in its fake `emit`.
 */
import { Effect, Schema } from "effect";
import type { EmittedEvent, EventKindDeclaration } from "./contributions";
import { MAX_EMITTED_FIELD_BYTES } from "./contributions";
import {
  EXTERNAL_REF_PATTERN,
  ISO_TIMESTAMP_PATTERN,
  MAX_DEDUP_KEY_LENGTH,
  MAX_EVENT_AUTHOR_LENGTH,
  MAX_EVENT_SYSTEM_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  MAX_EVENT_URL_LENGTH,
  MAX_EXTERNAL_REF_LENGTH,
} from "./limits";
import { PluginError } from "./plugin";

/** Builds the schema of a string of at least `minimum` and at most `maximum` characters. */
const buildBoundedString = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isBetweenLength(minimum, maximum));

const ExternalRef = Schema.String.check(
  Schema.isMaxLength(MAX_EXTERNAL_REF_LENGTH),
  Schema.isPattern(EXTERNAL_REF_PATTERN),
);

/** The fields every event has, whatever its kind, with the limits the host enforces. */
const EventEnvelope = Schema.Struct({
  dedupKey: buildBoundedString(1, MAX_DEDUP_KEY_LENGTH),
  occurredAt: Schema.String.check(Schema.isPattern(ISO_TIMESTAMP_PATTERN)),
  refs: Schema.Array(ExternalRef),
  url: Schema.optionalKey(buildBoundedString(1, MAX_EVENT_URL_LENGTH)),
  system: Schema.optionalKey(buildBoundedString(1, MAX_EVENT_SYSTEM_LENGTH)),
  raw: Schema.optionalKey(Schema.JsonObject),
  title: buildBoundedString(1, MAX_EVENT_TITLE_LENGTH),
  author: Schema.NullOr(buildBoundedString(1, MAX_EVENT_AUTHOR_LENGTH)),
});

/** Returns the size of `value` written as UTF-8 JSON, in bytes. */
const countJsonBytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Checks one event against the kinds a plugin declares, before it is stored
 * or emitted. Returns nothing when the host would accept the event. Fails with
 * a `PluginError` whose message starts with the event's kind when:
 *
 * - `kinds` does not declare the kind;
 * - the payload or the raw is larger than `MAX_EMITTED_FIELD_BYTES` as UTF-8 JSON;
 * - a field every event has breaks the host's limits;
 * - the payload does not match the kind's schema exactly, extra fields included.
 */
export const checkEmittedEvent = (
  kinds: Readonly<Record<string, EventKindDeclaration>>,
  event: EmittedEvent,
): Effect.Effect<void, PluginError> => {
  const declaration = kinds[event.kind];
  if (declaration === undefined) {
    return Effect.fail(new PluginError({ message: `${event.kind}: the kind is not declared` }));
  }
  const oversized = (["payload", "raw"] as const).find(
    (field) => event[field] !== undefined && countJsonBytes(event[field]) > MAX_EMITTED_FIELD_BYTES,
  );
  if (oversized !== undefined) {
    return Effect.fail(
      new PluginError({
        message: `${event.kind}: the ${oversized} is more than ${String(MAX_EMITTED_FIELD_BYTES)} bytes as JSON`,
      }),
    );
  }
  return Effect.andThen(
    Schema.decodeUnknownEffect(EventEnvelope)(event),
    Schema.decodeUnknownEffect(declaration.schema as Schema.Codec<unknown>, {
      onExcessProperty: "error",
    })(event.payload),
  ).pipe(
    Effect.asVoid,
    Effect.mapError((error) => new PluginError({ message: `${event.kind}: ${error.message}` })),
  );
};
