/**
 * Tests what the subagents migration does to a database at the previous
 * head:
 *
 * - a session's one open Request becomes the only entry of its
 *   `open_requests` list, and a session parked on nothing gets an empty list;
 * - `open_request` is gone;
 * - every existing stream row belongs to the session's own agent;
 * - the subagent table and the two indexes exist, and deleting a session
 *   deletes its subagents.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 44);

const at = "2026-10-01T00:00:00.000Z";

/** The Request the parked session was waiting on, as an older build stored it. */
const REQUEST = {
  kind: "approval",
  requestId: "req_1",
  turnId: "turn_1",
  toolName: "Bash",
  detail: "rm -rf build",
  decisions: ["allow", "deny"],
};

const PARKED = new Uint8Array(16).fill(1);
const IDLE = new Uint8Array(16).fill(2);

interface Migrated {
  readonly openRequests: ReadonlyMap<number, unknown>;
  readonly sessionColumns: ReadonlyArray<string>;
  readonly streamAgents: ReadonlyArray<string | null>;
  readonly indexes: ReadonlyArray<string>;
  readonly subagentColumns: ReadonlyArray<string>;
  readonly subagentsAfterDelete: number;
  readonly notAList: string;
}

/**
 * Seeds two sessions, one parked on a Request and one parked on nothing,
 * each with one stream row, then runs the migration and reads back what it
 * left. Last, it adds a subagent to the parked session and deletes that
 * session, to show the subagent goes with it.
 */
const seedAndMigrate = (): Promise<Migrated> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations(BEFORE);
      yield* Effect.forEach(
        [
          { id: PARKED, openRequest: JSON.stringify(REQUEST) },
          { id: IDLE, openRequest: null },
        ],
        (session) =>
          Effect.andThen(
            sql`INSERT INTO sessions (id, permission_profile_id, instance_id, runner_id,
                                      requested_access_mode, access_mode, spec, title, status,
                                      created_at, last_activity_at, open_request)
                VALUES (${session.id}, x'00', x'00', x'00', 'auto', 'auto', '{}', 'a session',
                        'busy', ${at}, ${at}, ${session.openRequest})`,
            sql`INSERT INTO session_stream (session_id, position, runner_seq, at, event)
                VALUES (${session.id}, 1, 1, ${at}, '{"type":"turn.started"}')`,
          ),
        { discard: true },
      );
      yield* runMigrations();

      const sessions = yield* sql<{
        readonly id: Uint8Array;
        readonly open_requests: string;
      }>`SELECT id, open_requests FROM sessions`;
      const sessionColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('sessions')`;
      const stream = yield* sql<{ readonly subagent_id: string | null }>`
        SELECT subagent_id FROM session_stream ORDER BY session_id`;
      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name IN ('session_stream_agent', 'session_subagents_started')
        ORDER BY name`;
      const subagentColumns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info('session_subagents')`;
      const notAList = yield* Effect.flip(
        sql`UPDATE sessions SET open_requests = '{}' WHERE id = ${IDLE}`,
      );

      yield* sql`
        INSERT INTO session_subagents (session_id, subagent_id, status, started_at)
        VALUES (${PARKED}, 'agent-a', 'running', ${at})`;
      yield* sql`DELETE FROM sessions WHERE id = ${PARKED}`;
      const [left] = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM session_subagents`;

      return {
        openRequests: new Map(
          sessions.map((row) => [row.id[0]!, JSON.parse(row.open_requests) as unknown]),
        ),
        sessionColumns: sessionColumns.map((column) => column.name),
        streamAgents: stream.map((row) => row.subagent_id),
        indexes: indexes.map((index) => index.name),
        subagentColumns: subagentColumns.map((column) => column.name),
        subagentsAfterDelete: left!.count,
        notAList: String(notAList.cause.cause),
      };
    }).pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie),
  );

describe("the subagents migration", () => {
  it("moves a session's open Request into its list, and gives a session parked on nothing an empty one", async () => {
    const migrated = await seedAndMigrate();

    expect(migrated.openRequests.get(1)).toEqual([REQUEST]);
    expect(migrated.openRequests.get(2)).toEqual([]);
    expect(migrated.notAList).toContain("CHECK constraint failed");
  });

  it("drops open_request and adds the session's Token Usage columns", async () => {
    const { sessionColumns } = await seedAndMigrate();

    expect(sessionColumns).not.toContain("open_request");
    expect(sessionColumns).toEqual(
      expect.arrayContaining(["open_requests", "usage", "usage_process"]),
    );
  });

  it("leaves every existing stream row with the session's own agent", async () => {
    expect((await seedAndMigrate()).streamAgents).toEqual([null, null]);
  });

  it("creates the subagent table and its indexes, and a session's subagents go with it", async () => {
    const migrated = await seedAndMigrate();

    expect(migrated.indexes).toEqual(["session_stream_agent", "session_subagents_started"]);
    expect(migrated.subagentColumns).toEqual([
      "session_id",
      "subagent_id",
      "parent_subagent_id",
      "item_id",
      "description",
      "agent_type",
      "model",
      "status",
      "tool_calls",
      "activity",
      "result",
      "usage",
      "usage_process",
      "started_at",
      "ended_at",
    ]);
    expect(migrated.subagentsAfterDelete).toBe(0);
  });
});
