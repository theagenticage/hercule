/**
 * Tests the Work board's read:
 *
 * - what a card shows, from the facts of a Task (`buildWorkCard`);
 * - who may read the board, and that nothing is read before they are known to;
 * - that the number of statements does not follow the number of cards;
 * - the query plan of the statement that lists the cards.
 *
 * The whole read over HTTP, with real sessions and runs, is tested in
 * `board.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import {
  MAX_BOARD_CARDS,
  MAX_CARD_QUESTION,
  MAX_TRACKING_FAILURE_CAUSE,
  WorkCard,
  type Grant,
  type SessionRequest,
} from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { TaskBoardFactsLayer } from "../daemon/tasks";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { runRepository } from "../runs";
import { sessionRepository } from "../sessions";
import {
  buildWorkCard,
  TaskBoard,
  TaskBoardFacts,
  TaskBoardLayer,
  type BoardCardFacts,
  type BoardSessionFact,
} from "./board";
import { taskRepository, type BoardTask, type NewTask } from "./repository";

const AT = "2026-10-20T10:00:00.000Z";
const TURN_ENDED = "2026-10-20T12:00:00.000Z";
const RUN_ENDED = "2026-10-20T13:00:00.000Z";

const TASK: BoardTask = {
  id: "0199e0e7-0004-7000-8000-000000000001",
  title: "Add a refund button",
  stage: "building",
  priority: "normal",
  projectId: "0199e0e7-0008-7000-8000-000000000001",
  boardRank: "V",
  createdAt: AT,
  stageChangedAt: AT,
  failedRunId: undefined,
};

const NO_FACTS: BoardCardFacts = {
  sessions: [],
  threadCount: 0,
  lastTurnEndedAt: undefined,
  lastRunEndedAt: undefined,
  failure: undefined,
};

const askQuestion = (
  requestId: string,
  text: string,
  extra: { readonly subagentId?: string } = {},
): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "question",
  detail: {
    questions: [{ question: text, header: "Refund", options: [], multiSelect: false }],
  },
  ...extra,
});

const askApproval = (requestId: string): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "command_approval",
  detail: { command: "pnpm test" },
  decisions: ["allow", "deny"],
});

let sessionCounter = 0;

/** Builds a session of a Task, opened at a time that rises with each call unless given. */
const buildSession = (fields: Partial<BoardSessionFact> = {}): BoardSessionFact => {
  sessionCounter += 1;
  return {
    id: `0199e0e7-0002-7000-8000-${String(sessionCounter).padStart(12, "0")}`,
    kind: "thread",
    status: "idle",
    createdAt: `2026-10-20T10:${String(sessionCounter % 60).padStart(2, "0")}:00.000Z`,
    openRequests: [],
    ...fields,
  };
};

const FAILURE = {
  runId: "0199e0e7-0006-7000-8000-000000000001",
  workflowName: "Review pull request",
  reason: "step-failed",
  message: "permission denied on ops-db",
} as const;

