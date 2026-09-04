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
import { Clock, Context, Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Actor } from "@hydra/contract";

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
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

/** One audit entry: what happened, who caused it, and what it was about. */
export interface AuditEntry {
  readonly kind: AuditKind;
  readonly actor: Actor;
  /**
   * References only - an id, a name, an owner, a reason. Never a secret value,
   * a token, a password or a password hash: the event log is read by the
   * Intake views and kept for at least 90 days.
   */
  readonly payload: Readonly<Record<string, unknown>>;
}

/** An audit entry as it reads back out of the log. */
export interface AuditRow extends AuditEntry {
  readonly id: number;
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
        const at = new Date(yield* Clock.currentTimeMillis).toISOString();
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
      }),

    /** Reads the entries of one kind, oldest first. Verification only. */
    listByKind: (kind: AuditKind): Effect.Effect<ReadonlyArray<AuditRow>, SqlError> =>
      sql<{
        readonly id: number;
        readonly kind: string;
        readonly actor: string;
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
