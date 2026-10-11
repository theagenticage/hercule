/**
 * Checks an event the way the host does before it stores one. The feed checks
 * every event it computes before it writes the outbox, because an event the
 * host refuses would stay in the outbox and fail every later poll.
 */
import { Effect, Schema } from "effect";
import {
  EXTERNAL_REF_PATTERN,
  MAX_DEDUP_KEY_LENGTH,
  MAX_EMITTED_FIELD_BYTES,
  MAX_EVENT_AUTHOR_LENGTH,
  MAX_EVENT_SYSTEM_LENGTH,
  MAX_EVENT_TITLE_LENGTH,
  MAX_EVENT_URL_LENGTH,
  MAX_EXTERNAL_REF_LENGTH,
  PluginError,
  type EmittedEvent,
} from "@hercule/plugin-host";
import { SENTRY_EVENT_KINDS } from "../kinds";
import { ISO_TIMESTAMP_PATTERN } from "../sentry-objects";

/** A string of at least `minimum` and at most `maximum` characters. */
const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isLengthBetween(minimum, maximum));

const ExternalRef = Schema.String.check(
  Schema.isMaxLength(MAX_EXTERNAL_REF_LENGTH),
  Schema.isPattern(EXTERNAL_REF_PATTERN),
);

/** The fields every event has, whatever its kind, with the limits the host enforces. */
const EventEnvelope = Schema.Struct({
  dedupKey: bounded(1, MAX_DEDUP_KEY_LENGTH),
  occurredAt: Schema.String.check(Schema.isPattern(ISO_TIMESTAMP_PATTERN)),
  refs: Schema.Array(ExternalRef),
  url: Schema.optionalKey(bounded(1, MAX_EVENT_URL_LENGTH)),
  system: Schema.optionalKey(bounded(1, MAX_EVENT_SYSTEM_LENGTH)),
  raw: Schema.optionalKey(Schema.JsonObject),
  title: bounded(1, MAX_EVENT_TITLE_LENGTH),
  author: Schema.NullOr(bounded(1, MAX_EVENT_AUTHOR_LENGTH)),
});

/**
 * Checks one event before it is stored or emitted. Returns nothing when the
 * host would accept it. Fails with a `PluginError` naming the kind when:
 *
 * - the kind is not one the plugin declares;
 * - the payload is larger than `MAX_EMITTED_FIELD_BYTES` as UTF-8 JSON;
 * - a field every event has breaks the host's limits;
 * - the payload does not match the kind's schema exactly, extra fields included.
 */
export const checkEmittedEvent = (event: EmittedEvent): Effect.Effect<void, PluginError> => {
  const declaration = SENTRY_EVENT_KINDS[event.kind];
  if (declaration === undefined) {
    return Effect.fail(new PluginError({ message: `Undeclared kind ${event.kind}` }));
  }
  const payloadBytes = new TextEncoder().encode(JSON.stringify(event.payload)).length;
  if (payloadBytes > MAX_EMITTED_FIELD_BYTES) {
    return Effect.fail(
      new PluginError({
        message: `${event.kind}: the payload is ${String(payloadBytes)} bytes, over the limit of ${String(MAX_EMITTED_FIELD_BYTES)}`,
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