describe("buildWorkCard", () => {
  it("copies the place of the Task and leaves out every fact a Task without sessions or runs lacks", () => {
    const card = buildWorkCard(TASK, NO_FACTS);

    expect(card).toEqual({
      id: TASK.id,
      title: "Add a refund button",
      stage: "building",
      priority: "normal",
      projectId: TASK.projectId,
      boardRank: "V",
      threadCount: 0,
      createdAt: AT,
      stageChangedAt: AT,
      lastActivityAt: AT,
    });
  });

  it("leaves out the project of a Task that has none", () => {
    expect(buildWorkCard({ ...TASK, projectId: undefined }, NO_FACTS)).not.toHaveProperty(
      "projectId",
    );
  });

  describe("the open question", () => {
    it.each([
      [
        "a question the Thread's own agent parked on",
        buildSession({ openRequests: [askQuestion("q1", "Which refund window?")] }),
        "Which refund window?",
      ],
      [
        "a question a subagent inside the Thread asked",
        buildSession({
          openRequests: [askQuestion("q1", "Which refund window?", { subagentId: "explore-1" })],
        }),
        "Which refund window?",
      ],
      [
        "an async question the agent does not wait on",
        buildSession({
          openRequests: [
            {
              ...askQuestion("q1", "Which refund window?"),
              async: true,
            } as unknown as SessionRequest,
          ],
        }),
        "Which refund window?",
      ],
      [
        "the question that follows an approval in the same Thread",
        buildSession({
          openRequests: [askApproval("a1"), askQuestion("q1", "Which refund window?")],
        }),
        "Which refund window?",
      ],
    ])("is set by %s", (_name, thread, text) => {
      const card = buildWorkCard(TASK, { ...NO_FACTS, sessions: [thread] });

      expect(card.openQuestion).toEqual({
        sessionId: thread.id,
        requestId: "q1",
        text,
      });
      expect(card.openSessionId).toBe(thread.id);
    });

    it.each([
      ["an approval", buildSession({ openRequests: [askApproval("a1")] })],
      [
        "a question in a session of kind agent",
        buildSession({ kind: "agent", openRequests: [askQuestion("q1", "Which?")] }),
      ],
      [
        "a question in a session of kind run",
        buildSession({ kind: "run", openRequests: [askQuestion("q1", "Which?")] }),
      ],
      ["a Thread with nothing open", buildSession()],
    ])("is left unset by %s", (_name, session) => {
      expect(buildWorkCard(TASK, { ...NO_FACTS, sessions: [session] })).not.toHaveProperty(
        "openQuestion",
      );
    });

    it("picks the Thread opened first when several have a question, and its first question", () => {
      const first = buildSession({
        createdAt: "2026-10-20T09:00:00.000Z",
        openRequests: [askQuestion("q1", "First"), askQuestion("q2", "Second")],
      });
      const later = buildSession({
        createdAt: "2026-10-20T09:30:00.000Z",
        openRequests: [askQuestion("q3", "Third")],
      });

      const card = buildWorkCard(TASK, { ...NO_FACTS, sessions: [later, first] });

      expect(card.openQuestion).toMatchObject({ sessionId: first.id, requestId: "q1" });
    });

    // The protocol lets an agent ask an empty question. One such Thread must not
    // make the board unreadable for everyone, so the card keeps the question.
    it.each([
      ["empty", ""],
      ["only whitespace", "  \n "],
    ])("stays on the card, and decodes, when the question is %s", (_name, text) => {
      const thread = buildSession({ openRequests: [askQuestion("q1", text)] });

      const card = buildWorkCard(TASK, { ...NO_FACTS, sessions: [thread] });

      expect(card.openQuestion).toEqual({ sessionId: thread.id, requestId: "q1", text });
      expect(Schema.is(WorkCard)(card)).toBe(true);
    });

    it("cuts a long question to the bound, ellipsis included", () => {
      const thread = buildSession({
        openRequests: [askQuestion("q1", "Should the refund window be longer? ".repeat(30))],
      });

      const text = buildWorkCard(TASK, { ...NO_FACTS, sessions: [thread] }).openQuestion!.text;

      expect(text.length).toBeLessThanOrEqual(MAX_CARD_QUESTION);
      expect(text.endsWith("…")).toBe(true);
    });

    it("keeps the Thread with the question as the session a click opens, though a newer Thread exists", () => {
      const asking = buildSession({
        createdAt: "2026-10-20T09:00:00.000Z",
        openRequests: [askQuestion("q1", "Which?")],
      });
      const newer = buildSession({ createdAt: "2026-10-20T11:00:00.000Z" });

      const card = buildWorkCard(TASK, { ...NO_FACTS, sessions: [asking, newer], threadCount: 2 });

      expect(card.openSessionId).toBe(asking.id);
    });

    it("opens the newest Thread when no Thread has a question", () => {
      const older = buildSession({ createdAt: "2026-10-20T09:00:00.000Z" });
      const newer = buildSession({ createdAt: "2026-10-20T11:00:00.000Z" });

      const card = buildWorkCard(TASK, { ...NO_FACTS, sessions: [newer, older], threadCount: 2 });

      expect(card.openSessionId).toBe(newer.id);
      expect(card.threadCount).toBe(2);
    });

    it("opens the newest session of any kind when the Task has no Thread, and nothing when it has no session", () => {
      const older = buildSession({
        kind: "run",
        status: "exited",
        createdAt: "2026-10-20T09:00:00.000Z",
      });
      const newer = buildSession({
        kind: "agent",
        status: "idle",
        createdAt: "2026-10-20T11:00:00.000Z",
      });

      const card = buildWorkCard(TASK, { ...NO_FACTS, sessions: [newer, older] });

      expect(card.openSessionId).toBe(newer.id);
      expect(buildWorkCard(TASK, NO_FACTS)).not.toHaveProperty("openSessionId");
    });

    it("prefers a Thread to a newer session of another kind", () => {
      const thread = buildSession({ createdAt: "2026-10-20T09:00:00.000Z" });
      const step = buildSession({ kind: "run", createdAt: "2026-10-20T11:00:00.000Z" });

      const card = buildWorkCard(TASK, { ...NO_FACTS, sessions: [step, thread], threadCount: 1 });

      expect(card.openSessionId).toBe(thread.id);
    });
  });

  describe("the failure", () => {
    it("shows the failed run with the workflow's name and the cause in words", () => {
      const card = buildWorkCard(TASK, { ...NO_FACTS, failure: FAILURE });

      expect(card.failure).toEqual({
        runId: FAILURE.runId,
        workflowName: "Review pull request",
        cause: "permission denied on ops-db",
      });
    });

    it("explains a failure that recorded no message by its reason, and cuts a long message", () => {
      const withoutMessage = buildWorkCard(TASK, {
        ...NO_FACTS,
        failure: { ...FAILURE, reason: "workspace-failed", message: undefined },
      });
      const longMessage = buildWorkCard(TASK, {
        ...NO_FACTS,
        failure: { ...FAILURE, message: "denied ".repeat(100) },
      });

      expect(withoutMessage.failure?.cause).toBe("workspace failed");
      expect(longMessage.failure?.cause.length).toBeLessThanOrEqual(MAX_TRACKING_FAILURE_CAUSE);
      expect(Schema.is(WorkCard)(withoutMessage)).toBe(true);
      expect(Schema.is(WorkCard)(longMessage)).toBe(true);
    });

    it("shows beside an open question and a busy Thread, and hides neither of them", () => {
      const thread = buildSession({
        status: "busy",
        openRequests: [askQuestion("q1", "Which refund window?")],
      });

      const card = buildWorkCard(TASK, {
        ...NO_FACTS,
        sessions: [thread],
        threadCount: 1,
        failure: FAILURE,
      });

      expect(card.failure).toMatchObject({ runId: FAILURE.runId });
      expect(card.openQuestion).toMatchObject({ sessionId: thread.id });
      expect(card.workingSessionId).toBe(thread.id);
    });

    it("shows nothing for a Task whose runs finished, because only a stored failure shows", () => {
      expect(buildWorkCard(TASK, { ...NO_FACTS, lastRunEndedAt: RUN_ENDED })).not.toHaveProperty(
        "failure",
      );
    });
  });

  describe("the working session", () => {
    it.each(["queued", "starting", "busy"] as const)("is a session that is %s", (status) => {
      const session = buildSession({ status });

      expect(buildWorkCard(TASK, { ...NO_FACTS, sessions: [session] }).workingSessionId).toBe(
        session.id,
      );
    });

    it.each(["idle", "exited"] as const)("is not a session that is %s", (status) => {
      const session = buildSession({ status });

      expect(buildWorkCard(TASK, { ...NO_FACTS, sessions: [session] })).not.toHaveProperty(
        "workingSessionId",
      );
    });

    it("counts a session of any kind, so a run step draws the same head as a Thread", () => {
      const step = buildSession({ kind: "run", status: "busy" });
      const agent = buildSession({ kind: "agent", status: "starting" });

      expect(buildWorkCard(TASK, { ...NO_FACTS, sessions: [step] }).workingSessionId).toBe(step.id);
      expect(buildWorkCard(TASK, { ...NO_FACTS, sessions: [agent] }).workingSessionId).toBe(
        agent.id,
      );
    });
  });

  describe("the last activity", () => {
    it.each([
      ["the creation of a Task with no turn and no run", undefined, undefined, AT],
      ["the end of the last turn", TURN_ENDED, undefined, TURN_ENDED],
      ["the end of the last run", undefined, RUN_ENDED, RUN_ENDED],
      ["the later of the two, when a turn ended last", RUN_ENDED, TURN_ENDED, RUN_ENDED],
      ["the later of the two, when a run ended last", TURN_ENDED, RUN_ENDED, RUN_ENDED],
    ])("is %s", (_name, lastTurnEndedAt, lastRunEndedAt, expected) => {
      const card = buildWorkCard(TASK, { ...NO_FACTS, lastTurnEndedAt, lastRunEndedAt });

      expect(card.lastActivityAt).toBe(expected);
    });
  });
});

