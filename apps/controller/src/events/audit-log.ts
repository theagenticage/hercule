/**
 * The audit writer: actor-stamped mutations and security events, appended to
 * the one event log.
 *
 * There is no separate audit subsystem. The `events` table holds two
 * populations: pipeline events, which the event router evaluates against triggers
 * and subscriptions, and audit entries, which it never does. An audit entry is
 * a platform event - `source: "platform"`, no Connection - carrying the actor
 * of the mutation that caused it.
 */
import { Context, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Actor, InvalidateKind, MutableLiveTopic } from "@hercule/contract";
import { announce, nowIso } from "../db";

/**
 * The audit kinds this build emits, following `<entity>.<verb>ed`. The list
 * grows as more operations become auditable, and is never re-cut, so a kind
 * stays readable in old rows.
 */
export const AUDIT_KINDS = [
  "auth.login.succeeded",
  "auth.login.failed",
  "auth.logout.succeeded",
  "auth.apiKey.minted",
  "auth.apiKey.revoked",
  "user.passwordChanged",
  "setup.completed",
  "settings.updated",
  "profile.created",
  "profile.updated",
  "profile.deleted",
  "secret.created",
  "secret.rotated",
  "secret.deleted",
  "event.enriched",
  "task.created",
  "task.updated",
  "task.deleted",
  "project.created",
  "project.updated",
  "project.deleted",
  "resource.created",
  "resource.updated",
  "resource.deleted",
  "workspace.created",
  "workspace.deleted",
  "runner.updated",
  "runner.joinToken.minted",
  "runner.joinToken.revoked",
  "runner.joined",
  "runner.stateChanged",
  "runner.drained",
  "runner.undrained",
  "runner.retired",
  "runner.placementsChanged",
  "runner.crashLooping",
  "controller.updated",
  "plugin.enabled",
  "plugin.disabled",
  "plugin.configured",
  "plugin.retried",
  "plugin.stateReset",
  "plugin.errored",
  "connection.created",
  "connection.updated",
  "connection.credentialsSet",
  "connection.deleted",
  "provider.created",
  "provider.updated",
  "provider.deleted",
  "provider.loggedIn",
  "agent.created",
  "agent.updated",
  "agent.deleted",
  "workflow.created",
  "workflow.updated",
  "workflow.deleted",
  "session.spawned",
  "session.interrupted",
  "session.responded",
  "session.stopped",
  "session.continued",
  "session.reconciled",
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

/**
 * The kind prefixes whose entries are about a credential, a secret or the
 * user's own account. The shipped agent profiles withhold these families, so a
 * profile that may read the log still cannot read these entries: only the
 * `event.audit` grant returns them.
 *
 * `SECURITY_KINDS` is derived from the kind list rather than written out, so a
 * kind added under one of these prefixes is behind the grant from the start. The API-key
 * kinds need no prefix of their own: they are spelled `auth.apiKey.*` and so
 * fall under `auth.` already.
 */
const SECURITY_PREFIXES = ["secret.", "auth.", "user."];

/** The audit kinds only an actor holding `event.audit` is shown. */
export const SECURITY_KINDS: ReadonlyArray<AuditKind> = AUDIT_KINDS.filter((kind) =>
  SECURITY_PREFIXES.some((prefix) => kind.startsWith(prefix)),
);

/**
 * The audit kinds that record a change to a Live Topic record, and which way
 * the record changed. An entry of a kind listed here must name the record it is
 * about in `record`. The payload also holds the id, but in a different shape
 * for each verb, and the live overlay needs an id it can read without knowing
 * the verb.
 */
const RECORD_KINDS = {
  "task.created": "created",
  "task.updated": "updated",
  "task.deleted": "deleted",
  "runner.joined": "created",
  "runner.updated": "updated",
  "runner.stateChanged": "updated",
  "runner.drained": "updated",
  "runner.undrained": "updated",
  "runner.retired": "updated",
  "runner.placementsChanged": "updated",
  "plugin.enabled": "updated",
  "plugin.disabled": "updated",
  "plugin.configured": "updated",
  "plugin.retried": "updated",
  "plugin.stateReset": "updated",
  "plugin.errored": "updated",
  "connection.created": "created",
  "connection.updated": "updated",
  "connection.credentialsSet": "updated",
  "connection.deleted": "deleted",
  "provider.created": "created",
  "provider.updated": "updated",
  "provider.deleted": "deleted",
  "provider.loggedIn": "updated",
  "workflow.created": "created",
  "workflow.updated": "updated",
  "workflow.deleted": "deleted",
  "session.spawned": "created",
  // The record it names is the new session, which is what came into being.
  "session.continued": "created",
  "session.reconciled": "updated",
} as const satisfies Partial<Record<AuditKind, InvalidateKind>>;

type RecordAuditKind = keyof typeof RECORD_KINDS;

/** Which record an entry is about, in the vocabulary the live overlay uses. */
export interface AuditRecord {
  readonly topic: MutableLiveTopic;
  readonly id: string;
}

/** What every audit entry carries, whichever kind it is. */
interface AuditFields {
  /**
   * Null when the entry has no actor the system can name. For example, a failed
   * login has no actor, because its credential matched no one. Ingested and
   * scheduled events carry the same null.
   */
  readonly actor: Actor | null;
  /**
   * References only - an id, a name, an owner, a reason. Never a secret value,
   * a token, a password or a password hash: the event log is read by the
   * Intake views and kept for at least 90 days.
   */
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * When the recorded change happened: the timestamp the change wrote on its
   * own rows. An operation that stamps rows passes it, so the entry is never
   * dated before the row it describes. Without it there would be two clock
   * reads, separated by the wait for the write transaction, and a caller
   * reading the log by time could find a task created before the event that
   * records its creation. An entry with no rows to match, such as a login or a
   * logout, leaves it out, and `append` reads the clock instead.
   */
  readonly at?: string;
}

/** One audit entry: what happened, who caused it, and what it was about. */
export type AuditEntry =
  | (AuditFields & { readonly kind: RecordAuditKind; readonly record: AuditRecord })
  | (AuditFields & {
      readonly kind: Exclude<AuditKind, RecordAuditKind>;
      readonly record?: undefined;
    });

/** An audit entry as it reads back out of the log. */
export interface AuditRow {
  readonly id: number;
  readonly kind: AuditKind;
  readonly actor: Actor | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly receivedAt: string;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /**
     * Appends one audit entry, in the caller's transaction. Transactions are
     * ambient, so an append inside a `withTransaction` rolls back with the
     * mutation it records: the log never claims something that did not happen.
     */
    append: (entry: AuditEntry): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const at = entry.at ?? (yield* nowIso);
        // `dedup_key` is an emitter's idempotency key, and an audit entry has
        // none: two logins a second apart are two facts, not one repeated. A
        // random value per row satisfies the NOT NULL column, and on purpose
        // means the unique index never matches two audit entries.
        const dedupKey = crypto.randomUUID();
        yield* sql`
          INSERT INTO events
            (source, connection_id, system, kind, occurred_at, received_at,
             dedup_key, refs, url, payload, raw, actor)
          VALUES
            ('platform', NULL, 'platform', ${entry.kind}, ${at}, ${at},
             ${dedupKey}, '[]', NULL, ${JSON.stringify(entry.payload)}, NULL, ${entry.actor})
        `;
        // The log is a Live Topic of its own, so every appended row is
        // announced as a change to the log. A row about a record is also
        // announced as a change to that record.
        yield* announce({ _tag: "event" });
        if (entry.record !== undefined) {
          yield* announce({
            _tag: "record",
            topic: entry.record.topic,
            id: entry.record.id,
            kind: RECORD_KINDS[entry.kind],
          });
        }
      }),

    /** Returns the entries of one kind, oldest first. Only tests use it. */
    listByKind: (kind: AuditKind): Effect.Effect<ReadonlyArray<AuditRow>, SqlError> =>
      sql<{
        readonly id: number;
        readonly kind: string;
        readonly actor: string | null;
        readonly payload: string;
        readonly received_at: string;
      }>`SELECT id, kind, actor, payload, received_at FROM events WHERE kind = ${kind} ORDER BY id`.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            kind: row.kind as AuditKind,
            actor: row.actor,
            payload: JSON.parse(row.payload) as Readonly<Record<string, unknown>>,
            receivedAt: row.received_at,
          })),
        ),
      ),
  };
});

/** The audit writer. */
export class AuditLog extends Context.Service<AuditLog, Effect.Success<typeof make>>()(
  "hercule/controller/events/AuditLog",
) {}

export const AuditLogLayer: Layer.Layer<AuditLog, never, SqlClient.SqlClient> = Layer.effect(
  AuditLog,
  make,
);
