/**
 * Adds the second owner of an Attachment: a tool's result.
 *
 * - `session_tool_result_attachments` records which session's transcript
 *   references which image. The image itself is an ordinary row in
 *   `attachments`, with its bytes in the same `<dataDir>/attachments/<id>`
 *   file.
 * - A row here counts as a reference, like a row in
 *   `session_input_attachments`, so the hourly sweep never deletes the image.
 *   It lives as long as the session's transcript.
 * - `session_id` is indexed, because every upload looks for an attachment
 *   with the same bytes in the same session, so an image that is stored
 *   again is not written to disk twice.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE session_tool_result_attachments (
      attachment_id BLOB PRIMARY KEY NOT NULL REFERENCES attachments (id),
      session_id BLOB NOT NULL REFERENCES sessions (id)
    )
  `;
  yield* sql`
    CREATE INDEX session_tool_result_attachments_session
    ON session_tool_result_attachments (session_id)
  `;
});
