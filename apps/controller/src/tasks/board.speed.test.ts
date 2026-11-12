/**
 * Times the Work board's reads and writes against a database arranged as
 * production arranges one, and prints the medians. Run it with
 * `pnpm test:speed`.
 *
 * It is opt-in, and not part of `pnpm test` or CI, because time depends on the
 * machine. The database is the test database every controller test uses: a
 * file in a temporary folder, in WAL mode, with a writer and a read-only
 * reader (ADR 0004, amendment of 2026-10-18), not SQLite's in-memory mode. It
 * is seeded with a migrated schema and no statistics, as a controller starts.
 * The seed is written in SQL, so seeding thousands of rows takes a moment.
 *
 * It times the real statements, through the real services, and prints for
 * each case the median and the 95th percentile of 25 runs after 5 warm-up
 * runs, the statements the call sends, and the bytes of the encoded reply:
 *
 * - `task.queryBoard` at 300 Tasks in 10 projects and at 1,000 Tasks. The
 *   Tasks are spread over the five board stages. Every second Task has a
 *   Thread, every fourth a working Thread, every eighth an open question, and
 *   every tenth a failed run;
 * - the same board with context grouping: each Task links a ticket that is
 *   part of one of 10 projects, each part of one of 2 teams;
 * - the same board with a summary on every card, for the bytes a summary adds;
 * - the board with 20 Initiatives and about 30 blocked cards, then again with
 *   3,000 Done Tasks on 150 closed Initiatives, and the bytes `blockedBy` adds;
 * - `task.readDetail`, the pane's read, on a busy card and on a Task with 50
 *   blockers and 50 Tasks blocked by it;
 * - `task.addBlocker` and `task.checkMerge` on a chain of 200 Tasks and on a
 *   hub Task with 100 blockers and 100 Tasks blocked by it;
 * - the query plans of the blocker and Initiative statements;
 * - the branch link step (`BranchLinks.linkEntitiesByBranch`) at 500
 *   workspaces, when nothing is left to link;
 * - what joining a spawned Thread to a Task adds inside the spawn's
 *   transaction, beside the spawn's own writes;
 * - migration 0111, which gives the open Threads their Tasks, on a large
 *   database. It runs once per database, so it has one time, not a median.
 *
 * What it guards is an order of magnitude: each ceiling is far above what the
 * call takes, and far below a call whose work follows the history in the
 * database rather than the cards on the board. The targets of spec 17
 * (§Work, the Cost table) are printed beside each number, and are not
 * asserted.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { TaskDetail, WorkBoard, type SessionRequest } from "@hercule/contract";
import {
  HOST_API,
  registerConnectionType,
  registerEventSource,
  type Plugin,
} from "@hercule/plugin-host";
import { CurrentActor } from "../actor";
import {
  BranchLinks,
  BranchLinksLayer,
  TaskBoardFactsLayer,
  TaskDetailFactsLayer,
  TaskServicePortsLayer,
} from "../daemon/tasks";
import { TaskTrackingRunsLayer } from "../daemon/runs";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { inTransaction, TestDatabaseWriter } from "../db/testing";
import { isCountingOnly, recordSpeedCount } from "../db/speed-counts.testing";
import { runMigrations } from "../db/migrate";
import { migrations } from "../db/migrations";
import { AuditLog, PlatformEventsLayer } from "../events";
import { externalEntityRepository, type ObservedEntity } from "../external-entities";
import { NotifierLayer } from "../notifications";
import { PluginHost } from "../plugins";
import { buildPluginStack, IDLE_FEEDS, IDLE_INGEST_OPEN } from "../plugins/testing";
import { inputRepository, sessionRepository } from "../sessions";
import { blockerRepository } from "./blockers";
import { TaskBoard, TaskBoardLayer } from "./board";
import { TaskDetails, TaskDetailsLayer } from "./detail";
import { TaskService, TaskServiceLayer } from "./index";
import { USER } from "./testing";

/** Set to "1" by `pnpm test:speed`. The counts check runs them too (see `isCountingOnly`). */
const SPEED_TESTS_ENABLED = process.env["RUN_SPEED_TESTS"] === "1" || isCountingOnly;

/** How often each call is timed after it has warmed up. */
const RUNS = isCountingOnly ? 1 : 25;
const WARM_UP_RUNS = isCountingOnly ? 0 : 5;

/**
 * The most time any timed call may take, in milliseconds. It is an order of
 * magnitude, not a target: the targets are printed beside the numbers.
 */
const CEILING_MS = isCountingOnly ? Infinity : 250;

const AT = "2026-11-01T10:00:00.000Z";
const TURN_ENDED = "2026-11-01T12:00:00.000Z";

/**
 * The parts of the ids the seed writes. An id is a version 7 UUID that holds
 * the number of the row and the kind of row, so the test can name any row it
 * wrote without reading it back.
 */
const KIND = {
  task: "8000",
  session: "8001",
  run: "8002",
  initiative: "8003",
  project: "8004",
  workspace: "8005",
  checkout: "8006",
  runner: "8007",
} as const;

/** SQL for the 16 bytes of the id of row `i` of a kind. */
const sqlId = (kind: keyof typeof KIND, i = "i"): string =>
  `unhex(printf('%08x00007000${KIND[kind]}%012x', ${i}, 0))`;

/** Returns the id of row `i` of a kind, as the API spells it. */
const idOf = (kind: keyof typeof KIND, i: number): string =>
  `${i.toString(16).padStart(8, "0")}-0000-7000-${KIND[kind]}-000000000000`;

/** SQL for the numbers from `first` to `last`, as the rows of `n(i)`. */
const numbers = (first: number, last: number): string =>
  `WITH RECURSIVE n(i) AS (SELECT ${String(first)} UNION ALL SELECT i + 1 FROM n WHERE i < ${String(last)})`;

/** SQL for the board stage of Task `i`: the five stages in turn. */
const STAGE_OF_I =
  "CASE i % 5 WHEN 0 THEN 'exploring' WHEN 1 THEN 'planned' WHEN 2 THEN 'building' " +
  "WHEN 3 THEN 'in-review' ELSE 'landed' END";

const QUESTION: ReadonlyArray<SessionRequest> = [
  {
    requestId: "q1",
    itemId: "item-q1",
    kind: "question",
    detail: {
      questions: [
        {
          question: "Should the refund window be 14 or 30 days for gift cards?",
          header: "Refund",
          options: [],
          multiSelect: false,
        },
      ],
    },
  },
];

/** What a case writes besides its board Tasks. */
interface BoardSeed {
  /** Tasks on the board, numbered from 1. */
  readonly tasks: number;
  /** Open Initiatives. Two of every three Tasks are on one of them. */
  readonly openInitiatives?: number;
  /** Closed Initiatives, each holding `doneTasks / closedInitiatives` Tasks at `done`. */
  readonly closedInitiatives?: number;
  /** Tasks at `done`, numbered after the board Tasks, all on the closed Initiatives. */
  readonly doneTasks?: number;
  /** Makes every tenth Task (`i % 10 = 3`) wait on the two Tasks after it. */
  readonly blocked?: boolean;
  /** Gives every board Task a written summary. */
  readonly summaries?: boolean;
}

/**
 * Writes a board in one transaction: 10 projects, `tasks` Tasks over the five
 * stages and the projects, their Threads, failed runs and summaries, the
 * Initiatives, the Done Tasks and the blocker edges that `seed` asks for.
 */
