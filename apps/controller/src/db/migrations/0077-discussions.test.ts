/**
 * Tests what the Discussions migration does to the session inputs of a
 * database at the previous head. The migration rebuilds `session_inputs` and
 * `session_input_attachments`, so the tests check that:
 *
 * - every input and every attachment link keeps all its fields;
 * - both tables keep their columns and their indexes, and only
 *   `discussion_mentions` and the index on unsent Discussion Inputs are
 *   added;
 * - the attachment links still reference `session_inputs`, and no reference
 *   is broken;
 * - the source check accepts `discussion` only with `discussion_mentions`
 *   set, and refuses mentions on any other source;
 * - a session holds at most one unsent Discussion Input.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { MEMORY, openDatabase } from "../client";
import { runMigrations } from "../migrate";
import { migrations } from "./index";

/** The migrations before the one under test. */
const BEFORE = migrations.filter(([id]) => id < 77);

/**
 * The migrations up to and including the one under test. A later migration
 * may change the same tables, so the tests stop here.
 */
const THROUGH = migrations.filter(([id]) => id <= 77);

const at = "2026-10-14T00:00:00.000Z";

const REBUILT_TABLES = ["session_inputs", "session_input_attachments"] as const;

/** An index of a table, as `sqlite_schema` stores it: its name and its `CREATE INDEX` statement. */
interface StoredIndex {
  readonly name: string;
  readonly sql: string;
}

/**
 * Returns the index with every run of whitespace in its statement made one
 * space, so that two migrations that wrote the same index with different
 * line breaks or indentation compare equal.
 */
const normalizeIndex = (index: StoredIndex): StoredIndex => ({
  name: index.name,
  sql: index.sql.replace(/\s+/g, " ").trim(),
});

/** Runs a test against a fresh in-memory database. */
const runOnDatabase = <A>(test: Effect.Effect<A, unknown, SqlClient.SqlClient>): Promise<A> =>
  Effect.runPromise(test.pipe(Effect.provide(openDatabase(MEMORY)), Effect.orDie));

/**
 * Inserts three inputs written the way the previous head wrote them: a
 * delivered user input with an attached image, a queued one, and one a
 * subscription match created.
 */
