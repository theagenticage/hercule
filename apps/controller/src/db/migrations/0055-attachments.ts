/**
 * Adds Attachments: the images a user attaches to an input.
 *
 * - `attachments` holds one row per uploaded image. Its bytes are a file at
 *   `<dataDir>/attachments/<id>`, so the row keeps no path.
 * - `session_input_attachments` records which input references which image,
 *   in the order the user attached them. An image no row here references, and
 *   that is older than a day, is deleted by the hourly sweep.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE attachments (
      id BLOB PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL
        CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp')),
      size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      actor TEXT NOT NULL
    )
  `;
  // The sweep looks for old rows; the index keeps it from reading every row.
  yield* sql`CREATE INDEX attachments_by_created_at ON attachments (created_at)`;
  yield* sql`
    CREATE TABLE session_input_attachments (
      input_id BLOB NOT NULL REFERENCES session_inputs (id),
      attachment_id BLOB NOT NULL REFERENCES attachments (id),
      position INTEGER NOT NULL,
      PRIMARY KEY (input_id, position)
    )
  `;
  // The sweep and the read check ask whether any input references an image.
  yield* sql`
    CREATE INDEX session_input_attachments_by_attachment
    ON session_input_attachments (attachment_id)
  `;
});