const USER: Actor = {
  _tag: "user",
  userId: "0199e0e7-0000-7000-8000-000000000000",
  credential: { kind: "login", id: "0199e0e7-0001-7000-8000-000000000000", tokenHash: "x" },
};

const buildSessionActor = (grants: ReadonlyArray<Grant>): Actor => ({
  _tag: "session",
  sessionId: "0199e0e7-0002-7000-8000-000000000000",
  profileId: "0199e0e7-0003-7000-8000-000000000000",
  grants,
  profileGrants: grants,
  assistantId: null,
  agentId: null,
});

const NEW_TASK: NewTask = {
  title: "A task",
  description: "",
  status: "open",
  stage: "planned",
  priority: "normal",
  labels: [],
  projectId: undefined,
  provenance: [],
  at: AT,
  actor: "user",
};

describe("who may read the board", () => {
  /** Runs the board read as `actor` over a port that records each time it is asked. */
  const readBoardAs = (actor: Actor) => {
    const asked: Array<ReadonlyArray<string>> = [];
    const result = Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* taskRepository;
        yield* inTransaction(repository.insert(NEW_TASK));
        return yield* Effect.exit(Effect.flatMap(TaskBoard, (board) => board.query()));
      }).pipe(
        Effect.provideService(CurrentActor, actor),
        Effect.provide(
          TaskBoardLayer.pipe(
            Layer.provide(
              Layer.succeed(TaskBoardFacts)({
                readFacts: (tasks) =>
                  Effect.sync(() => {
                    asked.push(tasks.map((task) => task.id));
                    return tasks.map(() => NO_FACTS);
                  }),
              }),
            ),
            Layer.provideMerge(TestDatabase),
          ),
        ),
      ),
    );
    return { result, asked };
  };

  it("lets the user read it, and a session that holds the task, session and run read grants", async () => {
    for (const actor of [USER, buildSessionActor(["task.read", "session.read", "run.read"])]) {
      const { result, asked } = readBoardAs(actor);
      const exit = await result;

      expect(exit._tag).toBe("Success");
      expect(asked).toHaveLength(1);
    }
  });

  it.each([
    ["task.read alone", ["task.read"], "session.read"],
    ["task.read and run.read, without session.read", ["task.read", "run.read"], "session.read"],
    ["task.read and session.read, without run.read", ["task.read", "session.read"], "run.read"],
    ["session.read and run.read, without task.read", ["session.read", "run.read"], "task.read"],
  ] as const)(
    "refuses a session that holds %s, names the grant it lacks, and reads nothing",
    async (_name, grants, missing) => {
      const { result, asked } = readBoardAs(buildSessionActor(grants));

      const exit = await result;

      expect(JSON.stringify(exit)).toContain(`"grant":"${missing}"`);
      expect(JSON.stringify(exit)).toContain("forbidden");
      expect(asked).toEqual([]);
    },
  );
});

