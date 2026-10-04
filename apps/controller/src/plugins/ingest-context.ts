/**
 * Builds the `IngestContext` an event source's `open` receives for one
 * Connection. It holds:
 *
 * - `emit`, which checks an event against what the source declared and
 *   appends it to the event log, stamped with the Connection;
 * - `state`, the key-value store of that one Connection;
 * - `credentials`, read through the plugin's own `ConnectionsRuntime`;
 * - `resources`, the Resources linked to the Connection, only when the
 *   plugin's manifest requested the `resources` capability.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import {
  bounded,
  ExternalRef,
  MAX_DEDUP_KEY_LENGTH,
  MAX_EVENT_SYSTEM_LENGTH,
  MAX_EVENT_URL_LENGTH,
} from "@hercule/contract";
import {
  MAX_EMITTED_FIELD_BYTES,
  PluginError,
  type IngestConnection,
  type EmittedEvent,
  type IngestContext,
  type LinkedResource,
} from "@hercule/plugin-host";
import { nowIso, withTransaction } from "../db";
import {
  assertConnectionIngesting,
  connectionStateRepository,
  ConnectionTypes,
} from "../connections";
import { appendIngestedEvent, decodeAgainstKind } from "../events";
import { resourceRepository, type StoredResource } from "../resources";
import { describeFieldIssues, truncateMessage } from "./errors";
import type { RegisteredEventSource } from "./event-sources";

/**
 * The fields of an emitted event that are the same for every kind. An unknown
 * key is ignored here, because `kind` and `payload` are checked on their own.
 */
const decodeEmittedEventFields = Schema.decodeUnknownEffect(
  Schema.Struct({
    dedupKey: bounded(1, MAX_DEDUP_KEY_LENGTH),
    occurredAt: Schema.String,
    refs: Schema.Array(ExternalRef),
    url: Schema.optionalKey(bounded(1, MAX_EVENT_URL_LENGTH)),
    system: Schema.optionalKey(bounded(1, MAX_EVENT_SYSTEM_LENGTH)),
    raw: Schema.optionalKey(Schema.JsonObject),
  }),
  { errors: "all" },
);

/** An ISO 8601 date and time with an explicit time zone, such as `2026-01-31T09:30:00Z`. */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Converts an emitted `occurredAt` to the log's own format, UTC with
 * milliseconds, so the log sorts and compares every event's time the same
 * way. Fails with a `PluginError` when the value is not an ISO 8601 timestamp
 * with a time zone: without a zone, the instant it names is a guess.
 */
const normalizeOccurredAt = (kind: string, value: string): Effect.Effect<string, PluginError> => {
  const time = ISO_TIMESTAMP.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isNaN(time)
    ? Effect.fail(
        new PluginError({
          message: truncateMessage(
            `the occurredAt of a ${kind} event must be an ISO 8601 timestamp with a time zone, ` +
              `such as 2026-01-31T09:30:00Z, but was "${value}"`,
          ),
        }),
      )
    : Effect.succeed(new Date(time).toISOString());
};

/**
 * Fails with a `PluginError` when `value`, as UTF-8 JSON, is larger than
 * `limit` bytes. `field` names the value in the message.
 */
const assertJsonSizeWithin = (
  kind: string,
  field: "payload" | "raw",
  value: unknown,
  limit: number,
): Effect.Effect<void, PluginError> => {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  return bytes <= limit
    ? Effect.void
    : Effect.fail(
        new PluginError({
          message:
            `the ${field} of a ${kind} event is ${bytes} bytes as JSON, more than the limit of ${limit}. ` +
            `Leave out what a workflow does not need, or shorten long text fields.`,
        }),
      );
};

