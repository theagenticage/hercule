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

/**
 * Inserts session `s` and image `a`, then tries to link `attachmentId` to
 * `sessionId`, and returns whether the link was stored. Both rows exist, so
 * a refusal can only come from the id that names a missing row.
 */
const tryLink = (attachmentId: string, sessionId: string) =>
  runOnMigratedDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                       requested_access_mode, access_mode, spec, title, status,
                                       created_at, last_activity_at)
        VALUES ('s', 'profile', 'instance', 'runner', 'auto', 'auto', '{}', 'a', 'idle',
                'now', 'now')`;
      yield* sql`INSERT INTO attachments (id, name, mime_type, size_bytes, sha256, created_at, actor)
                 VALUES ('a', 'image.png', 'image/png', 10, 'hash', 'now', 'session:s')`;
      return yield* Effect.result(
        sql`INSERT INTO session_tool_result_attachments (attachment_id, session_id)
            VALUES (${attachmentId}, ${sessionId})`,
      );
    }),
  );

describe("session tool result attachments migration", () => {
  it("links an image that exists to a session that exists", async () => {
    expect((await tryLink("a", "s"))._tag).toBe("Success");
  });

  it("refuses a link to an image that does not exist", async () => {
    expect((await tryLink("missing", "s"))._tag).toBe("Failure");
  });

  it("refuses a link to a session that does not exist", async () => {
    expect((await tryLink("a", "missing"))._tag).toBe("Failure");
  });
});