/** Writes `count` Tasks, each with a busy Thread that has a question, a tenth of them failed. */
const writeBoard = (count: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tasks = yield* taskRepository;
    const sessions = yield* sessionRepository;
    const runs = yield* runRepository;
    yield* withTransaction(
      sql,
      Effect.gen(function* () {
        for (let n = 0; n < count; n++) {
          const task = yield* tasks.insert({
            ...NEW_TASK,
            title: `Task ${String(n)}`,
            stage: n % 2 === 0 ? "building" : "planned",
          });
          const sessionId = uuidToString(mintUuid());
          yield* sessions.insert({
            id: sessionId,
            title: "A thread",
            role: undefined,
            permissionProfileId: uuidToString(mintUuid()),
            agentId: undefined,
            conversationId: undefined,
            step: undefined,
            providerAccountId: uuidToString(mintUuid()),
            harnessId: "test/test",
            runnerId: uuidToString(mintUuid()),
            workspaceId: null,
            projectId: undefined,
            taskId: task.id,
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
          yield* sql`
            UPDATE sessions SET status = 'busy', open_requests = ${JSON.stringify([
              askQuestion(`q${String(n)}`, "Which refund window?"),
            ])}
            WHERE id = ${uuidFromString(sessionId)}`;
          if (n % 10 === 0) {
            const runId = yield* runs.insert(
              {
                workflowId: null,
                plan: { name: "Review pull request", steps: [] },
                inputs: {},
                origin: { kind: "manual", actor: "user" },
                entryStepIds: ["work"],
                taskId: task.id,
              },
              AT,
            );
            yield* runs.start(runId, AT);
            yield* runs.finish(
              runId,
              { status: "failed", failureReason: "step-failed", failedStepId: "work" },
              AT,
            );
            yield* tasks.setFailedRun(task.id, runId);
          }
        }
      }),
    );
  });

/** Counts the statements the board read sends to the database, with `count` Tasks on the board. */
const countStatements = (count: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* writeBoard(count);
      const statements: Array<string> = [];
      const board = yield* Effect.provideService(
        Effect.flatMap(TaskBoard, (reader) => reader.query()),
        Statement.CurrentTransformer,
        (statement) =>
          Effect.sync(() => {
            statements.push(statement.compile()[0]);
            return statement;
          }),
      );
      return { statements, board };
    }).pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(
        TaskBoardLayer.pipe(Layer.provide(TaskBoardFactsLayer), Layer.provideMerge(TestDatabase)),
      ),
    ),
  );

