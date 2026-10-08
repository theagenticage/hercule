import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** Runs every migration up to 55 on an empty database, then `body`, and returns what `body` returns. */
const runOnMigratedDatabase = <A, E>(body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* runMigrations(migrations.filter(([id]) => id <= 55));
      return yield* body;
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

describe("attachments migration", () => {
  it("refuses a media type that is not one of the four image types", async () => {
    const outcome = await runOnMigratedDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* Effect.result(
          sql`INSERT INTO attachments (id, name, mime_type, size_bytes, sha256, created_at, actor)
              VALUES ('a', 'notes.pdf', 'application/pdf', 10, 'hash', 'now', 'user')`,
        );
      }),
    );
    expect(outcome._tag).toBe("Failure");
  });

  it("refuses a reference to an input that does not exist", async () => {
    const outcome = await runOnMigratedDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO attachments (id, name, mime_type, size_bytes, sha256, created_at, actor)
                   VALUES ('a', 'shot.png', 'image/png', 10, 'hash', 'now', 'user')`;
        return yield* Effect.result(
          sql`INSERT INTO session_input_attachments (input_id, attachment_id, position)
              VALUES ('missing', 'a', 0)`,
        );
      }),
    );
    expect(outcome._tag).toBe("Failure");
  });
});
