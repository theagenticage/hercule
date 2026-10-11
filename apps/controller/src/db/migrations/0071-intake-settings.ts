/**
 * Adds `plugins.intake` and `connections.intake`: the user's Intake choices
 * for a plugin and for one Connection. Each holds an `IntakeOverrides` as
 * JSON, `{"eventKinds":{},"signalKinds":{}}` when the user chose nothing. Only
 * the choices that differ from the level below are stored, so every existing
 * plugin and Connection starts with none and keeps following the defaults its
 * plugin declares.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE plugins ADD COLUMN intake TEXT NOT NULL
      DEFAULT '{"eventKinds":{},"signalKinds":{}}' CHECK (json_valid(intake))
  `;
  yield* sql`
    ALTER TABLE connections ADD COLUMN intake TEXT NOT NULL
      DEFAULT '{"eventKinds":{},"signalKinds":{}}' CHECK (json_valid(intake))
  `;
});
