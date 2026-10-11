/**
 * Adds what Intake's Everything list searches and joins on.
 *
 * - `events_fts` is the full-text index over each event's `title` and
 *   `author`, which `event.query`'s `text` searches. Its content is the event
 *   log, so the index stores terms only.
 * - Two indexes let one page of events look up what came of each event: the
 *   signals it ended and the tasks it is the provenance of. The signals it
 *   raised, or is evidence for, are found through `signal_events`, which is
 *   already indexed by event.
 * - An index on the event's source lets a filter on a rare source walk only
 *   that source's events, newest first, instead of the whole log.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // `remove_diacritics 2` folds the whole Unicode range, as `tasks_fts` does,
  // so `cafe` finds `Café`. The event's id is its rowid, so the index is keyed
  // by the event's id.
  yield* sql`
    CREATE VIRTUAL TABLE events_fts USING fts5(
      title,
      author,
      content = 'events',
      content_rowid = 'id',
      tokenize = 'unicode61 remove_diacritics 2'
    )
  `;
  // SQLite does not maintain an external-content index, so these two triggers
  // keep it current. An event is written once and never edited: enrichment
  // changes only `system`, `url` and `refs`, which are not indexed, so there
  // is no update trigger. The delete trigger removes the entry of every event
  // the log prunes, with the old title and author, because fts5 cannot remove
  // an entry without the text it indexed. Both triggers fire for every event,
  // including those with neither field: such a row adds no terms, and the
  // insert and the delete stay symmetric.
  yield* sql`
    CREATE TRIGGER events_fts_insert AFTER INSERT ON events BEGIN
      INSERT INTO events_fts (rowid, title, author) VALUES (new.id, new.title, new.author);
    END
  `;
  yield* sql`
    CREATE TRIGGER events_fts_delete AFTER DELETE ON events BEGIN
      INSERT INTO events_fts (events_fts, rowid, title, author)
      VALUES ('delete', old.id, old.title, old.author);
    END
  `;
  // Indexes every event already in the log. Events have carried a title and
  // an author since the Intake signals migration, so without this those
  // events would never be found, and the delete trigger would remove terms
  // the index never held, which corrupts an external-content index.
  yield* sql`INSERT INTO events_fts (events_fts) VALUES ('rebuild')`;

  // The signals an event ended: a signal ended on its source names that
  // event in its resolution. A query must write the expression exactly as it
  // is written here, or SQLite does not use the index.
  yield* sql`
    CREATE INDEX signals_resolution_event ON signals (json_extract(resolution, '$.eventId'))
    WHERE json_extract(resolution, '$.eventId') IS NOT NULL
  `;
  // The tasks an event is the provenance of.
  yield* sql`
    CREATE INDEX task_provenance_event ON task_provenance (event_id) WHERE event_id IS NOT NULL
  `;

  // The events of one source in id order, which is the order of a page, so a
  // `source` filter stops after one page without a sort.
  yield* sql`CREATE INDEX events_source ON events (source, id)`;
});
