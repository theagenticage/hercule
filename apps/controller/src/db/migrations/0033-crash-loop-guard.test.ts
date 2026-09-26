/**
 * Tests the backfill of the crash-loop guard's columns:
 *
 * - `turn_started_in_process` is 1 for a session whose current process has a
 *   `turn.started` in its stream, and 0 for a session whose only
 *   `turn.started` belongs to an earlier process, or that has none;
 * - `awaiting_new_input` is 1 for an exited session whose current process
 *   started no turn, and 0 for every other session.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 33);

const at = "2026-09-01T00:00:00.000Z";

/** A session whose current process started a turn. */
const TURNED = "0199a000-0000-7000-8000-0000000000e1";

/** A session whose only turn started in the process before its last resume. */
const RESUMED = "0199a000-0000-7000-8000-0000000000e2";

/** An exited session that never started a turn. */
const NEVER = "0199a000-0000-7000-8000-0000000000e3";

/** An idle session that has not started a turn yet. */
const IDLE = "0199a000-0000-7000-8000-0000000000e4";

/** Converts a canonical id to the hex the database stores it as, for `unhex`. */
const toHex = (id: string): string => id.replaceAll("-", "");

describe("the turn-started-in-process migration", () => {
  it("sets the flags from whether the current process's stream shows a turn started", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);

        const insertSession = (id: string, streamBase: number, status = "exited") =>
          sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                    requested_access_mode, access_mode, spec, title, status,
                                    created_at, last_activity_at, stream_base)
            VALUES (unhex(${toHex(id)}), x'00', x'00', x'00', 'auto', 'auto', '{}',
                    'a session', ${status}, ${at}, ${at}, ${streamBase})`;
        const insertRow = (id: string, position: number, seq: number, tag: string) =>
          sql`INSERT INTO session_stream (session_id, position, runner_seq, at, event)
            VALUES (unhex(${toHex(id)}), ${position}, ${seq}, ${at},
                    ${JSON.stringify({ _tag: tag })})`;

        yield* insertSession(TURNED, 2);
        yield* insertRow(TURNED, 1, 1, "session.started");
        yield* insertRow(TURNED, 2, 2, "turn.started");
        yield* insertRow(TURNED, 3, 3, "session.started");
        yield* insertRow(TURNED, 4, 4, "turn.started");

        yield* insertSession(RESUMED, 2);
        yield* insertRow(RESUMED, 1, 1, "session.started");
        yield* insertRow(RESUMED, 2, 2, "turn.started");
        yield* insertRow(RESUMED, 3, 3, "session.started");

        yield* insertSession(NEVER, 0);
        yield* insertRow(NEVER, 1, 1, "session.started");

        yield* insertSession(IDLE, 0, "idle");
        yield* insertRow(IDLE, 1, 1, "session.started");

        yield* runMigrations();

        return yield* sql<{ readonly id: string; readonly turned: number; readonly held: number }>`
          SELECT lower(hex(id)) AS id, turn_started_in_process AS turned,
                 awaiting_new_input AS held
          FROM sessions ORDER BY id`;
      }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
    );

    expect(rows).toEqual([
      { id: toHex(TURNED), turned: 1, held: 0 },
      { id: toHex(RESUMED), turned: 0, held: 1 },
      { id: toHex(NEVER), turned: 0, held: 1 },
      { id: toHex(IDLE), turned: 0, held: 0 },
    ]);
  });
});
