/**
 * Test helpers for the event log: reading back the audit entries and platform
 * events the controller wrote about itself. The controller never reads these
 * rows by kind, so the read lives here rather than on the services that write
 * them.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Actor } from "@hercule/contract";
import type { AuditKind } from "./audit-log";
import type { PlatformEventKind } from "./platform-events";

/** An audit entry or a platform event, as it reads back out of the log. */
export interface LoggedEvent<Kind extends AuditKind | PlatformEventKind> {
  readonly id: number;
  readonly kind: Kind;
  readonly actor: Actor | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly receivedAt: string;
}

/**
 * Returns the audit entries or platform events of one kind, oldest first.
 * Fails only when the database does.
 */
export const readEventsOfKind = <Kind extends AuditKind | PlatformEventKind>(
  kind: Kind,
): Effect.Effect<ReadonlyArray<LoggedEvent<Kind>>, SqlError, SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    Effect.map(
      sql<{
        readonly id: number;
        readonly actor: string | null;
        readonly payload: string;
        readonly received_at: string;
      }>`SELECT id, actor, payload, received_at FROM events WHERE kind = ${kind} ORDER BY id`,
      (rows) =>
        rows.map((row) => ({
          id: row.id,
          kind,
          actor: row.actor,
          payload: JSON.parse(row.payload) as Readonly<Record<string, unknown>>,
          receivedAt: row.received_at,
        })),
    ),
  );
