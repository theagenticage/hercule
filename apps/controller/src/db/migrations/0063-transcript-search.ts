/**
 * Adds what `transcript.query` searches and filters on.
 *
 * - `transcript_messages` is a view over `session_stream` with one row per
 *   stream row that holds the text a person or an agent wrote, and that text.
 *   It is the one place that decides what a message is.
 * - `transcript_fts` is the full-text index over that text. Its content is the
 *   view, so the index stores terms only and the text stays in the stream.
 * - `sessions.created_by` is the actor stamp of the operation that created the
 *   session, which `actor: "me"` filters on.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A message's text is in exactly one kind of row, so no message is indexed
  // twice:
  //
  // - A user message is in the `detail.text` of its `user_message` item. Its
  //   `item.started` and its `item.completed` both carry the same text, so
  //   only `item.started` is indexed. A subagent's brief is such an item too.
  // - An assistant message is in its `content.delta` rows with stream kind
  //   `assistant_text`; its `item.started` and `item.completed` carry no text.
  //   The controller coalesces the deltas into one row per item, flushed at
  //   4 KiB, so a long message is stored as several rows. Each row holds a
  //   different piece of the message, and each piece is indexed once.
  //
  // Reasoning and command output are not messages, so they are left out.
  //
  // The row's implicit rowid is the index's key. Stream rows are only ever
  // inserted, never updated or deleted, so the index needs no update or
  // delete trigger. `tasks_fts` depends on its table's rowid the same way.
  yield* sql`
    CREATE VIEW transcript_messages AS
    SELECT stream_rowid, text FROM (
      SELECT rowid AS stream_rowid,
        CASE
          WHEN json_extract(event, '$._tag') = 'item.started'
            AND json_extract(event, '$.kind') = 'user_message'
            THEN json_extract(event, '$.detail.text')
          WHEN json_extract(event, '$._tag') = 'content.delta'
            AND json_extract(event, '$.streamKind') = 'assistant_text'
            THEN json_extract(event, '$.delta')
        END AS text
      FROM session_stream
    )
    WHERE text <> ''
  `;
  // `remove_diacritics 2` folds the whole Unicode range, as `tasks_fts` does,
  // so `cafe` finds `Café`.
  yield* sql`
    CREATE VIRTUAL TABLE transcript_fts USING fts5(
      text,
      content = 'transcript_messages',
      content_rowid = 'stream_rowid',
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `;
  // Every stream row is looked up in the view by its rowid, and the view
  // returns nothing for a row that holds no message, so this trigger needs no
  // condition of its own that could disagree with the view.
  yield* sql`
    CREATE TRIGGER transcript_fts_insert AFTER INSERT ON session_stream BEGIN
      INSERT INTO transcript_fts (rowid, text)
      SELECT stream_rowid, text FROM transcript_messages WHERE stream_rowid = new.rowid;
    END
  `;
  // Indexes every message already in the stream, read through the view.
  yield* sql`INSERT INTO transcript_fts (transcript_fts) VALUES ('rebuild')`;

  // Null when nobody can tell any more who created the session. The backfill
  // reads the audit entry of the session's creation, and the event log keeps
  // entries only for its retention window, so an older session stays null and
  // `actor: "me"` never matches it. The first input's actor is not a source
  // either: `input.update` replaces it with the actor of whoever edited it.
  yield* sql`ALTER TABLE sessions ADD COLUMN created_by TEXT`;
  // An entry's `sessionId` is the canonical id as text, and the row's id is
  // its 16 bytes, so both are compared as lowercase hex without dashes.
  yield* sql`
    UPDATE sessions SET created_by = (
      SELECT events.actor FROM events
      WHERE events.source = 'platform'
        AND events.kind IN ('session.spawned', 'session.continued')
        AND lower(replace(json_extract(events.payload, '$.sessionId'), '-', ''))
          = lower(hex(sessions.id))
      ORDER BY events.id LIMIT 1
    )
  `;
});
