/**
 * Tests what the External Entities migration does to a database at the
 * previous head: the links it backfills from Task provenance, and the rules of
 * its tables (one entity per ref, one claim per claimant, rows that go with
 * their Connection). The upgrade test in `e2e/` owns the migration of data
 * written by a real binary.
 *
 * The tests of the backfill stop at this migration, so a later migration
 * cannot change what they check.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../migrate";
import { TestDatabaseWriter } from "../testing";
import { migrations } from "./index";

const BEFORE = migrations.filter(([id]) => id < 114);
const UP_TO_EXTERNAL_ENTITIES = migrations.filter(([id]) => id <= 114);

/** Builds the 16 bytes of a test id, so the id shows in the rows that are read back. */
const buildTestId = (name: string): Uint8Array => {
  const bytes = new Uint8Array(16);
  new TextEncoder().encodeInto(name, bytes);
  return bytes;
};

const decodeName = (bytes: Uint8Array): string =>
  new TextDecoder().decode(bytes).replaceAll("\0", "");

const at = (minute: number): string => `2026-11-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

const ISSUE = "github:issue:acme/api#7";
const OTHER_ISSUE = "github:issue:acme/api#8";

interface ProvenanceRow {
  readonly task: string;
  readonly ref: string | null;
  readonly minute: number;
  readonly actor: string;
  readonly signal?: boolean;
}

const TASKS = ["plain", "handed-off", "repeated", "no-ref", "deleted"] as const;

// The rows of `repeated` are written newest first, and two of its entries
// share a time, so the oldest entry is found by time and then by append order.
const PROVENANCE: ReadonlyArray<ProvenanceRow> = [
  { task: "plain", ref: ISSUE, minute: 1, actor: "user" },
  { task: "handed-off", ref: ISSUE, minute: 2, actor: "user", signal: true },
  { task: "repeated", ref: ISSUE, minute: 9, actor: "session:late" },
  { task: "repeated", ref: ISSUE, minute: 3, actor: "session:first" },
  { task: "repeated", ref: ISSUE, minute: 3, actor: "session:second" },
  { task: "repeated", ref: OTHER_ISSUE, minute: 4, actor: "user" },
  { task: "no-ref", ref: null, minute: 5, actor: "user" },
  { task: "deleted", ref: ISSUE, minute: 6, actor: "user" },
];

const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations(BEFORE);
  for (const name of TASKS) {
    yield* sql`INSERT INTO tasks (id, title, description, status, stage, priority, labels,
                                  created_at, updated_at, status_changed_at, stage_changed_at,
                                  board_rank, deleted_at)
               VALUES (${buildTestId(name)}, ${name}, '', 'open', 'planned', 'normal', '[]',
                       ${at(0)}, ${at(0)}, ${at(0)}, ${at(0)}, 'a',
                       ${name === "deleted" ? at(50) : null})`;
  }
  for (const [index, row] of PROVENANCE.entries()) {
    yield* sql`INSERT INTO task_provenance (id, task_id, ref, signal_id, at, actor)
               VALUES (${buildTestId(`entry-${String(index)}`)}, ${buildTestId(row.task)}, ${row.ref},
                       ${row.signal === true ? buildTestId("signal") : null}, ${at(row.minute)}, ${row.actor})`;
  }
  yield* runMigrations(UP_TO_EXTERNAL_ENTITIES);
  const links = yield* sql<{
    readonly task_id: Uint8Array;
    readonly ref: string;
    readonly linked_at: string;
    readonly linked_by: string;
    readonly following: number;
  }>`SELECT task_id, ref, linked_at, linked_by, following FROM task_entity_links
     ORDER BY task_id, ref`;
  return links.map((link) => ({ ...link, task: decodeName(link.task_id) }));
});

describe("the links the External Entities migration backfills", () => {
  it("links each Task to the refs its provenance names, from the oldest entry of each pair", async () => {
    const links = await Effect.runPromise(
      migrate.pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );

    expect(
      links.map(({ task, ref, linked_at, linked_by, following }) => ({
        task,
        ref,
        linked_at,
        linked_by,
        following,
      })),
    ).toEqual([
      { task: "handed-off", ref: ISSUE, linked_at: at(2), linked_by: "user", following: 0 },
      { task: "plain", ref: ISSUE, linked_at: at(1), linked_by: "user", following: 0 },
      { task: "repeated", ref: ISSUE, linked_at: at(3), linked_by: "session:first", following: 0 },
      { task: "repeated", ref: OTHER_ISSUE, linked_at: at(4), linked_by: "user", following: 0 },
    ]);
  });

  it("links no Task that is deleted, and no entry without a ref", async () => {
    const links = await Effect.runPromise(
      migrate.pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    const linkedTasks = new Set(links.map((link) => link.task));
    expect(linkedTasks.has("deleted")).toBe(false);
    expect(linkedTasks.has("no-ref")).toBe(false);
  });
});

const CONNECTION = buildTestId("connection");

/** Migrates an empty database to the newest head and writes a Connection. */
const migrateWithConnection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations(UP_TO_EXTERNAL_ENTITIES);
  yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id, status,
                                      labels, config, created_at, updated_at)
             VALUES (${CONNECTION}, 'github', 'github/github', 'work', 'octocat', '1', 'connected',
                     '[]', '{}', ${at(0)}, ${at(0)})`;
  return sql;
});

