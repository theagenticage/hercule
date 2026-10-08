/**
 * Tests what the migration that stops exits from counting as activity does
 * to the sessions written before it: an exited session gets back the time of
 * its last real event.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 56);

const created = "2026-10-08T10:00:00.000Z";
const lastTurn = "2026-10-08T11:00:00.000Z";
const exitByRunner = "2026-10-08T20:40:00.000Z";
const strayEvent = "2026-10-08T20:41:00.000Z";
/** When the controller stored the exit: later than every runner time above. */
const exitedAt = "2026-10-08T20:42:00.000Z";

/** One stream row to insert: the session, its position, the runner's time and the event's tag. */
type Row = readonly [string, number, string, string];

/** Runs a test against a fresh in-memory database. */
const runOnDatabase = <A>(test: Effect.Effect<A, unknown, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(test.pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie));

/**
 * Writes `sessions` (their id, status, exit time and last activity, as the
 * old code stamped them) and their stream `rows`, runs migration 56, and
 * returns every session's id with its last activity, ordered by id.
 */
const migrate = (
  sessions: ReadonlyArray<readonly [string, string, string | null, string]>,
  rows: ReadonlyArray<Row>,
): Promise<ReadonlyArray<{ id: string; last_activity_at: string }>> =>
  runOnDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(BEFORE);
      for (const [id, status, exited, lastActivity] of sessions) {
        yield* sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                         requested_access_mode, access_mode, spec, title, status,
                                         created_at, last_activity_at, exited_at)
          VALUES (${id}, 'profile', 'instance', 'runner', 'auto', 'auto', '{}', 'a', ${status},
                  ${created}, ${lastActivity}, ${exited})`;
      }
      for (const [sessionId, position, at, tag] of rows) {
        yield* sql`INSERT INTO session_stream (session_id, position, runner_seq, at, event)
          VALUES (${sessionId}, ${position}, ${position}, ${at}, ${JSON.stringify({ _tag: tag })})`;
      }
      yield* runMigrations();
      return yield* sql<{ id: string; last_activity_at: string }>`
        SELECT id, last_activity_at FROM sessions ORDER BY id`;
    }),
  );

describe("the exit-is-not-activity migration", () => {
  it("restores the time of the last event stored before the exit row, and ignores what is stored after it", async () => {
    // The stray event's runner time (20:41) is earlier than the controller's
    // exit time (20:42), so only the stored order tells it is stray.
    const sessions = await migrate(
      [["exited", "exited", exitedAt, exitedAt]],
      [
        ["exited", 1, created, "session.started"],
        ["exited", 2, lastTurn, "turn.completed"],
        ["exited", 3, exitByRunner, "session.exited"],
        ["exited", 4, strayEvent, "session.usage.updated"],
      ],
    );

    expect(sessions).toEqual([{ id: "exited", last_activity_at: lastTurn }]);
  });

  it("keeps real activity whose runner time is later than the controller's exit time", async () => {
    const aheadOfController = "2026-10-08T20:43:00.000Z";
    const sessions = await migrate(
      [["fast-runner-clock", "exited", exitedAt, exitedAt]],
      [
        ["fast-runner-clock", 1, created, "session.started"],
        ["fast-runner-clock", 2, aheadOfController, "turn.completed"],
        ["fast-runner-clock", 3, aheadOfController, "session.exited"],
      ],
    );

    expect(sessions).toEqual([{ id: "fast-runner-clock", last_activity_at: aheadOfController }]);
  });

  it("falls back to the exit time when the controller ended the session and wrote no exit row", async () => {
    const afterExit = "2026-10-08T20:50:00.000Z";
    const sessions = await migrate(
      [["controller-ended", "exited", exitedAt, exitedAt]],
      [
        ["controller-ended", 1, created, "session.started"],
        ["controller-ended", 2, lastTurn, "turn.completed"],
        // A stray event: its time is later than the exit by any clock.
        ["controller-ended", 3, afterExit, "session.usage.updated"],
      ],
    );

    expect(sessions).toEqual([{ id: "controller-ended", last_activity_at: lastTurn }]);
  });

  it("uses the last life when a session that exited was resumed and then ended without an exit row", async () => {
    const secondLife = "2026-10-08T15:00:00.000Z";
    const sessions = await migrate(
      [["resumed", "exited", exitedAt, exitedAt]],
      [
        ["resumed", 1, created, "session.started"],
        ["resumed", 2, lastTurn, "turn.completed"],
        ["resumed", 3, "2026-10-08T11:05:00.000Z", "session.exited"],
        ["resumed", 4, "2026-10-08T14:00:00.000Z", "session.started"],
        ["resumed", 5, secondLife, "turn.completed"],
      ],
    );

    // The first life's exit row is not the final exit, so it must not cut off
    // the second life's work.
    expect(sessions).toEqual([{ id: "resumed", last_activity_at: secondLife }]);
  });

  it("leaves a session with no event that counts, and a session that has not exited, alone", async () => {
    const sessions = await migrate(
      [
        ["idle", "idle", null, lastTurn],
        ["never-ran", "exited", exitedAt, exitedAt],
      ],
      [
        ["idle", 1, lastTurn, "turn.completed"],
        ["never-ran", 1, exitByRunner, "session.exited"],
      ],
    );

    expect(sessions).toEqual([
      { id: "idle", last_activity_at: lastTurn },
      { id: "never-ran", last_activity_at: exitedAt },
    ]);
  });
});
