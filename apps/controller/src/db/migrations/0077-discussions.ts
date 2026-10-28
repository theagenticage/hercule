/**
 * Adds Discussions (spec 19 sections 2.1, 2.2 and 5):
 *
 * - `discussions`, one row per Discussion, keyed by the repository it is
 *   about. `resource_id` has no foreign key on purpose: a Discussion outlives
 *   its Resource, and keeps the repository's name in `repository`.
 * - `discussion_posts`, the Posts. A Post is never edited or deleted. A Post
 *   whose actor is `system` is a system Post, counted against its own cap.
 * - `discussion_participants`, the sessions that take part, numbered in the
 *   order they joined. Each row also records what its session has been
 *   told: `told_through_post_id` is the newest Post of the Discussion it has
 *   been told about, and `entry_pending` is 1 while an Edit Overlap has put
 *   it in and it has not been told so yet.
 * - `discussion_shared_files`, the files an Edit Overlap shared, numbered in
 *   the order they were shared, each with the sessions whose edits made it
 *   shared, as a JSON array of ids in the order they edited it.
 *
 * It also lets `session_inputs` hold Discussion Inputs: the source check gains
 * `discussion`.
 *
 * SQLite cannot widen a check in place, so `session_inputs` is rebuilt, with
 * the four indexes `DROP TABLE` drops. `session_input_attachments` references
 * it, and foreign keys stay on inside the migration's transaction, so that
 * table is rebuilt beside it: both new tables are filled, both old ones
 * dropped, child first, and both renamed. Renaming `session_inputs_next`
 * rewrites the reference in `session_input_attachments_next` to the final
 * name.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE discussions (
      id BLOB PRIMARY KEY NOT NULL,
      resource_id BLOB NOT NULL,
      repository TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('overlap', 'general')),
      subject TEXT NOT NULL,
      last_post_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  // A listing sorts by the last Post or by creation, newest first, over every
  // repository or over one, so each order has an index with and without it.
  yield* sql`CREATE INDEX discussions_by_last_post ON discussions (last_post_at, id)`;
  yield* sql`CREATE INDEX discussions_by_created ON discussions (created_at, id)`;
  yield* sql`
    CREATE INDEX discussions_by_resource_last_post ON discussions (resource_id, last_post_at, id)
  `;
  yield* sql`
    CREATE INDEX discussions_by_resource_created ON discussions (resource_id, created_at, id)
  `;
  // A listing filtered by kind alone would otherwise read every Discussion of
  // the other kind, and Discussions are never deleted.
  yield* sql`CREATE INDEX discussions_by_kind_last_post ON discussions (kind, last_post_at, id)`;
  yield* sql`CREATE INDEX discussions_by_kind_created ON discussions (kind, created_at, id)`;

  yield* sql`
    CREATE TABLE discussion_posts (
      id BLOB PRIMARY KEY NOT NULL,
      discussion_id BLOB NOT NULL REFERENCES discussions (id),
      actor TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  // Post ids are UUIDv7, so a Discussion's Posts sort oldest first by id. The
  // actor is in the index so counting the Posts that are not system Posts
  // reads the index alone.
  yield* sql`
    CREATE INDEX discussion_posts_by_discussion ON discussion_posts (discussion_id, id, actor)
  `;

  yield* sql`
    CREATE TABLE discussion_participants (
      discussion_id BLOB NOT NULL REFERENCES discussions (id),
      session_id BLOB NOT NULL REFERENCES sessions (id),
      position INTEGER NOT NULL,
      joined_at TEXT NOT NULL,
      told_through_post_id BLOB,
      entry_pending INTEGER NOT NULL DEFAULT 0 CHECK (entry_pending IN (0, 1)),
      PRIMARY KEY (discussion_id, session_id),
      UNIQUE (discussion_id, position)
    )
  `;
  // `discussion.query --session` lists the Discussions one session takes part in.
  yield* sql`CREATE INDEX discussion_participants_by_session ON discussion_participants (session_id)`;

  yield* sql`
    CREATE TABLE discussion_shared_files (
      discussion_id BLOB NOT NULL REFERENCES discussions (id),
      path TEXT NOT NULL,
      position INTEGER NOT NULL,
      session_ids TEXT NOT NULL,
      shared_at TEXT NOT NULL,
      PRIMARY KEY (discussion_id, path),
      UNIQUE (discussion_id, position)
    )
  `;

  yield* sql`
    CREATE TABLE session_inputs_next (
      id BLOB PRIMARY KEY NOT NULL,
      session_id BLOB NOT NULL,
      source TEXT NOT NULL
        CHECK (source IN ('user', 'subscription', 'heartbeat', 'reminder', 'discussion')),
      actor TEXT NOT NULL,
      text TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'sent', 'delivered', 'cancelled')),
      delivery TEXT CHECK (delivery IS NULL OR delivery IN ('opened', 'steered')),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      sent_at TEXT,
      reason TEXT,
      subscription_id BLOB,
      event_id INTEGER CHECK ((subscription_id IS NULL) = (event_id IS NULL)),
      step_iteration INTEGER,
      CHECK (status <> 'sent' OR sent_at IS NOT NULL)
    )
  `;
  yield* sql`
    INSERT INTO session_inputs_next
      (id, session_id, source, actor, text, status, delivery, created_at, delivered_at,
       sent_at, reason, subscription_id, event_id, step_iteration)
    SELECT id, session_id, source, actor, text, status, delivery, created_at, delivered_at,
           sent_at, reason, subscription_id, event_id, step_iteration
    FROM session_inputs
  `;
  yield* sql`
    CREATE TABLE session_input_attachments_next (
      input_id BLOB NOT NULL REFERENCES session_inputs_next (id),
      attachment_id BLOB NOT NULL REFERENCES attachments (id),
      position INTEGER NOT NULL,
      PRIMARY KEY (input_id, position)
    )
  `;
  yield* sql`
    INSERT INTO session_input_attachments_next (input_id, attachment_id, position)
    SELECT input_id, attachment_id, position FROM session_input_attachments
  `;
  yield* sql`DROP TABLE session_input_attachments`;
  yield* sql`DROP TABLE session_inputs`;
  yield* sql`ALTER TABLE session_inputs_next RENAME TO session_inputs`;
  yield* sql`ALTER TABLE session_input_attachments_next RENAME TO session_input_attachments`;

  yield* sql`CREATE INDEX session_inputs_session ON session_inputs (session_id, created_at, id)`;
  yield* sql`
    CREATE UNIQUE INDEX session_inputs_match ON session_inputs (subscription_id, event_id)
    WHERE subscription_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX session_inputs_awaiting ON session_inputs (session_id)
    WHERE status = 'queued' AND sent_at IS NULL
  `;
  yield* sql`
    CREATE INDEX session_inputs_event ON session_inputs (event_id) WHERE event_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX session_input_attachments_by_attachment
    ON session_input_attachments (attachment_id)
  `;
});