const writeBoard = (seed: BoardSeed) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { tasks, openInitiatives = 0, closedInitiatives = 0, doneTasks = 0 } = seed;
    yield* sql.unsafe(`
      ${numbers(1, 10)}
      INSERT INTO projects (id, name, created_at, updated_at)
      SELECT ${sqlId("project")}, 'Northwind Market ' || i, '${AT}', '${AT}' FROM n`);
    if (openInitiatives + closedInitiatives > 0) {
      yield* sql.unsafe(`
        ${numbers(1, openInitiatives + closedInitiatives)}
        INSERT INTO initiatives (id, name, intent, hue, closed_at, created_at, updated_at,
                                 created_by, updated_by)
        SELECT ${sqlId("initiative")}, 'Initiative ' || i, 'Make gift cards refundable', i % 12,
               CASE WHEN i > ${String(openInitiatives)} THEN '${AT}' END,
               '${AT}', '${AT}', 'user', 'user'
        FROM n`);
    }
    // A realistic title is about 50 characters. Two Tasks in three are on an open Initiative.
    yield* sql.unsafe(`
      ${numbers(1, tasks)}
      INSERT INTO tasks (id, title, description, status, stage, priority, labels, project_id,
                         initiative_id, created_at, updated_at, status_changed_at,
                         stage_changed_at, board_rank, failed_run_id)
      SELECT ${sqlId("task")}, 'Add a refund button to the gift card page, part ' || i, '',
             'open', ${STAGE_OF_I}, CASE WHEN i % 7 = 0 THEN 'high' ELSE 'normal' END, '[]',
             ${sqlId("project", "1 + i % 10")},
             CASE WHEN ${String(openInitiatives)} > 0 AND i % 3 <> 0
                  THEN ${sqlId("initiative", `1 + i % ${String(Math.max(openInitiatives, 1))}`)} END,
             '${AT}', '${AT}', '${AT}', '${AT}', printf('V%06d', i),
             CASE WHEN i % 10 = 0 THEN ${sqlId("run")} END
      FROM n`);
    if (doneTasks > 0) {
      yield* sql.unsafe(`
        ${numbers(tasks + 1, tasks + doneTasks)}
        INSERT INTO tasks (id, title, description, status, stage, priority, labels, project_id,
                           initiative_id, created_at, updated_at, status_changed_at,
                           stage_changed_at, board_rank)
        SELECT ${sqlId("task")}, 'Shipped work, part ' || i, '', 'done', 'done', 'normal', '[]',
               ${sqlId("project", "1 + i % 10")},
               ${sqlId("initiative", `${String(openInitiatives + 1)} + i % ${String(Math.max(closedInitiatives, 1))}`)},
               '${AT}', '${AT}', '${AT}', '${AT}', printf('V%06d', i)
        FROM n`);
    }
    // Every second Task has a Thread: every fourth is busy, every eighth asks a question.
    yield* sql`
      ${sql.literal(numbers(1, tasks))}
      INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id,
                            requested_access_mode, access_mode, spec, title, status, created_at,
                            last_activity_at, task_id, open_requests, last_turn_ended_at,
                            harness_id)
      SELECT ${sql.literal(sqlId("session"))}, randomblob(16), randomblob(16), randomblob(16),
             'approval-required', 'approval-required', '{}', 'Look into the refund button',
             CASE WHEN i % 4 = 0 THEN 'busy' ELSE 'idle' END, ${AT}, ${AT},
             ${sql.literal(sqlId("task"))},
             CASE WHEN i % 8 = 0 THEN ${JSON.stringify(QUESTION)} ELSE '[]' END,
             ${TURN_ENDED}, 'test/test'
      FROM n WHERE i % 2 = 0`;
    // Every tenth Task shows a failed run.
    yield* sql.unsafe(`
      ${numbers(1, tasks)}
      INSERT INTO runs (id, plan, inputs, origin, task_id, status, failure_reason, failed_step_id,
                        created_at, started_at, finished_at)
      SELECT ${sqlId("run")}, '{"name":"Review pull request","steps":[]}', '{}',
             '{"kind":"manual","actor":"user"}', ${sqlId("task")}, 'failed', 'step-failed', 'work',
             '${AT}', '${AT}', '${TURN_ENDED}'
      FROM n WHERE i % 10 = 0`);
    if (seed.blocked === true) {
      yield* sql.unsafe(`
        ${numbers(1, tasks - 2)}
        INSERT INTO task_blockers (task_id, blocked_by_task_id, created_at, created_by)
        SELECT ${sqlId("task")}, ${sqlId("task", "i + 1")}, '${AT}', 'user' FROM n WHERE i % 10 = 3
        UNION ALL
        SELECT ${sqlId("task")}, ${sqlId("task", "i + 2")}, '${AT}', 'user' FROM n WHERE i % 10 = 3`);
    }
    if (seed.summaries === true) {
      // A summary as the writer leaves one: a six-word line, two sentences of standing, one of what is left.
      yield* sql`
        ${sql.literal(numbers(1, tasks))}
        INSERT INTO task_summaries (task_id, line, standing_text, left_text, input_revision,
                                    generated_at, dirty_revision, attempt_count)
        SELECT ${sql.literal(sqlId("task"))}, 'Refund button waits on review',
               ${"The refund button is on the gift card page and its tests pass. " + "The pull request is open and waits for a review from the payments team."},
               ${"Answer the review, then merge and watch the first refunds."}, 1, ${AT}, 1, 0
        FROM n`;
    }
  }).pipe(inTransaction);

/** A statement as it was sent: its SQL and its parameters. */
type SentStatement = readonly [string, ReadonlyArray<unknown>];

/** Runs `effect` and returns its value with every statement it sent, in order. */
const traceStatements = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const statements: Array<SentStatement> = [];
    const value = yield* effect.pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) =>
        Effect.sync(() => {
          statements.push(statement.compile());
          return statement;
        }),
      ),
    );
    return { value, statements };
  });

/** The median and the 95th percentile of the timed runs, in milliseconds. */
interface Timing {
  readonly median: number;
  readonly p95: number;
}

/** Times `call` `RUNS` times after `WARM_UP_RUNS` and returns the median and the 95th percentile. */
const measure = <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<Timing, E, R> =>
  Effect.gen(function* () {
    const times: Array<number> = [];
    for (let run = 0; run < WARM_UP_RUNS + RUNS; run++) {
      const started = performance.now();
      yield* call;
      if (run >= WARM_UP_RUNS) times.push(performance.now() - started);
    }
    const sorted = times.toSorted((a, b) => a - b);
    return {
      median: sorted[Math.floor(sorted.length / 2)]!,
      p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    };
  });

/** Returns the size of an encoded reply on the wire: its JSON, in UTF-8 bytes. */
const measureReplyBytes = (encoded: unknown): number => Buffer.byteLength(JSON.stringify(encoded));

/** Shortens a statement to its first words, on one line, to name it in the report. */
const nameStatement = (text: string): string => text.replaceAll(/\s+/g, " ").trim().slice(0, 110);

/**
 * Runs each statement again on its own, with its own parameters, and returns
 * the `top` slowest by median, so a slow read names the statement that makes
 * it slow.
 */