/** Converts a stored Resource to what an ingest handle reads: a repo's canonical remote, or null. */
const toLinkedResource = (resource: StoredResource): LinkedResource => ({
  id: resource.id,
  kind: resource.kind,
  label: resource.label,
  remote: resource.canonicalRemote,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const connectionTypes = yield* ConnectionTypes;
  const connectionState = yield* connectionStateRepository;
  const resources = yield* resourceRepository;

  /**
   * Checks one emitted event and appends it to the log in its own short
   * transaction. Fails with a `PluginError` when the source did not declare
   * the kind, when the payload does not match the kind's schema, when a
   * common field is invalid, or when the payload or `raw` is too large. An
   * event whose dedup key the log already holds for this Connection succeeds
   * and writes nothing. Dies with `ConnectionNotIngesting` when the
   * Connection was deleted or left the ingesting statuses.
   */
  const emit = (
    source: RegisteredEventSource,
    connectionId: string,
    event: EmittedEvent,
  ): Effect.Effect<void, PluginError> =>
    Effect.gen(function* () {
      const kind = source.kinds.get(event.kind);
      if (kind === undefined) {
        return yield* Effect.fail(
          new PluginError({
            message: truncateMessage(
              `the event source ${source.id} did not declare the event kind ${event.kind}. ` +
                `Add it to the source's kinds before emitting it.`,
            ),
          }),
        );
      }
      const envelope = yield* Effect.mapError(
        decodeEmittedEventFields(event),
        (error) =>
          new PluginError({
            message: truncateMessage(`a ${event.kind} event: ${describeFieldIssues(error)}`),
          }),
      );
      yield* Effect.mapError(
        decodeAgainstKind(kind.schema, event.payload),
        (error) =>
          new PluginError({
            message: truncateMessage(
              `the payload of a ${event.kind} event does not match the kind's schema: ` +
                describeFieldIssues(error),
            ),
          }),
      );
      yield* assertJsonSizeWithin(event.kind, "payload", event.payload, MAX_EMITTED_FIELD_BYTES);
      if (envelope.raw !== undefined) {
        yield* assertJsonSizeWithin(event.kind, "raw", envelope.raw, MAX_EMITTED_FIELD_BYTES);
      }
      const occurredAt = yield* normalizeOccurredAt(event.kind, envelope.occurredAt);
      const receivedAt = yield* nowIso;
      // A database failure is a defect: the plugin cannot recover from it,
      // and the loop that called `poll` logs it and retries the feed. The
      // Connection is checked in the same transaction as the append, so an
      // event is never written after a delete or a disable has committed.
      yield* Effect.orDie(
        withTransaction(
          sql,
          Effect.andThen(
            assertConnectionIngesting(sql, connectionId),
            appendIngestedEvent(sql, {
              source: source.pluginId,
              connectionId,
              system: envelope.system ?? source.pluginId,
              kind: event.kind,
              occurredAt,
              receivedAt,
              dedupKey: envelope.dedupKey,
              // Each ref once, as `event.emit` stores them.
              refs: [...new Set(envelope.refs)],
              url: envelope.url ?? null,
              payload: event.payload,
              raw: envelope.raw ?? null,
            }),
          ),
        ),
      );
    });

  return {
    /**
     * Builds the context `open` receives for one Connection of the source's
     * type. Every service in it is scoped to that Connection, so nothing the
     * plugin passes reaches another Connection's events, state or Resources.
     */
    buildIngestContext: (
      source: RegisteredEventSource,
      connection: IngestConnection,
    ): IngestContext => ({
      emit: (event) => emit(source, connection.id, event),
      state: connectionState.buildStore(connection.id),
      credentials: () => connectionTypes.runtimeFor(source.pluginId).credentials(connection.id),
      ...(source.resources
        ? {
            resources: {
              // Read at each call, so a Resource the user links later is in
              // the next answer.
              list: () =>
                Effect.orDie(
                  Effect.map(resources.listLinkedToConnection(connection.id), (rows) =>
                    rows.map(toLinkedResource),
                  ),
                ),
            },
          }
        : {}),
    }),
  };
});

/** Builds the `IngestContext` of each Connection the ingest loops open. */
export const ingestContexts = make;