const insertPreviousInputs = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO attachments (id, name, mime_type, size_bytes, sha256, created_at, actor)
    VALUES ('image', 'shot.png', 'image/png', 12, 'abc', ${at}, 'user')`;
  yield* sql`INSERT INTO session_inputs
      (id, session_id, source, actor, text, status, delivery, created_at, delivered_at,
       sent_at, reason, subscription_id, event_id, step_iteration)
    VALUES
      ('delivered input', 's', 'user', 'user', 'look', 'delivered', 'steered', ${at}, ${at},
       ${at}, NULL, NULL, NULL, NULL),
      ('queued input', 's', 'user', 'run', 'go', 'queued', NULL, ${at}, NULL,
       NULL, 'the harness is not ready', NULL, NULL, 2),
      ('matched input', 's', 'subscription', 'user', 'hi', 'cancelled', NULL, ${at}, NULL,
       NULL, 'the controller restarted', 'sub', 7, NULL)`;
  yield* sql`INSERT INTO session_input_attachments (input_id, attachment_id, position)
    VALUES ('delivered input', 'image', 0)`;
});

describe("the Discussions migration", () => {
  it("keeps every input and every attachment link exactly as it was", async () => {
    const { before, after } = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const readRows = Effect.all({
          inputs: sql`SELECT id, session_id, source, actor, text, status, delivery, created_at,
                             delivered_at, sent_at, reason, subscription_id, event_id,
                             step_iteration
                      FROM session_inputs ORDER BY id`,
          links: sql`SELECT input_id, attachment_id, position FROM session_input_attachments`,
        });
        yield* runMigrations(BEFORE);
        yield* insertPreviousInputs;
        const before = yield* readRows;
        yield* runMigrations(THROUGH);
        const after = yield* readRows;
        return { before, after };
      }),
    );

    expect(before.inputs).toHaveLength(3);
    expect(before.links).toHaveLength(1);
    expect(after).toEqual(before);
  });

  it("keeps the columns and the indexes of both tables, and adds only discussion_mentions and one index", async () => {
    const { before, after } = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const readShape = Effect.forEach(REBUILT_TABLES, (table) =>
          Effect.all({
            columns: sql`SELECT name, type, "notnull", dflt_value, pk
                         FROM pragma_table_info(${table})`,
            indexes: sql<StoredIndex>`
              SELECT name, sql FROM sqlite_schema
              WHERE type = 'index' AND tbl_name = ${table} AND sql IS NOT NULL
              ORDER BY name`.pipe(Effect.map((indexes) => indexes.map(normalizeIndex))),
          }),
        );
        yield* runMigrations(BEFORE);
        const before = yield* readShape;
        yield* runMigrations(THROUGH);
        return { before, after: yield* readShape };
      }),
    );

    const [inputsBefore, linksBefore] = before;
    expect(inputsBefore?.indexes.map((index) => index.name)).toEqual([
      "session_inputs_awaiting",
      "session_inputs_event",
      "session_inputs_match",
      "session_inputs_session",
    ]);
    expect(linksBefore?.indexes.map((index) => index.name)).toEqual([
      "session_input_attachments_by_attachment",
    ]);
    // The whole statement is compared, not only the name, so an index the
    // migration made again without its UNIQUE or its WHERE fails the test.
    expect(after).toEqual([
      {
        columns: [
          ...(inputsBefore?.columns ?? []),
          { name: "discussion_mentions", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
        ],
        indexes: [
          ...(inputsBefore?.indexes ?? []),
          {
            name: "session_inputs_unsent_discussion",
            sql:
              "CREATE UNIQUE INDEX session_inputs_unsent_discussion ON session_inputs (session_id) " +
              "WHERE source = 'discussion' AND status = 'queued' AND sent_at IS NULL",
          },
        ],
      },
      linksBefore,
    ]);
  });

  it("leaves the attachment links referencing session_inputs, with no reference broken", async () => {
    const { references, broken } = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(BEFORE);
        yield* insertPreviousInputs;
        yield* runMigrations(THROUGH);
        return {
          references: yield* sql`SELECT "table", "from", "to"
                                 FROM pragma_foreign_key_list('session_input_attachments')
                                 ORDER BY "from"`,
          broken: yield* sql`PRAGMA foreign_key_check`,
        };
      }),
    );

    expect(references).toEqual([
      { table: "attachments", from: "attachment_id", to: "id" },
      { table: "session_inputs", from: "input_id", to: "id" },
    ]);
    expect(broken).toEqual([]);
  });

  it("accepts a discussion input only with its mentions, and mentions on no other source", async () => {
    const outcomes = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(THROUGH);
        const insertInput = (id: string, source: string, mentions: string | null) =>
          Effect.exit(sql`INSERT INTO session_inputs
              (id, session_id, source, actor, text, status, created_at, discussion_mentions)
            VALUES (${id}, 's', ${source}, 'system', 'read it', 'queued', ${at}, ${mentions})`).pipe(
            Effect.map((exit) => exit._tag),
          );
        return {
          discussionWithMentions: yield* insertInput("a", "discussion", "[]"),
          discussionWithout: yield* insertInput("b", "discussion", null),
          userWithMentions: yield* insertInput("c", "user", "[]"),
          userWithout: yield* insertInput("d", "user", null),
        };
      }),
    );

    expect(outcomes).toEqual({
      discussionWithMentions: "Success",
      discussionWithout: "Failure",
      userWithMentions: "Failure",
      userWithout: "Success",
    });
  });

  it("refuses a second unsent Discussion Input for one session, and only that", async () => {
    const outcomes = await runOnDatabase(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(THROUGH);
        const insertInput = (id: string, session: string, sentAt: string | null) =>
          Effect.exit(sql`INSERT INTO session_inputs
              (id, session_id, source, actor, text, status, created_at, sent_at,
               discussion_mentions)
            VALUES (${id}, ${session}, 'discussion', 'system', 'read it', 'queued', ${at},
                    ${sentAt}, '{}')`).pipe(Effect.map((exit) => exit._tag));
        return {
          first: yield* insertInput("a", "s", null),
          secondUnsent: yield* insertInput("b", "s", null),
          sent: yield* insertInput("c", "s", at),
          otherSession: yield* insertInput("d", "t", null),
        };
      }),
    );

    expect(outcomes).toEqual({
      first: "Success",
      secondUnsent: "Failure",
      sent: "Success",
      otherSession: "Success",
    });
  });
});