const findSlowestStatements = (statements: ReadonlyArray<SentStatement>, top = 3) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const timed: Array<{ readonly name: string; readonly median: number }> = [];
    for (const [text, params] of statements) {
      const { median } = yield* measure(sql.unsafe(text, params));
      timed.push({ name: nameStatement(text), median });
    }
    return timed.toSorted((a, b) => b.median - a.median).slice(0, top);
  });

/** Returns the query plan of a statement, one line for each step. */
const explain = ([text, params]: SentStatement) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // On the read-only connection: explaining a write prepares it and runs nothing.
    const rows = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${text}`,
      params,
    );
    return rows.map((row) => row.detail);
  });

/** One line of the report. */
interface ReportRow {
  readonly name: string;
  readonly timing?: Timing;
  readonly statements?: number;
  readonly bytes?: number;
  readonly cards?: number;
  readonly target: string;
  readonly within: string;
}

const report: Array<ReportRow> = [];
const notes: Array<string> = [];

/** Formats a number of milliseconds for the report. */
const formatMs = (ms: number | undefined) => (ms === undefined ? "-" : `${ms.toFixed(2)} ms`);

afterAll(() => {
  if (report.length === 0) return;
  for (const row of report) {
    if (row.statements !== undefined)
      recordSpeedCount(`board/${row.name.trim()}/statements`, row.statements);
    if (row.bytes !== undefined) recordSpeedCount(`board/${row.name.trim()}/bytes`, row.bytes);
  }
  const header = ["case", "median", "p95", "stmts", "bytes", "B/card", "target", "within"];
  const rows = report.map((row) => [
    row.name,
    formatMs(row.timing?.median),
    formatMs(row.timing?.p95),
    row.statements === undefined ? "-" : String(row.statements),
    row.bytes === undefined ? "-" : row.bytes.toLocaleString("en"),
    row.bytes === undefined || row.cards === undefined || row.cards === 0
      ? "-"
      : String(Math.round(row.bytes / row.cards)),
    row.target,
    row.within,
  ]);
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]!.length)),
  );
  const line = (cells: ReadonlyArray<string>) =>
    cells.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ");
  process.stderr.write(
    [
      "",
      `Work board, median and p95 of ${String(RUNS)} runs after ${String(WARM_UP_RUNS)} warm-up runs:`,
      line(header),
      widths.map((width) => "-".repeat(width)).join("-|-"),
      ...rows.map(line),
      "",
      ...notes,
      "",
    ].join("\n"),
  );
});

/** Says whether a measured value meets its target. */
const judge = (value: number, target: number) => (value < target ? "yes" : "NO");

/**
 * The read services and the Task service on one fresh database, with a real
 * plugin host, as `service.blockers.test.ts` builds them. Built for each case,
 * so each case has a database of its own.
 */
const buildLayer = () => {
  const reads = Layer.mergeAll(TaskBoardLayer, TaskDetailsLayer).pipe(
    Layer.provide(Layer.mergeAll(TaskBoardFactsLayer, TaskTrackingRunsLayer, TaskDetailFactsLayer)),
    Layer.provideMerge(buildPluginStack()),
  );
  const service = TaskServiceLayer.pipe(
    Layer.provideMerge(NotifierLayer),
    Layer.provideMerge(TaskServicePortsLayer),
    Layer.provideMerge(PlatformEventsLayer),
    Layer.provideMerge(reads),
  );
  return BranchLinksLayer.pipe(Layer.provideMerge(service));
};

/** Runs `effect` as the user on a fresh database. */
const runAsUser = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof buildLayer>>>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.provideService(CurrentActor, USER), Effect.provide(buildLayer())),
  );

/** What one read of the board costs. */
interface BoardCost {
  readonly timing: Timing;
  readonly statements: ReadonlyArray<SentStatement>;
  readonly board: WorkBoard;
  readonly bytes: number;
}

/** Reads the board once to count its statements and bytes, then times it. */
const measureBoard: Effect.Effect<
  BoardCost,
  unknown,
  TaskBoard | Layer.Success<ReturnType<typeof buildLayer>>
> = Effect.gen(function* () {
  const boardReader = yield* TaskBoard;
  const { value: board, statements } = yield* traceStatements(boardReader.query());
  const timing = yield* measure(boardReader.query());
  return {
    timing,
    statements,
    board,
    bytes: measureReplyBytes(Schema.encodeSync(WorkBoard)(board)),
  };
});

/**
 * Returns the bytes each field of a card takes in the encoded reply, averaged
 * over the cards and largest first, with its key, quotes and comma, as
 * `name 123`.
 */
const describeFieldBytes = (board: WorkBoard): string => {
  const { cards } = Schema.encodeSync(WorkBoard)(board);
  const totals = new Map<string, number>();
  for (const card of cards) {
    for (const [key, value] of Object.entries(card)) {
      const bytes = Buffer.byteLength(JSON.stringify({ [key]: value })) - 1;
      totals.set(key, (totals.get(key) ?? 0) + bytes);
    }
  }
  return [...totals]
    .toSorted(([, left], [, right]) => right - left)
    .map(([key, total]) => `${key} ${String(Math.round(total / cards.length))}`)
    .join(", ");
};

/** Writes a board and returns what reading it costs. */
const readSeededBoard = (seed: BoardSeed) =>
  runAsUser(
    Effect.gen(function* () {
      yield* writeBoard(seed);
      return yield* measureBoard;
    }),
  );

describe.runIf(SPEED_TESTS_ENABLED)("the board read", () => {
  it("at 300 and 1,000 Tasks, in a fixed number of statements", async () => {
    const small = await readSeededBoard({ tasks: 10 });
    const at300 = await readSeededBoard({ tasks: 300 });
    const at1000 = await readSeededBoard({ tasks: 1000 });
    const slowest = await runAsUser(
      Effect.gen(function* () {
        yield* writeBoard({ tasks: 1000 });
        const { statements } = yield* traceStatements(Effect.flatMap(TaskBoard, (b) => b.query()));
        return yield* findSlowestStatements(statements);
      }),
    );

    report.push(
      {
        name: "board, 10 Tasks",
        timing: small.timing,
        statements: small.statements.length,
        bytes: small.bytes,
        cards: 10,
        target: "-",
        within: "-",
      },
      {
        name: "board, 300 Tasks in 10 projects",
        timing: at300.timing,
        statements: at300.statements.length,
        bytes: at300.bytes,
        cards: 300,
        target: "<20 ms, fixed stmts, ~300 B/card",
        within: `${judge(at300.timing.median, 20)}, stmts ${at300.statements.length === small.statements.length ? "fixed" : "GROW"}, B/card ${String(Math.round(at300.bytes / 300))}`,
      },
      {
        name: "board, 1,000 Tasks",
        timing: at1000.timing,
        statements: at1000.statements.length,
        bytes: at1000.bytes,
        cards: 1000,
        target: "<60 ms",
        within: judge(at1000.timing.median, 60),
      },
    );
    notes.push(
      `Bytes of a card on the 300-Task board, by field, averaged: ${describeFieldBytes(at300.board)}.`,
      "Slowest statements of the board read at 1,000 Tasks, each run on its own:",
      ...slowest.map((row) => `  ${formatMs(row.median)}  ${row.name}`),
    );
    expect(at300.board.cards).toHaveLength(300);
    expect(at1000.board.cards).toHaveLength(1000);
    expect(at300.board.cards.filter((card) => card.failure !== undefined)).toHaveLength(30);
    expect(at300.board.cards.filter((card) => card.openQuestion !== undefined)).toHaveLength(37);
    expect(at300.statements).toHaveLength(small.statements.length);
    expect(at1000.timing.median).toBeLessThan(CEILING_MS);
  });

  it("with a summary on every card", async () => {
    const without = await readSeededBoard({ tasks: 300 });
    const withSummaries = await readSeededBoard({ tasks: 300, summaries: true });
    const added = (withSummaries.bytes - without.bytes) / 300;
    report.push({
      name: "board, 300 Tasks, every card with a summary",
      timing: withSummaries.timing,
      statements: withSummaries.statements.length,
      bytes: withSummaries.bytes,
      cards: 300,
      target: "+~300 B per summary card",
      within: `+${String(Math.round(added))} B/card, stmts ${withSummaries.statements.length === without.statements.length ? "same" : "differ"}`,
    });
    expect(withSummaries.board.cards.every((card) => card.summary !== undefined)).toBe(true);
    expect(withSummaries.timing.median).toBeLessThan(CEILING_MS);
  });

  it("with 20 Initiatives and about 30 blocked cards, then 3,000 Done Tasks on 150 closed Initiatives", async () => {
    const plain = await readSeededBoard({ tasks: 300 });
    const initiatives = await readSeededBoard({ tasks: 300, openInitiatives: 20, blocked: true });
    const history = await readSeededBoard({
      tasks: 300,
      openInitiatives: 20,
      blocked: true,
      closedInitiatives: 150,
      doneTasks: 3000,
    });
    const blockedCards = initiatives.board.cards.filter((card) => card.blockedByCount > 0).length;
    // The same reply with no blocker on any card, for the bytes `blockedBy` adds.
    const unblockedBytes = measureReplyBytes(
      Schema.encodeSync(WorkBoard)({
        ...initiatives.board,
        cards: initiatives.board.cards.map((card) => ({
          ...card,
          blockedBy: [],
          blockedByCount: 0,
        })),
      }),
    );
    const blockerStatements = initiatives.statements.filter(
      ([text]) => text.includes("task_blockers") || text.includes("tasks_initiative_done"),
    ).length;
    report.push(
      {
        name: "board, 300 Tasks, 20 Initiatives, blocked cards",
        timing: initiatives.timing,
        statements: initiatives.statements.length,
        bytes: initiatives.bytes,
        cards: 300,
        target: "<25 ms, +2 stmts",
        within: `${judge(initiatives.timing.median, 25)}, ${String(blockedCards)} blocked cards, ${String(blockerStatements)} of the stmts are the blockers and Done counts`,
      },
      {
        name: "  same + 3,000 Done Tasks on 150 closed Initiatives",
        timing: history.timing,
        statements: history.statements.length,
        bytes: history.bytes,
        cards: 300,
        target: "<25 ms",
        within: judge(history.timing.median, 25),
      },
    );
    notes.push(
      `blockedBy: the 300-card board is ${initiatives.bytes.toLocaleString("en")} B with the blockers ` +
        `and ${unblockedBytes.toLocaleString("en")} B with none, so the ${String(blockedCards)} blocked ` +
        `cards add ${String(initiatives.bytes - unblockedBytes)} B, ` +
        `${String(Math.round((initiatives.bytes - unblockedBytes) / Math.max(blockedCards, 1)))} B each. ` +
        `Without Initiatives or blockers the board is ${plain.bytes.toLocaleString("en")} B in ` +
        `${String(plain.statements.length)} statements; the blockers and Done counts statements are sent ` +
        "whether or not anything is blocked or on an Initiative.",
    );
    expect(initiatives.statements).toHaveLength(plain.statements.length);
    expect(history.statements).toHaveLength(plain.statements.length);
    expect(history.timing.median).toBeLessThan(CEILING_MS);
  });
});

const PLUGIN = "acme-tracker";
const CONNECTION = "0199e0e7-0010-7000-8000-000000000001";
const OBSERVED_AT = "2026-11-01T09:00:00.000Z";

/** An invented tracker plugin: one Connection type and one event source, so the host runs it. */
const trackerPlugin: Plugin = {
  manifest: {
    id: PLUGIN,
    displayName: "Acme tracker",
    hostApi: HOST_API,
    capabilities: ["connections", "event-sources", "events", "entities"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    Effect.andThen(
      registerConnectionType(host, {
        type: "account",
        displayName: "Account",
        setup: [],
        validate: () => Effect.succeed({ displayName: "a", accountId: "a" }),
      }),
      registerEventSource(host, {
        id: "tracker",
        connectionType: `${PLUGIN}/account`,
        feeds: IDLE_FEEDS,
        kinds: {
          [`${PLUGIN}.thing.done`]: {
            description: "Something was done.",
            schema: Schema.Struct({ title: Schema.String }),
            availableToTriage: true,
          },
        },
        open: IDLE_INGEST_OPEN,
      }),
    ),
  activate: () => Effect.succeed(Effect.void),
};

const ticketRef = (n: number) => `${PLUGIN}:ticket:t${String(n)}`;
const projectRef = (n: number) => `${PLUGIN}:project:p${String(n)}`;
const teamRef = (n: number) => `${PLUGIN}:team:${String(n)}`;

/** Builds the observation of a place that can group: a team or a project, with a caption. */
const place = (
  word: "team" | "project",
  ref: string,
  title: string,
  partOf: ReadonlyArray<string>,
): ObservedEntity => ({
  kind: `${PLUGIN}/${word}`,
  slots: {
    noun: word === "team" ? "Team" : "Project",
    pace: "context",
    caption: `Tracker ${word}`,
  },
  observation: {
    kind: word,
    ref,
    title,
    fields: {},
    concerns: [],
    sourceUpdatedAt: OBSERVED_AT,
    relations: { complete: true, partOf, linked: [] },
  },
  fieldRows: [],
});

/** Builds the observation of ticket `n`, part of one of 10 projects. */
const ticket = (n: number): ObservedEntity => ({
  kind: `${PLUGIN}/ticket`,
  slots: {
    noun: "Ticket",
    card: "compact",
    pace: "fast",
    patience: 24,
    identifier: `NW-${String(n)}`,
    facts: [],
  },
  observation: {
    kind: "ticket",
    ref: ticketRef(n),
    title: `Gift card refunds, part ${String(n)}`,
    url: `https://tracker.example/NW-${String(n)}`,
    lifecycle: "open",
    fields: {},
    concerns: ["assigned"],
    sourceUpdatedAt: OBSERVED_AT,
    relations: { complete: true, partOf: [projectRef(1 + (n % 10))], linked: [] },
  },
  fieldRows: [],
});

