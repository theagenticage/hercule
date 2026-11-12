/**
 * Tests the backfill of `task_entity_links.taken_on`: only a link the user
 * wrote with the creation of its Task, with an entry that names no run,
 * signal, event or merged Task, is marked as taken on. The upgrade test in
 * `e2e/` owns the migration of data written by a real binary.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 121);
const UP_TO_TAKEN_ON = migrations.filter(([id]) => id <= 121);

const buildTestId = (name: string): Uint8Array => {
  const bytes = new Uint8Array(16);
  new TextEncoder().encodeInto(name, bytes);
  return bytes;
};

const at = (minute: number): string => `2026-11-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

interface Case {
  readonly name: string;
  readonly actor: string;
  readonly runId?: boolean;
  /** The link was written after the Task was created. */
  readonly later?: boolean;
  readonly takenOn: number;
}

const CASES: ReadonlyArray<Case> = [
  { name: "linked-later", actor: "user", later: true, takenOn: 0 },
  { name: "took-on", actor: "user", takenOn: 1 },
  { name: "handed-off", actor: "user", runId: true, takenOn: 0 },
  { name: "by-session", actor: "session:abc", takenOn: 0 },
];

describe("the link taken-on migration", () => {
  it("marks only the links the user made by taking the thing on", async () => {
    const found = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        for (const { name, actor, runId, later } of CASES) {
          yield* sql`INSERT INTO tasks (id, title, description, status, stage, priority, labels,
                                        created_at, updated_at, status_changed_at, stage_changed_at,
                                        board_rank)
                     VALUES (${buildTestId(name)}, ${name}, '', 'open', 'planned', 'normal', '[]',
                             ${at(0)}, ${at(0)}, ${at(0)}, ${at(0)}, 'a')`;
          const when = at(later === true ? 5 : 0);
          yield* sql`INSERT INTO task_provenance (id, task_id, ref, run_id, at, actor)
                     VALUES (${buildTestId(`entry-${name}`)}, ${buildTestId(name)}, ${`ref:${name}`},
                             ${runId === true ? buildTestId("run") : null}, ${when}, ${actor})`;
          yield* sql`INSERT INTO task_entity_links (task_id, ref, linked_at, linked_by, following)
                     VALUES (${buildTestId(name)}, ${`ref:${name}`}, ${when}, ${actor}, 0)`;
        }
        yield* runMigrations(UP_TO_TAKEN_ON);
        return yield* sql<{ readonly ref: string; readonly taken_on: number }>`
          SELECT ref, taken_on FROM task_entity_links ORDER BY ref`;
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(found.map((row) => [row.ref, row.taken_on])).toEqual([
      ["ref:by-session", 0],
      ["ref:handed-off", 0],
      ["ref:linked-later", 0],
      ["ref:took-on", 1],
    ]);
  });
});
