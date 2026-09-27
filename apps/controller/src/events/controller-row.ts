/**
 * The rows the controller writes about itself: audit entries and platform
 * events. Both are `source: "platform"` rows with no Connection, carrying the
 * actor of the mutation that caused them, and both are written in the
 * caller's transaction. They differ only in whether the event router matches
 * them: it matches platform events and never audit entries. The audit writer
 * (`audit-log.ts`) and the platform event writer (`platform-events.ts`) each
 * own their list of kinds, and share the write and the read here.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Actor } from "@hercule/contract";
import { announce } from "../db";

/** One row the controller writes about itself, as it goes into the log. */
export interface ControllerRowToAppend {
  readonly kind: string;
  /** Null when the row has no actor the system can name. */
  readonly actor: Actor | null;
  readonly payload: unknown;
  /** When the recorded change happened. */
  readonly at: string;
}

/** One row the controller wrote about itself, as it reads back out of the log. */
export interface ControllerRow<Kind extends string> {
  readonly id: number;
  readonly kind: Kind;
  readonly actor: Actor | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly receivedAt: string;
}

/**
 * Appends one row the controller writes about itself, in the caller's
 * transaction, and announces the change to the log's Live Topic once the
 * transaction commits.
 */
export const appendControllerRow = (
  sql: SqlClient.SqlClient,
  row: ControllerRowToAppend,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    // `dedup_key` is an emitter's idempotency key, and the controller needs
    // none: two logins a second apart are two facts, not one repeated, and a
    // run ends once because its status only moves forward. A random value per
    // row satisfies the NOT NULL column, and on purpose means the unique index
    // never matches such a row. A manual event shares that index, so a fixed
    // key would let a caller of `event.emit` post it first and suppress the
    // controller's row.
    const dedupKey = crypto.randomUUID();
    yield* sql`
      INSERT INTO events
        (source, connection_id, system, kind, occurred_at, received_at,
         dedup_key, refs, url, payload, raw, actor)
      VALUES
        ('platform', NULL, 'platform', ${row.kind}, ${row.at}, ${row.at},
         ${dedupKey}, '[]', NULL, ${JSON.stringify(row.payload)}, NULL, ${row.actor})
    `;
    yield* announce({ _tag: "event" });
  });

/** Returns the rows of one kind, oldest first. Only tests use it. */
export const listControllerRows = <Kind extends string>(
  sql: SqlClient.SqlClient,
  kind: Kind,
): Effect.Effect<ReadonlyArray<ControllerRow<Kind>>, SqlError> =>
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
  );