/**
 * Stores 2 teams, 10 projects each part of a team, and one ticket for each
 * of the `tasks` Tasks, part of a project, as one Connection read them, and
 * links Task `i` to ticket `i`.
 */
const writeContext = (tasks: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const entities = yield* externalEntityRepository;
    yield* Effect.flatMap(PluginHost, (host) => host.boot([trackerPlugin]));
    const reconcile = (kind: string, observed: ReadonlyArray<ObservedEntity>) =>
      entities.reconcile({
        connectionId: CONNECTION,
        kind,
        complete: true,
        observed,
        actor: `plugin:${PLUGIN}`,
        environment: { now: AT, activePluginIds: [PLUGIN] },
      });
    yield* inTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
            status, labels, config, created_at, updated_at)
          VALUES (${uuidFromString(CONNECTION)}, ${PLUGIN},
            ${`${PLUGIN}/account`}, 'a', 'a', 'a', 'connected', '[]', '{}', ${AT}, ${AT})`;
        yield* reconcile(`${PLUGIN}/team`, [
          place("team", teamRef(1), "Payments", []),
          place("team", teamRef(2), "Storefront", []),
        ]);
        yield* reconcile(
          `${PLUGIN}/project`,
          Array.from({ length: 10 }, (_, n) =>
            place("project", projectRef(n + 1), `Project ${String(n + 1)}`, [teamRef(1 + (n % 2))]),
          ),
        );
        yield* reconcile(
          `${PLUGIN}/ticket`,
          Array.from({ length: tasks }, (_, n) => ticket(n + 1)),
        );
        yield* sql.unsafe(`
          ${numbers(1, tasks)}
          INSERT INTO task_entity_links (task_id, ref, linked_at, linked_by, following)
          SELECT ${sqlId("task")}, '${PLUGIN}:ticket:t' || i, '${AT}', 'user', 0 FROM n`);
      }),
    );
  });

describe.runIf(SPEED_TESTS_ENABLED)("the board read with context grouping", () => {
  it("at 300 Tasks, each under a ticket, a project and a team", async () => {
    /** Writes a board of `tasks` linked Tasks and returns what reading it costs, and its slowest statements. */
    const readContextBoard = (tasks: number) =>
      runAsUser(
        Effect.gen(function* () {
          yield* writeBoard({ tasks });
          yield* writeContext(tasks);
          const cost = yield* measureBoard;
          return { ...cost, slowest: yield* findSlowestStatements(cost.statements) };
        }),
      );
    const small = await readContextBoard(10);
    const large = await readContextBoard(300);
    const recursive = large.statements.filter(([text]) => /WITH RECURSIVE/i.test(text)).length;
    report.push({
      name: "board, 300 Tasks, context grouping",
      timing: large.timing,
      statements: large.statements.length,
      bytes: large.bytes,
      cards: 300,
      target: "<20 ms, fixed stmts",
      within: `${judge(large.timing.median, 20)}, stmts ${large.statements.length === small.statements.length ? "fixed" : "GROW"} (${String(recursive)} recursive)`,
    });
    notes.push(
      `Context grouping at 300 Tasks: ${String(large.board.places.length)} places, ` +
        `${String(large.board.edges.length)} edges, groupings ${large.board.groupings.map((g) => g.kind).join(", ")}, ` +
        `contextComplete ${String(large.board.contextComplete)}. Slowest statements:`,
      ...large.slowest.map((row) => `  ${formatMs(row.median)}  ${row.name}`),
    );
    expect(large.board.cards.every((card) => card.contextRefs.length === 3)).toBe(true);
    expect(large.statements).toHaveLength(small.statements.length);
    expect(large.timing.median).toBeLessThan(CEILING_MS);
  });
});

/** The number of the first Task of the hub: the hub itself, then its blockers, then the Tasks it blocks. */
const HUB = 900_000;

/**
 * Writes a hub Task at `building` (Task `HUB`) that waits on `blockers` Tasks
 * and is waited on by `blocked` Tasks, all at `building`, numbered after it.
 */
const writeHub = (blockers: number, blocked: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`
      ${numbers(HUB, HUB + blockers + blocked)}
      INSERT INTO tasks (id, title, description, status, stage, priority, labels, created_at,
                         updated_at, status_changed_at, stage_changed_at, board_rank)
      SELECT ${sqlId("task")}, 'Hub work, part ' || i, '', 'open', 'building', 'normal', '[]',
             '${AT}', '${AT}', '${AT}', '${AT}', printf('W%06d', i)
      FROM n`);
    yield* sql.unsafe(`
      ${numbers(HUB + 1, HUB + blockers + blocked)}
      INSERT INTO task_blockers (task_id, blocked_by_task_id, created_at, created_by)
      SELECT CASE WHEN i <= ${String(HUB + blockers)} THEN ${sqlId("task", String(HUB))} ELSE ${sqlId("task")} END,
             CASE WHEN i <= ${String(HUB + blockers)} THEN ${sqlId("task")} ELSE ${sqlId("task", String(HUB))} END,
             strftime('%Y-%m-%dT%H:%M:%fZ', '${AT}', '+' || i || ' seconds'), 'user'
      FROM n`);
  }).pipe(inTransaction);

/** The number of the first Task of the chain. */
const CHAIN = 800_000;

/** Writes `length` Tasks at `building`, each waiting on the next. */
const writeChain = (length: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`
      ${numbers(CHAIN + 1, CHAIN + length)}
      INSERT INTO tasks (id, title, description, status, stage, priority, labels, created_at,
                         updated_at, status_changed_at, stage_changed_at, board_rank)
      SELECT ${sqlId("task")}, 'Chained work, part ' || i, '', 'open', 'building', 'normal', '[]',
             '${AT}', '${AT}', '${AT}', '${AT}', printf('X%06d', i)
      FROM n`);
    yield* sql.unsafe(`
      ${numbers(CHAIN + 1, CHAIN + length - 1)}
      INSERT INTO task_blockers (task_id, blocked_by_task_id, created_at, created_by)
      SELECT ${sqlId("task")}, ${sqlId("task", "i + 1")}, '${AT}', 'user' FROM n`);
  }).pipe(inTransaction);

/** Writes one Task at `building` that waits on nothing, numbered `n`. */
const writeLoneTask = (n: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`
      INSERT INTO tasks (id, title, description, status, stage, priority, labels, created_at,
                         updated_at, status_changed_at, stage_changed_at, board_rank)
      SELECT ${sqlId("task", String(n))}, 'Lone work', '', 'open', 'building', 'normal', '[]',
             '${AT}', '${AT}', '${AT}', '${AT}', 'Y'`);
  }).pipe(inTransaction);

describe.runIf(SPEED_TESTS_ENABLED)("the pane's read", () => {
  it("on a busy card of a 300-card board, and on a Task with 50 blockers and 50 blocked", async () => {
    const result = await runAsUser(
      Effect.gen(function* () {
        yield* writeBoard({ tasks: 300, openInitiatives: 20, blocked: true, summaries: true });
        yield* writeHub(50, 50);
        const details = yield* TaskDetails;
        // Task 40 has a busy Thread with an open question, a failed run and a summary.
        const busy = idOf("task", 40);
        const hub = idOf("task", HUB);
        const traced = yield* traceStatements(details.read(busy));
        const tracedHub = yield* traceStatements(details.read(hub));
        return {
          busy: {
            timing: yield* measure(details.read(busy)),
            statements: traced.statements.length,
            bytes: measureReplyBytes(Schema.encodeSync(TaskDetail)(traced.value)),
            detail: traced.value,
          },
          hub: {
            timing: yield* measure(details.read(hub)),
            statements: tracedHub.statements.length,
            bytes: measureReplyBytes(Schema.encodeSync(TaskDetail)(tracedHub.value)),
            detail: tracedHub.value,
          },
        };
      }),
    );
    report.push(
      {
        name: "task.readDetail, busy card",
        timing: result.busy.timing,
        statements: result.busy.statements,
        bytes: result.busy.bytes,
        target: "<15 ms",
        within: judge(result.busy.timing.median, 15),
      },
      {
        name: "task.readDetail, 50 blockers and 50 blocked",
        timing: result.hub.timing,
        statements: result.hub.statements,
        bytes: result.hub.bytes,
        target: "<15 ms",
        within: judge(result.hub.timing.median, 15),
      },
    );
    expect(result.busy.detail.card.openQuestion).toBeDefined();
    expect(result.busy.detail.card.failure).toBeDefined();
    expect([result.hub.detail.blockerCount, result.hub.detail.blockCount]).toEqual([50, 50]);
    expect(result.hub.timing.median).toBeLessThan(CEILING_MS);
  });
});

describe.runIf(SPEED_TESTS_ENABLED)("adding a blocker and checking a merge", () => {
  it("on a chain of 200 Tasks and on a hub of 100 blockers and 100 blocked", async () => {
    const result = await runAsUser(
      Effect.gen(function* () {
        yield* writeBoard({ tasks: 300 });
        yield* writeChain(200);
        yield* writeHub(100, 100);
        yield* writeLoneTask(700_001);
        yield* writeLoneTask(700_002);
        const tasks = yield* TaskService;
        const chainFirst = idOf("task", CHAIN + 1);
        const chainLast = idOf("task", CHAIN + 200);
        const firstBlocker = idOf("task", HUB + 1);
        const firstBlocked = idOf("task", HUB + 101);
        const secondBlocked = idOf("task", HUB + 102);
        /** Times a call and counts the statements of its first run. */
        const cost = <A, E, R>(call: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const traced = yield* traceStatements(call);
            return { timing: yield* measure(call), statements: traced.statements.length };
          });
        // The accepted edges are written by the first run; the timed runs find them there,
        // so they walk the loop check and write nothing.
        return {
          chainAccepted: yield* cost(tasks.addBlocker(idOf("task", 700_001), chainFirst)),
          chainRefused: yield* cost(Effect.flip(tasks.addBlocker(chainLast, chainFirst))),
          chainMergeRefused: yield* cost(tasks.checkMerge(chainFirst, chainLast)),
          hubAccepted: yield* cost(tasks.addBlocker(idOf("task", 700_002), firstBlocked)),
          hubRefused: yield* cost(Effect.flip(tasks.addBlocker(firstBlocker, firstBlocked))),
          hubMergeAccepted: yield* cost(tasks.checkMerge(firstBlocked, secondBlocked)),
          hubMergeRefused: yield* cost(tasks.checkMerge(firstBlocker, firstBlocked)),
          refusal: yield* tasks.checkMerge(chainFirst, chainLast),
        };
      }),
    );
    const rows: ReadonlyArray<readonly [string, { timing: Timing; statements: number }]> = [
      ["addBlocker, chain of 200, accepted (no-op repeat)", result.chainAccepted],
      ["addBlocker, chain of 200, refused loop", result.chainRefused],
      ["checkMerge, chain of 200, refused loop", result.chainMergeRefused],
      ["addBlocker, hub 100 x 100, accepted (no-op repeat)", result.hubAccepted],
      ["addBlocker, hub 100 x 100, refused loop", result.hubRefused],
      ["checkMerge, hub 100 x 100, accepted", result.hubMergeAccepted],
      ["checkMerge, hub 100 x 100, refused loop", result.hubMergeRefused],
    ];
    for (const [name, measured] of rows) {
      report.push({
        name,
        timing: measured.timing,
        statements: measured.statements,
        target: "none stated",
        within: "-",
      });
    }
    expect(result.refusal).toHaveProperty("refusal");
    expect(result.chainRefused.timing.median).toBeLessThan(CEILING_MS);
  });
});

describe.runIf(SPEED_TESTS_ENABLED)("the query plans of blockers and Initiatives", () => {
  it("search by index, on a board with 3,000 Done Tasks and a hub", async () => {
    const plans = await runAsUser(
      Effect.gen(function* () {
        yield* writeBoard({
          tasks: 300,
          openInitiatives: 20,
          blocked: true,
          closedInitiatives: 150,
          doneTasks: 3000,
        });
        yield* writeHub(100, 100);
        yield* writeChain(200);
        const tasks = yield* TaskService;
        const details = yield* TaskDetails;
        const blockers = yield* blockerRepository;
        const firstBlocked = idOf("task", HUB + 101);
        const board = yield* traceStatements(Effect.flatMap(TaskBoard, (b) => b.query()));
        const detail = yield* traceStatements(details.read(idOf("task", HUB)));
        const byInitiative = yield* traceStatements(
          tasks.query({ initiativeId: idOf("initiative", 1) }),
        );
        const loop = yield* traceStatements(
          Effect.flip(tasks.addBlocker(idOf("task", CHAIN + 200), idOf("task", CHAIN + 1))),
        );
        const moved = yield* traceStatements(
          inTransaction(blockers.moveEdges(firstBlocked, idOf("task", HUB + 102))),
        );
        const deleted = yield* traceStatements(
          inTransaction(blockers.deleteEdgesOf(idOf("task", HUB + 103))),
        );
        const removed = yield* traceStatements(
          tasks.removeBlocker(idOf("task", HUB + 104), idOf("task", HUB)),
        );
        const cleared = yield* traceStatements(tasks.clearInitiative(idOf("initiative", 2)));

        /** Returns the first statement of `statements` whose SQL matches `pattern`. */
        const pick = (statements: ReadonlyArray<SentStatement>, pattern: RegExp) => {
          const found = statements.find(([text]) => pattern.test(text));
          if (found === undefined) throw new Error(`no statement matches ${String(pattern)}`);
          return found;
        };
        const named: ReadonlyArray<readonly [string, SentStatement]> = [
          [
            "readCardBlockers",
            pick(board.statements, /WITH edges AS \(SELECT task_id[\s\S]*task_id IN/),
          ],
          ["countDoneTasksByInitiative", pick(board.statements, /tasks_initiative_done/)],
          [
            "clearInitiative update",
            pick(cleared.statements, /UPDATE tasks SET initiative_id = NULL/),
          ],
          ["task.query by initiativeId", pick(byInitiative.statements, /initiative_id = \?/)],
          ["findWaitPath (addBlocker loop check)", pick(loop.statements, /WITH RECURSIVE\s+reach/)],
          ["moveEdges delete", pick(moved.statements, /DELETE FROM task_blockers/)],
          ["moveEdges insert", pick(moved.statements, /INSERT INTO task_blockers/)],
          ["deleteEdgesOf", pick(deleted.statements, /DELETE FROM task_blockers/)],
          ["deleteEdge (removeBlocker)", pick(removed.statements, /DELETE FROM task_blockers/)],
          ["readDetailBlocking, blockers", pick(detail.statements, /WHERE e\.task_id = \?/)],
          [
            "readDetailBlocking, blocks",
            pick(detail.statements, /WHERE e\.blocked_by_task_id = \?/),
          ],
        ];
        const explained: Array<readonly [string, ReadonlyArray<string>]> = [];
        for (const [name, statement] of named) explained.push([name, yield* explain(statement)]);
        // Every other statement the board and the pane send, for any scan of a big table.
        const scans: Array<string> = [];
        for (const statement of [...board.statements, ...detail.statements]) {
          for (const step of yield* explain(statement)) {
            if (step.startsWith("SCAN ")) scans.push(`${step}   <- ${nameStatement(statement[0])}`);
          }
        }
        return { explained, scans: [...new Set(scans)] };
      }),
    );
    notes.push(
      "Query plans (300 board Tasks, 3,000 Done Tasks, 170 Initiatives, a hub and a chain):",
    );
    for (const [name, plan] of plans.explained) notes.push(`  ${name}: ${plan.join(" | ")}`);
    notes.push("Every SCAN in the statements of the board read and the pane's read:");
    for (const scan of plans.scans) notes.push(`  ${scan}`);
    expect(plans.explained.length).toBeGreaterThan(0);
  });
});

/** The number of the first workspace, checkout and Task of the link step's case. */
const LINKED = 1;

/**
 * Writes `count` joinable Tasks, each with a Thread in an ephemeral workspace
 * whose checkout is on a branch of its own, and a pull request on each branch
 * that is linked to its Task already. Adds `history` pull requests on
 * branches no checkout is on, as old work leaves them.
 */
const writeBranches = (count: number, history: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const remote = "github.com/northwind/web";
    yield* sql`INSERT INTO resources (id, kind, remote, canonical_remote, workspace_include,
                                      created_at, updated_at)
               VALUES (randomblob(16), 'repo', ${`https://${remote}`}, ${remote}, 1, ${AT}, ${AT})`;
    yield* sql.unsafe(`
      INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash,
                           created_at, updated_at)
      VALUES (${sqlId("runner", "1")}, 'one', 'online', 'active', 0, '[]', 'hash', '${AT}', '${AT}')`);
    yield* sql.unsafe(`
      ${numbers(LINKED, LINKED + count - 1)}
      INSERT INTO tasks (id, title, description, status, stage, priority, labels, created_at,
                         updated_at, status_changed_at, stage_changed_at, board_rank)
      SELECT ${sqlId("task")}, 'Branch work, part ' || i, '', 'open', 'building', 'normal', '[]',
             '${AT}', '${AT}', '${AT}', '${AT}', printf('V%06d', i)
      FROM n`);
    yield* sql.unsafe(`
      ${numbers(LINKED, LINKED + count - 1)}
      INSERT INTO workspaces (id, runner_id, kind, status, created_at)
      SELECT ${sqlId("workspace")}, ${sqlId("runner", "1")}, 'ephemeral', 'ready', '${AT}' FROM n`);
    yield* sql.unsafe(`
      ${numbers(LINKED, LINKED + count - 1)}
      INSERT INTO checkouts (id, workspace_id, resource_id, form, branch, branches, default_branch,
                             remote_branches, position, created_at)
      SELECT ${sqlId("checkout")}, ${sqlId("workspace")}, (SELECT id FROM resources), 'worktree',
             'thread-' || i, '[]', 'main', json_array('thread-' || i), 0, '${AT}'
      FROM n`);
    yield* sql.unsafe(`
      ${numbers(LINKED, LINKED + count - 1)}
      INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id,
                            requested_access_mode, access_mode, spec, title, status, created_at,
                            last_activity_at, task_id, workspace_id, harness_id)
      SELECT ${sqlId("session")}, randomblob(16), randomblob(16), ${sqlId("runner", "1")},
             'default', 'default', '{}', 'thread', 'idle', '${AT}', '${AT}', ${sqlId("task")},
             ${sqlId("workspace")}, 'test/test'
      FROM n`);
    yield* sql.unsafe(`
      ${numbers(1, count + history)}
      INSERT INTO external_entities (id, ref, kind, noun, card, pace, completeness, title, url,
                                     lifecycle, repository, first_observed_at, updated_at,
                                     source_created_at)
      SELECT randomblob(16), 'northwind:pr:' || i, 'northwind/pull-request', 'Pull request',
             'compact', 'fast', 'full', 'Pull request ' || i, 'https://northwind.example/pull/' || i,
             CASE WHEN i <= ${String(count)} THEN 'open' ELSE 'completed' END,
             json_object('target', json_object('remote', '${remote}'),
                         'head', json_object('remote', '${remote}',
                                             'branch', CASE WHEN i <= ${String(count)}
                                                            THEN 'thread-' || i ELSE 'old-' || i END)),
             '${AT}', '${AT}', '${AT}'
      FROM n`);
    yield* sql.unsafe(`
      ${numbers(LINKED, LINKED + count - 1)}
      INSERT INTO task_entity_links (task_id, ref, linked_at, linked_by, following)
      SELECT ${sqlId("task")}, 'northwind:pr:' || i, '${AT}', 'system', 0 FROM n`);
  }).pipe(inTransaction);

describe.runIf(SPEED_TESTS_ENABLED)("the branch link step", () => {
  it("at 500 workspaces, with every pull request linked already, is one statement", async () => {
    const result = await runAsUser(
      Effect.gen(function* () {
        yield* writeBranches(500, 5000);
        const sql = yield* SqlClient.SqlClient;
        const links = yield* BranchLinks;
        const traced = yield* traceStatements(links.linkEntitiesByBranch());
        return {
          linked: traced.value,
          statements: traced.statements.length,
          step: yield* measure(links.linkEntitiesByBranch()),
          // The one statement the step sends, run on its own.
          match: yield* measure(sql.unsafe(...traced.statements[0]!)),
        };
      }),
    );
    report.push(
      {
        name: "branch link step, 500 workspaces, 5,500 PRs",
        timing: result.step,
        statements: result.statements,
        target: "1 stmt, <5 ms",
        within: `${judge(result.step.median, 5)}, ${result.statements === 1 ? "1 stmt" : "MORE stmts"}`,
      },
      {
        name: "  the match statement alone",
        timing: result.match,
        target: "<5 ms",
        within: judge(result.match.median, 5),
      },
    );
    expect(result.linked).toEqual([]);
    expect(result.step.median).toBeLessThan(CEILING_MS);
  });
});

describe.runIf(SPEED_TESTS_ENABLED)("what a spawned Thread's Task costs", () => {
  it("inside the spawn's transaction, beside the spawn's own writes", async () => {
    const result = await runAsUser(
      Effect.gen(function* () {
        yield* writeBoard({ tasks: 300 });
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* TaskService;
        const sessions = yield* sessionRepository;
        const inputs = yield* inputRepository;
        const audit = yield* AuditLog;
        // An ephemeral workspace that already belongs to Task 2, so the next Thread in it joins.
        yield* inTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe(`
              INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels,
                                   credential_hash, created_at, updated_at)
              VALUES (${sqlId("runner", "1")}, 'one', 'online', 'active', 0, '[]', 'hash',
                      '${AT}', '${AT}')`);
            yield* sql.unsafe(`
              INSERT INTO workspaces (id, runner_id, kind, status, created_at)
              VALUES (${sqlId("workspace", "1")}, ${sqlId("runner", "1")}, 'ephemeral', 'ready',
                      '${AT}')`);
            yield* sql.unsafe(`
              INSERT INTO task_workspaces (workspace_id, task_id, joined_at)
              VALUES (${sqlId("workspace", "1")}, ${sqlId("task", "2")}, '${AT}')`);
          }),
        );
        /** The join of a spawned Thread, in no workspace or in the workspace of Task 2. */
        const join = (workspaceId: string | null) =>
          tasks.joinSession({
            requestedTaskId: undefined,
            callerTaskId: undefined,
            workspaceId,
            sessionKind: "thread",
            title: "Look into the refund button",
            projectId: undefined,
          });
        // The writes `SessionService.create` makes for every spawn, whatever its Task:
        // the session row, its prompt and its audit entry.
        const writeSpawnRows = Effect.gen(function* () {
          const id = uuidToString(mintUuid());
          yield* sessions.insert({
            id,
            title: "Look into the refund button",
            role: undefined,
            permissionProfileId: idOf("session", 1),
            agentId: undefined,
            conversationId: undefined,
            step: undefined,
            providerAccountId: idOf("session", 2),
            harnessId: "test/test",
            runnerId: idOf("runner", 1),
            workspaceId: null,
            projectId: undefined,
            taskId: idOf("task", 2),
            checkoutBranch: undefined,
            githubConnectionId: undefined,
            requestedAccessMode: "approval-required",
            accessMode: "approval-required",
            spec: "{}",
            modelSelection: { model: "clever", options: {} },
            parentSessionId: undefined,
            createdBy: "user",
            at: AT,
          });
          yield* inputs.insert({
            sessionId: id,
            source: "user",
            actor: "user",
            text: "Look into the refund button",
            at: AT,
          });
          yield* audit.append({
            kind: "session.spawned",
            actor: "user",
            record: { topic: "session", id, conversationId: null },
            payload: { sessionId: id, runnerId: idOf("runner", 1) },
            at: AT,
          });
        });
        /** Times one spawn transaction and counts the statements of its first run. */
        const cost = <A, E, R>(transaction: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const traced = yield* traceStatements(transaction);
            return {
              timing: yield* measure(transaction),
              statements: traced.statements.length,
              value: traced.value,
            };
          });
        return {
          own: yield* cost(inTransaction(writeSpawnRows)),
          newTask: yield* cost(inTransaction(Effect.tap(join(null), () => writeSpawnRows))),
          joined: yield* cost(
            inTransaction(Effect.tap(join(idOf("workspace", 1)), () => writeSpawnRows)),
          ),
        };
      }),
    );
    report.push(
      {
        name: "spawn transaction, Thread gets a new Task",
        timing: result.newTask.timing,
        statements: result.newTask.statements,
        target: "none stated",
        within: "-",
      },
      {
        name: "spawn transaction, Thread joins the workspace's Task",
        timing: result.joined.timing,
        statements: result.joined.statements,
        target: "none stated",
        within: "-",
      },
      {
        name: "spawn transaction, its own rows only (no join)",
        timing: result.own.timing,
        statements: result.own.statements,
        target: "-",
        within: "-",
      },
    );
    expect(result.joined.value?.taskId).toBe(idOf("task", 2));
  });
});

/** The size of the database the thread tasks migration runs on. */
interface ThreadTaskHistory {
  readonly tasks: number;
  readonly sessions: number;
  /** How many Threads in ten are Done, and so get no Task. */
  readonly doneInTen: number;
}

/**
 * Writes what the database before migration 0111 holds: `tasks` Tasks, one
 * runner, a main workspace, 2,000 ephemeral workspaces and `sessions`
 * sessions. One session in five is an Agent's, and every second of those runs
 * a workflow step of a run, half of them runs of a Task. A Thread is in no
 * workspace, the main one or an ephemeral one, in turn. Writes no
 * transaction: the migrations run on the writer, as at boot.
 */
const writeThreadHistory = ({ tasks, sessions, doneInTen }: ThreadTaskHistory) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`
      INSERT INTO runners (id, name, connectivity, lifecycle, reserved, labels, credential_hash,
                           created_at, updated_at)
      VALUES (${sqlId("runner", "1")}, 'one', 'online', 'active', 0, '[]', 'hash', '${AT}', '${AT}')`);
    yield* sql.unsafe(`
      ${numbers(0, 2000)}
      INSERT INTO workspaces (id, runner_id, kind, status, created_at, ownership, warnings)
      SELECT ${sqlId("workspace")}, ${sqlId("runner", "1")},
             CASE WHEN i = 0 THEN 'primary' ELSE 'ephemeral' END, 'ready', '${AT}', 'managed', '[]'
      FROM n`);
    yield* sql.unsafe(`
      ${numbers(1, tasks)}
      INSERT INTO tasks (id, title, description, status, priority, labels, created_at, updated_at,
                         status_changed_at)
      SELECT ${sqlId("task")}, 'Task ' || i, '', 'open', 'normal', '[]', '${AT}', '${AT}', '${AT}'
      FROM n`);
    yield* sql.unsafe(`
      ${numbers(1, sessions / 10)}
      INSERT INTO runs (id, plan, inputs, origin, status, created_at, task_id)
      SELECT ${sqlId("run")}, '{}', '{}', '{}', 'pending', '${AT}',
             CASE WHEN i % 2 = 0 THEN ${sqlId("task", `1 + i % ${String(tasks)}`)} END
      FROM n`);
    yield* sql.unsafe(`
      ${numbers(1, sessions)}
      INSERT INTO sessions (id, permission_profile_id, provider_account_id, runner_id, workspace_id,
                            agent_id, run_id, requested_access_mode, access_mode, spec, title,
                            status, created_at, last_activity_at, done_at, done_by)
      SELECT ${sqlId("session")}, randomblob(16), randomblob(16), ${sqlId("runner", "1")},
             CASE i % 4 WHEN 0 THEN NULL WHEN 1 THEN ${sqlId("workspace", "0")}
                        ELSE ${sqlId("workspace", "1 + i % 2000")} END,
             CASE WHEN i % 5 = 0 THEN randomblob(16) END,
             CASE WHEN i % 10 = 0 THEN ${sqlId("run", "i / 10")} END,
             'default', 'default', '{}', 'Thread ' || i, 'exited',
             strftime('%Y-%m-%dT%H:%M:%fZ', '${AT}', '+' || i || ' seconds'), '${AT}',
             CASE WHEN i % 5 <> 0 AND i % 10 < ${String(doneInTen)} THEN '${AT}' END,
             CASE WHEN i % 5 <> 0 AND i % 10 < ${String(doneInTen)} THEN 'user' END
      FROM n`);
  });

describe.runIf(SPEED_TESTS_ENABLED)("migration 0111 on a large database", () => {
  it.each([
    [
      "10,000 Tasks, 50,000 sessions, 1 Thread in 10 open",
      { tasks: 10_000, sessions: 50_000, doneInTen: 9 },
    ],
    [
      "10,000 Tasks, 50,000 sessions, every Thread open",
      { tasks: 10_000, sessions: 50_000, doneInTen: 0 },
    ],
  ] as const)("with %s", async (name, history) => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations(migrations.filter(([id]) => id < 111));
        yield* writeThreadHistory(history);
        const started = performance.now();
        yield* runMigrations(migrations.filter(([id]) => id <= 111));
        const elapsed = performance.now() - started;
        const made = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM tasks WHERE stage = 'exploring'`;
        return { elapsed, made: made[0]!.count };
      }).pipe(Effect.provide(TestDatabaseWriter)),
    );
    report.push({
      name: `migration 0111, ${name}`,
      timing: { median: result.elapsed, p95: result.elapsed },
      target: "none stated",
      within: `one run; ${result.made.toLocaleString("en")} Tasks made`,
    });
    expect(result.made).toBeGreaterThan(0);
  });
});