describe("the cost of the board read", () => {
  it("sends the same number of statements for 10 cards and for 300, and reads no transcript", async () => {
    const small = await countStatements(10);
    const large = await countStatements(300);

    expect(small.board.cards).toHaveLength(10);
    expect(large.board.cards).toHaveLength(300);
    expect(small.board.cards.filter((card) => card.failure !== undefined)).toHaveLength(1);
    expect(large.board.cards.filter((card) => card.failure !== undefined)).toHaveLength(30);
    expect(small.board.cards.every((card) => card.openQuestion !== undefined)).toBe(true);
    expect(large.statements).toHaveLength(small.statements.length);
    expect(large.statements.some((text) => text.includes("session_stream"))).toBe(false);
  });
});

describe("the size of the board", () => {
  /** Reads the board when `count` Tasks are on it. */
  const readBoardWithTasks = (count: number) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* taskRepository;
        yield* withTransaction(
          sql,
          Effect.forEach(Array.from({ length: count }), () => tasks.insert(NEW_TASK), {
            discard: true,
          }),
        );
        return yield* Effect.flatMap(TaskBoard, (board) => board.query());
      }).pipe(
        Effect.provideService(CurrentActor, USER),
        Effect.provide(
          TaskBoardLayer.pipe(Layer.provide(TaskBoardFactsLayer), Layer.provideMerge(TestDatabase)),
        ),
      ),
    );

  it("returns every card and says nothing was left out when the board holds exactly the most it returns", async () => {
    const board = await readBoardWithTasks(MAX_BOARD_CARDS);

    expect(board.cards).toHaveLength(MAX_BOARD_CARDS);
    expect(board.truncated).toBe(false);
  });

  it("returns the most it can and says Tasks were left out when the board holds more", async () => {
    const board = await readBoardWithTasks(MAX_BOARD_CARDS + 1);

    expect(board.cards).toHaveLength(MAX_BOARD_CARDS);
    expect(board.truncated).toBe(true);
  });
});

describe("the query plan of the board's Task statement", () => {
  it("walks the Tasks on the board rank index in the order it returns them, with no sort and no scan of the table", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* taskRepository;
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* tasks.listBoardTasks(MAX_BOARD_CARDS).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile());
              return statement;
            }),
          ),
        );
        const [text, params] = statements[0]!;
        const rows = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${text}`,
          params,
        );
        return rows.map((row) => row.detail);
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(plan).toContain("SCAN t USING INDEX tasks_board_rank");
    expect(plan.some((step) => step.includes("TEMP B-TREE"))).toBe(false);
    expect(plan.some((step) => step.startsWith("SCAN t") && !step.includes("INDEX"))).toBe(false);
  });
});
