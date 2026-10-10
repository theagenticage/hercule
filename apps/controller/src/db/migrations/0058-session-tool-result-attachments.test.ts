import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** Runs every migration up to 58 on an empty database, then `body`, and returns what `body` returns. */
const runOnMigratedDatabase = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runMigrations(migrations.filter(([id]) => id <= 58));
      return yield* body;
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

describe("session tool images migration", () => {
  it("refuses a link to an image that does not exist", async () => {
    const outcome = await runOnMigratedDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* Effect.result(
          sql`INSERT INTO session_tool_result_attachments (attachment_id, session_id) VALUES ('missing', 's')`,
        );
      }),
    );
    expect(outcome._tag).toBe("Failure");
  });

  it("refuses a link to a session that does not exist", async () => {
    const outcome = await runOnMigratedDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO attachments (id, name, mime_type, size_bytes, sha256, created_at, actor)
                   VALUES ('a', 'image.png', 'image/png', 10, 'hash', 'now', 'session:s')`;
        return yield* Effect.result(
          sql`INSERT INTO session_tool_result_attachments (attachment_id, session_id) VALUES ('a', 'missing')`,
        );
      }),
    );
    expect(outcome._tag).toBe("Failure");
  });
});
