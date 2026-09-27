/**
 * The one write of the events the controller logs about itself, which have
 * `source: "platform"`. There are two kinds of them:
 *
 * - platform events, which the event router matches (`platform-events.ts`);
 * - audit entries, which it never matches (`audit-log.ts`).
 *
 * Both have no Connection, carry the actor of the mutation that caused them,
 * and are written in the caller's transaction. Each writer owns its list of
 * kinds, and both append through this function.
 */
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Actor } from "@hercule/contract";
import { announce } from "../db";

/** One event the controller logs about itself, as it goes into the log. */
export interface PlatformSourceEventToAppend {
  readonly kind: string;
  /** Null when the event has no actor the system can name. */
  readonly actor: Actor | null;
  readonly payload: unknown;
  /** When the recorded change happened. */
  readonly at: string;
}

/**
 * Appends one event with `source: "platform"` to the log, in the caller's
 * transaction, and announces the change to the log's Live Topic once the
 * transaction commits. Returns the new event's id, its position in the log.
 */
export const appendPlatformSourceEvent = (
  sql: SqlClient.SqlClient,
  event: PlatformSourceEventToAppend,
): Effect.Effect<number, SqlError> =>
  Effect.gen(function* () {
    // `dedup_key` is an emitter's idempotency key, and the controller needs
    // none: two logins a second apart are two facts, not one repeated, and a
    // run ends once because its status only moves forward. A random value per
    // event satisfies the NOT NULL column, and on purpose means the unique index
    // never matches such an event. A manual event shares that index, so a fixed
    // key would let a caller of `event.emit` post it first and suppress the
    // controller's event.
    const dedupKey = crypto.randomUUID();
    const written = yield* sql<{ readonly id: number }>`
      INSERT INTO events
        (source, connection_id, system, kind, occurred_at, received_at,
         dedup_key, refs, url, payload, raw, actor)
      VALUES
        ('platform', NULL, 'platform', ${event.kind}, ${event.at}, ${event.at},
         ${dedupKey}, '[]', NULL, ${JSON.stringify(event.payload)}, NULL, ${event.actor})
      RETURNING id
    `;
    yield* announce({ _tag: "event" });
    return written[0]!.id;
  });
