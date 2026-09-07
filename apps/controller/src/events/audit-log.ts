/**
 * The audit writer: actor-stamped mutations and security events, appended to
 * the one event log.
 *
 * There is no separate audit subsystem. The `events` table holds two
 * populations: pipeline events, which the matcher evaluates against triggers
 * and subscriptions, and audit entries, which it never does. An audit entry is
 * a platform event - `source: "platform"`, no Connection - carrying the actor
 * of the mutation that caused it.
 */
import { Context, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Actor, InvalidateKind, MutableLiveTopic } from "@hydra/contract";
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
  "task.created",
  "task.updated",
  "task.deleted",
  "project.created",
  "project.updated",
  "project.deleted",
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
  "provider.created",
  "provider.updated",
  "provider.deleted",
  "provider.loggedIn",
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

/**
 * The audit kinds that record a change to a Live Topic record, and which way
 * the record changed. A kind listed here has to name the record it is about:
 * the id sits in the free-form payload under a different shape per verb, and
 * the live overlay needs one it can read without knowing the verb.
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
  "provider.created": "created",
  "provider.updated": "updated",
  "provider.deleted": "deleted",
  "provider.loggedIn": "updated",
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
   * Null where nothing caused the entry that the system can name: a login that
   * failed was made by nobody, because the credential it presented resolved to
   * nobody. The same null that an ingested or scheduled event carries.
   */
  readonly actor: Actor | null;
  /**
   * References only - an id, a name, an owner, a reason. Never a secret value,
   * a token, a password or a password hash: the event log is read by the
   * Intake views and kept for at least 90 days.
   */
  readonly payload: Readonly<Record<string, unknown>>;
  /**
   * When the change this entry records happened, which is the timestamp that
   * change wrote on its own rows. An operation that stamps rows passes it, so
   * the entry cannot be dated before the row it describes: the two clock reads
   * it would otherwise take are separated by the wait for the write
   * transaction, and a caller reading the log by time would then find a task
   * created before the event that records its creation. An entry with nothing
   * to agree with - a login, a logout - leaves it out and is timed here.
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
        // random value per row satisfies the NOT NULL column and makes the
        // unique index vacuous for this population - deliberate, not accidental.
        const dedupKey = crypto.randomUUID();
        yield* sql`
          INSERT INTO events
            (source, connection_id, system, kind, occurred_at, received_at,
             dedup_key, refs, url, payload, raw, actor)
          VALUES
            ('platform', NULL, 'platform', ${entry.kind}, ${at}, ${at},
             ${dedupKey}, '[]', NULL, ${JSON.stringify(entry.payload)}, NULL, ${entry.actor})
        `;
        // The log is a Live Topic of its own, so every row appended to it is
        // news the log grew; a row about a record is also that record changing.
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

    /** Reads the entries of one kind, oldest first. Verification only. */
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
  "hydra/controller/events/AuditLog",
) {}

export const AuditLogLayer: Layer.Layer<AuditLog, never, SqlClient.SqlClient> = Layer.effect(
  AuditLog,
  make,
);