describe("the tables of External Entities", () => {
  it("keeps one entity per ref, and one claim per claimant of an edge", async () => {
    const refused = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* migrateWithConnection;
        const insertEntity = (id: string) =>
          sql`INSERT INTO external_entities (id, ref, kind, noun, completeness, title,
                                             first_observed_at, updated_at)
              VALUES (${buildTestId(id)}, ${ISSUE}, 'github/issue', 'Issue', 'partial', 'A title',
                      ${at(1)}, ${at(1)})`;
        const insertClaim = (type: "source" | "person", claimant: string, evidence = "") =>
          sql`INSERT INTO external_entity_relation_claims
                (from_ref, relation, to_ref, claim_type, connection_id, actor, evidence_key,
                 state, observed_at)
              VALUES (${ISSUE}, 'part-of', 'github:repo:acme/api', ${type},
                      ${type === "source" ? CONNECTION : null}, ${type === "person" ? claimant : null},
                      ${evidence}, 'current', ${at(1)})`;
        yield* insertEntity("first");
        yield* insertClaim("source", "");
        yield* insertClaim("person", "user");
        const results = {
          secondEntity: yield* Effect.exit(insertEntity("second")),
          repeatedSourceClaim: yield* Effect.exit(insertClaim("source", "")),
          repeatedPersonClaim: yield* Effect.exit(insertClaim("person", "user")),
          anotherPerson: yield* Effect.exit(insertClaim("person", "session:other")),
        };
        return Object.fromEntries(
          Object.entries(results).map(([name, exit]) => [name, exit._tag === "Failure"]),
        );
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(refused).toEqual({
      secondEntity: true,
      repeatedSourceClaim: true,
      repeatedPersonClaim: true,
      anotherPerson: false,
    });
  });

  it("starts the arrival counter at zero, with the one row it may have", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* migrateWithConnection;
        const seeded = yield* sql`SELECT id, last FROM external_entity_arrival_counter`;
        const second = yield* Effect.exit(
          sql`INSERT INTO external_entity_arrival_counter (id, last) VALUES (2, 0)`,
        );
        return { seeded, secondRefused: second._tag === "Failure" };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(rows).toEqual({ seeded: [{ id: 1, last: 0 }], secondRefused: true });
  });

  it("deletes a Connection's observations, scans and claims with it, and clears presented_by", async () => {
    const after = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* migrateWithConnection;
        yield* sql`INSERT INTO external_entities (id, ref, kind, noun, completeness, title,
                                                  first_observed_at, updated_at, presented_by)
                   VALUES (${buildTestId("entity")}, ${ISSUE}, 'github/issue', 'Issue', 'full',
                           'A title', ${at(1)}, ${at(1)}, ${CONNECTION})`;
        yield* sql`INSERT INTO external_entity_observations (ref, connection_id) VALUES (${ISSUE}, ${CONNECTION})`;
        yield* sql`INSERT INTO external_entity_scans (connection_id, kind, last_complete_at, actor)
                   VALUES (${CONNECTION}, 'github/issue', ${at(1)}, 'plugin:github')`;
        yield* sql`INSERT INTO external_entity_relation_claims
                     (from_ref, relation, to_ref, claim_type, connection_id, evidence_key, state, observed_at)
                   VALUES (${ISSUE}, 'part-of', 'github:repo:acme/api', 'source', ${CONNECTION}, '',
                           'current', ${at(1)})`;
        yield* sql`DELETE FROM connections WHERE id = ${CONNECTION}`;
        return {
          entities: yield* sql<{
            readonly presented_by: Uint8Array | null;
          }>`SELECT presented_by FROM external_entities`,
          observations: yield* sql`SELECT * FROM external_entity_observations`,
          scans: yield* sql`SELECT * FROM external_entity_scans`,
          claims: yield* sql`SELECT * FROM external_entity_relation_claims`,
        };
      }).pipe(Effect.provide(TestDatabaseWriter), Effect.orDie),
    );
    expect(after.entities).toEqual([{ presented_by: null }]);
    expect(after.observations).toEqual([]);
    expect(after.scans).toEqual([]);
    expect(after.claims).toEqual([]);
  });
});
