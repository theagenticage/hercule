/**
 * Adds the input status `sent`: the input left the controller, and the
 * runner never confirmed it. Only an agent step's prompt ends in it. Such a
 * prompt is never sent again, because a second turn could repeat what the
 * first one did, and the runner's answer about the step settles the step.
 *
 * Before this migration, such a prompt was stored `cancelled`, with its
 * `sent_at` kept and a reason. That was false: the runner may have taken the
 * prompt, and the step may have completed from it. Every row in that shape
 * becomes `sent`, and loses the reason, which the status now states. Only
 * those rows ever had a `sent_at` on a cancelled step prompt, so the shape
 * picks them out exactly.
 *
 * A table CHECK makes a `sent` row always record when it was sent.
 *
 * The table is rebuilt rather than altered, because SQLite cannot widen a
 * CHECK in place. Every other column and constraint is unchanged, and the
 * three indexes, which `DROP TABLE` drops, are created again. Nothing
 * references the table.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE session_inputs_new (
      id BLOB PRIMARY KEY NOT NULL,
      session_id BLOB NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('user', 'subscription', 'heartbeat', 'reminder')),
      actor TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'cancelled')),
      delivery TEXT CHECK (delivery IS NULL OR delivery IN ('opened', 'steered')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      -- When the input was sent, while the runner has not answered: on a
      -- queued row on its way, and on a sent row. Null otherwise. So a row is
      -- waiting (queued, null), on its way (queued, set), sent (sent, set),
      -- delivered or cancelled.
      sent_at TEXT,
      -- Why a delivery did not go through, in the runner's or the
      -- controller's own words: set on a row still queued (until it is sent
      -- again) or on one a failed delivery cancelled.
      reason TEXT,
      subscription_id BLOB,
      event_id INTEGER CHECK ((subscription_id IS NULL) = (event_id IS NULL)),
      step_iteration INTEGER,
      CHECK (status <> 'sent' OR sent_at IS NOT NULL)
    )
  `;
  yield* sql`
    INSERT INTO session_inputs_new
      (id, session_id, source, actor, text, status, delivery, created_at, delivered_at,
       sent_at, reason, subscription_id, event_id, step_iteration)
    SELECT
      id, session_id, source, actor, text,
      CASE WHEN status = 'cancelled' AND sent_at IS NOT NULL AND step_iteration IS NOT NULL
           THEN 'sent' ELSE status END,
      delivery, created_at, delivered_at, sent_at,
      CASE WHEN status = 'cancelled' AND sent_at IS NOT NULL AND step_iteration IS NOT NULL
           THEN NULL ELSE reason END,
      subscription_id, event_id, step_iteration
    FROM session_inputs
  `;
  yield* sql`DROP TABLE session_inputs`;
  yield* sql`ALTER TABLE session_inputs_new RENAME TO session_inputs`;

  yield* sql`CREATE INDEX session_inputs_session ON session_inputs (session_id, created_at, id)`;
  yield* sql`
    CREATE UNIQUE INDEX session_inputs_match ON session_inputs (subscription_id, event_id)
    WHERE subscription_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX session_inputs_awaiting ON session_inputs (session_id)
    WHERE status = 'queued' AND sent_at IS NULL
  `;
});
