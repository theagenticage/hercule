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
  MAX_BOARD_GROUPINGS,
  MAX_BOARD_PLACES,
  MAX_CARD_CONTEXTS,
  MAX_CARD_QUESTION,
  MAX_ENTITY_MARKS,
  MAX_TRACKING_FAILURE_CAUSE,
  WorkBoard,
  WorkCard,
  type Grant,
  type SessionRequest,
} from "@hercule/contract";
import {
  HOST_API,
  registerConnectionType,
  registerEventSource,
  type Plugin,
} from "@hercule/plugin-host";
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
import { externalEntityRepository, type ObservedEntity } from "../external-entities";
import { PluginHost, Plugins } from "../plugins";
import { buildPluginStack, IDLE_FEEDS, IDLE_INGEST_OPEN } from "../plugins/testing";
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
  stageCauseFactId: undefined,
  summary: undefined,
};

const NO_FACTS: BoardCardFacts = {
  sessions: [],
  threadCount: 0,
  lastTurnEndedAt: undefined,
  lastRunEndedAt: undefined,
  failure: undefined,
  stageCause: undefined,
  linkedRefs: [],
  entityMarks: [],
  contextRefs: [],
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
      entityMarks: [],
      contextRefs: [],
      blockedBy: [],
      blockedByCount: 0,
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

  describe("the outside things", () => {
    it("copies the marks and the context refs, and cuts them to what a card holds", () => {
      const marks = ["a", "b", "c", "d"].map((kind) => ({ plugin: "acme", kind: `acme/${kind}` }));
      const refs = Array.from(
        { length: MAX_CARD_CONTEXTS + 1 },
        (_, n) => `acme:thing:${String(n)}`,
      );

      const card = buildWorkCard(TASK, { ...NO_FACTS, entityMarks: marks, contextRefs: refs });

      expect(card.entityMarks).toEqual(marks.slice(0, MAX_ENTITY_MARKS));
      expect(card.contextRefs).toEqual(refs.slice(0, MAX_CARD_CONTEXTS));
      expect(Schema.is(WorkCard)(card)).toBe(true);
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
                readStackCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
                readFacts: (tasks) =>
                  Effect.sync(() => {
                    asked.push(tasks.map((task) => task.id));
                    return {
                      cards: tasks.map(() => NO_FACTS),
                      context: { places: [], edges: [], groupings: [], contextComplete: true },
                    };
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

/**
 * The Work board's read on a migrated database with a real plugin host. The
 * board asks the host which plugins are running, so a place whose plugin
 * stopped counts as stale.
 */
const boardLayer = () =>
  TaskBoardLayer.pipe(Layer.provide(TaskBoardFactsLayer), Layer.provideMerge(buildPluginStack()));

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
    }).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(boardLayer())),
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

const PLUGIN = "acme-tracker";

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

const CONNECTION = "0199e0e7-0010-7000-8000-000000000001";
const PROJECT_A = "acme-tracker:project:harbour";
const PROJECT_B = "acme-tracker:project:lighthouse";
const ticketRef = (name: string) => `acme-tracker:ticket:${name}`;

type ObservedRelations = NonNullable<ObservedEntity["observation"]["relations"]>;

const OBSERVED_AT = "2026-10-20T09:00:00.000Z";

/** Builds the observation of a ticket: a compact, fast kind with no caption, so it cannot group. */
const ticket = (name: string, relations?: ObservedRelations): ObservedEntity => ({
  kind: `${PLUGIN}/ticket`,
  slots: {
    noun: "Ticket",
    card: "compact",
    pace: "fast",
    patience: 24,
    identifier: name.toUpperCase(),
    facts: [],
  },
  observation: {
    kind: "ticket",
    ref: ticketRef(name),
    title: `Ticket ${name}`,
    url: `https://tracker.example/${name}`,
    lifecycle: "open",
    fields: {},
    concerns: ["assigned"],
    sourceUpdatedAt: OBSERVED_AT,
    ...(relations === undefined ? {} : { relations }),
  },
});

/** Builds the observation of a project: a place with a caption, so it can group. */
const projectPlace = (ref: string, title: string): ObservedEntity => ({
  kind: `${PLUGIN}/project`,
  slots: { noun: "Project", pace: "context", caption: "Tracker project" },
  observation: {
    kind: "project",
    ref,
    title,
    fields: {},
    concerns: [],
    sourceUpdatedAt: OBSERVED_AT,
  },
});

const partOf = (...parents: ReadonlyArray<string>): ObservedRelations => ({
  complete: true,
  partOf: parents,
  linked: [],
});

/**
 * Stores the observations of one tracker plugin, as one Connection read them,
 * and a Task on the board that links each of `linked`.
 */
const writeLinkedBoard = (input: {
  readonly kinds: ReadonlyArray<{
    readonly kind: string;
    readonly observed: ReadonlyArray<ObservedEntity>;
  }>;
  readonly tasks: ReadonlyArray<ReadonlyArray<string>>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tasks = yield* taskRepository;
    const entities = yield* externalEntityRepository;
    yield* Effect.flatMap(PluginHost, (host) => host.boot([trackerPlugin]));
    yield* withTransaction(
      sql,
      Effect.gen(function* () {
        yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
            status, labels, config, created_at, updated_at)
          VALUES (${uuidFromString(CONNECTION)}, ${PLUGIN}, ${`${PLUGIN}/account`}, 'a', 'a', 'a',
            'connected', '[]', '{}', ${AT}, ${AT})`;
        for (const { kind, observed } of input.kinds) {
          yield* entities.reconcile({
            connectionId: CONNECTION,
            kind,
            complete: true,
            observed,
            actor: `plugin:${PLUGIN}`,
            environment: { now: AT, activePluginIds: [PLUGIN] },
          });
        }
        for (const [index, refs] of input.tasks.entries()) {
          yield* tasks.insert({
            ...NEW_TASK,
            title: `Task ${String(index)}`,
            provenance: refs.map((ref) => ({ ref })),
          });
        }
      }),
    );
  });

/**
 * Stores the board with `writeLinkedBoard`, runs `change` (a change to the
 * database or to the plugins, after the board was written), and reads the board.
 */
const readLinkedBoard = (
  input: Parameters<typeof writeLinkedBoard>[0],
  change: Effect.Effect<unknown, unknown, SqlClient.SqlClient | Plugins> = Effect.void,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* writeLinkedBoard(input);
      yield* change;
      return yield* Effect.flatMap(TaskBoard, (board) => board.query());
    }).pipe(
      Effect.provideService(CurrentActor, USER),
      Effect.provide(boardLayer()),
    ) as Effect.Effect<WorkBoard>,
  );

const TICKET_KIND = `${PLUGIN}/ticket`;
const PROJECT_KIND = `${PLUGIN}/project`;

describe("the context of the board", () => {
  it("puts a Task under two places in both, and carries each place once for the whole board", async () => {
    const board = await readLinkedBoard({
      kinds: [
        {
          kind: PROJECT_KIND,
          observed: [projectPlace(PROJECT_A, "Harbour"), projectPlace(PROJECT_B, "Lighthouse")],
        },
        {
          kind: TICKET_KIND,
          observed: [ticket("one", partOf(PROJECT_A, PROJECT_B)), ticket("two", partOf(PROJECT_A))],
        },
      ],
      tasks: [[ticketRef("one")], [ticketRef("two")]],
    });

    const [first, second] = board.cards.toSorted((a, b) => a.title.localeCompare(b.title));
    expect(first!.contextRefs).toEqual([ticketRef("one"), PROJECT_A, PROJECT_B]);
    expect(second!.contextRefs).toEqual([ticketRef("two"), PROJECT_A]);
    expect(first!.entityMarks).toEqual([{ plugin: PLUGIN, kind: TICKET_KIND }]);
    expect(board.places.map((place) => place.ref)).toEqual(
      [PROJECT_A, PROJECT_B, ticketRef("one"), ticketRef("two")].toSorted(),
    );
    expect(board.places.find((place) => place.ref === PROJECT_A)).toMatchObject({
      title: "Harbour",
      caption: "Tracker project",
      restricted: false,
    });
    expect(board.edges).toEqual(
      expect.arrayContaining([
        { fromRef: ticketRef("one"), toRef: PROJECT_A },
        { fromRef: ticketRef("one"), toRef: PROJECT_B },
        { fromRef: ticketRef("two"), toRef: PROJECT_A },
      ]),
    );
    expect(board.edges).toHaveLength(3);
    expect(board.contextComplete).toBe(true);
  });

  it("never gives a Task the ancestors of a peer its link is only linked to", async () => {
    const board = await readLinkedBoard({
      kinds: [
        { kind: PROJECT_KIND, observed: [projectPlace(PROJECT_A, "Harbour")] },
        {
          kind: TICKET_KIND,
          observed: [
            ticket("peer", partOf(PROJECT_A)),
            ticket("mine", { complete: true, partOf: [], linked: [ticketRef("peer")] }),
          ],
        },
      ],
      tasks: [[ticketRef("mine")]],
    });

    expect(board.cards[0]!.contextRefs).toEqual([ticketRef("mine")]);
    expect(board.places.map((place) => place.ref)).toEqual([ticketRef("mine")]);
    expect(board.edges).toEqual([]);
  });

  it("lists a groupable kind with its caption only when a place of it is on the board", async () => {
    const withProject = await readLinkedBoard({
      kinds: [
        { kind: PROJECT_KIND, observed: [projectPlace(PROJECT_A, "Harbour")] },
        { kind: TICKET_KIND, observed: [ticket("one", partOf(PROJECT_A))] },
      ],
      tasks: [[ticketRef("one")]],
    });
    const withoutProject = await readLinkedBoard({
      kinds: [
        { kind: PROJECT_KIND, observed: [projectPlace(PROJECT_A, "Harbour")] },
        { kind: TICKET_KIND, observed: [ticket("one")] },
      ],
      tasks: [[ticketRef("one")]],
    });

    expect(withProject.groupings).toEqual([{ kind: PROJECT_KIND, caption: "Tracker project" }]);
    expect(withoutProject.groupings).toEqual([]);
  });

  it("says the context may be incomplete when a ref above a link has no record", async () => {
    const board = await readLinkedBoard({
      kinds: [{ kind: TICKET_KIND, observed: [ticket("one", partOf(PROJECT_A))] }],
      tasks: [[ticketRef("one")]],
    });

    expect(board.cards[0]!.contextRefs).toEqual([ticketRef("one"), PROJECT_A]);
    expect(board.contextComplete).toBe(false);
  });

  describe("when a place above a link cannot be read now", () => {
    const board = {
      kinds: [
        { kind: PROJECT_KIND, observed: [projectPlace(PROJECT_A, "Harbour")] },
        { kind: TICKET_KIND, observed: [ticket("one", partOf(PROJECT_A))] },
      ],
      tasks: [[ticketRef("one")]],
    };

    it("is complete while a Connection reads the place", async () => {
      expect((await readLinkedBoard(board)).contextComplete).toBe(true);
    });

    /** Runs a change to the rows, in a transaction as a writer does. */
    const writeRows = (
      change: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>,
    ): Effect.Effect<unknown, unknown, SqlClient.SqlClient> =>
      Effect.flatMap(SqlClient.SqlClient, (sql) => withTransaction(sql, change(sql)));

    it.each([
      [
        "its only Connection is disabled",
        writeRows((sql) => sql`UPDATE connections SET status = 'disabled'`),
      ],
      ["its plugin stopped", Effect.flatMap(Plugins, (plugins) => plugins.disable(PLUGIN))],
      [
        "every Connection that reads it is backing off",
        writeRows(
          (sql) =>
            sql`UPDATE external_entity_observations SET next_attempt_at = '2999-01-01T00:00:00.000Z'
                WHERE ref = ${PROJECT_A}`,
        ),
      ],
      [
        "no Connection can read it any more",
        writeRows(
          (sql) =>
            sql`UPDATE external_entity_observations SET access = 'inaccessible'
                WHERE ref = ${PROJECT_A}`,
        ),
      ],
    ] as const)("is incomplete when %s", async (_name, change) => {
      const read = await readLinkedBoard(board, change);

      expect(read.contextComplete).toBe(false);
      // The last-known place stays on the board.
      expect(read.places.map((place) => place.ref)).toContain(PROJECT_A);
    });
  });

  it("keeps the places to the most a reply carries, and says the context is incomplete", async () => {
    const perTask = 100;
    const taskCount = Math.ceil((MAX_BOARD_PLACES + 100) / perTask);
    const names = Array.from({ length: taskCount * perTask }, (_, n) => `t${String(n)}`);
    const read = await readLinkedBoard({
      kinds: [{ kind: TICKET_KIND, observed: names.map((name) => ticket(name)) }],
      tasks: Array.from({ length: taskCount }, (_, task) =>
        names.slice(task * perTask, (task + 1) * perTask).map(ticketRef),
      ),
    });

    expect(read.places).toHaveLength(MAX_BOARD_PLACES);
    expect(read.contextComplete).toBe(false);
    expect(() => Schema.encodeSync(WorkBoard)(read)).not.toThrow();
  });

  it("keeps the groupings to the most a reply carries, the first kinds by name, and says the context is incomplete", async () => {
    const kindNames = Array.from(
      { length: MAX_BOARD_GROUPINGS + 1 },
      (_, n) => `group${String(n).padStart(2, "0")}`,
    );
    const placeRef = (word: string) => `acme-tracker:${word}:one`;
    const read = await readLinkedBoard({
      kinds: kindNames.map((word) => ({
        kind: `${PLUGIN}/${word}`,
        observed: [
          {
            ...projectPlace(placeRef(word), word),
            kind: `${PLUGIN}/${word}`,
            slots: { noun: "Group", pace: "context" as const, caption: `Caption ${word}` },
          },
        ],
      })),
      tasks: [kindNames.map(placeRef)],
    });

    expect(read.groupings.map((grouping) => grouping.kind)).toEqual(
      kindNames.slice(0, MAX_BOARD_GROUPINGS).map((word) => `${PLUGIN}/${word}`),
    );
    expect(read.contextComplete).toBe(false);
    expect(() => Schema.encodeSync(WorkBoard)(read)).not.toThrow();
  });

  it("sends the same number of statements for 10 Tasks and for 300 that link things under places", async () => {
    /** Reads a board of `count` Tasks, each linking its own ticket under one project, and returns the statements sent. */
    const countContextStatements = (count: number) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const names = Array.from({ length: count }, (_, n) => `t${String(n)}`);
          yield* writeLinkedBoard({
            kinds: [
              { kind: PROJECT_KIND, observed: [projectPlace(PROJECT_A, "Harbour")] },
              {
                kind: TICKET_KIND,
                observed: names.map((name) => ticket(name, partOf(PROJECT_A))),
              },
            ],
            tasks: names.map((name) => [ticketRef(name)]),
          });
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
        }).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(boardLayer())),
      );

    const small = await countContextStatements(10);
    const large = await countContextStatements(300);

    expect(large.board.cards).toHaveLength(300);
    expect(large.board.cards.every((card) => card.contextRefs.includes(PROJECT_A))).toBe(true);
    expect(large.board.places).toHaveLength(301);
    expect(large.statements).toHaveLength(small.statements.length);
  });
});

describe("the stack candidates of the board", () => {
  const epicRef = (name: string) => `${PLUGIN}:epic:${name}`;

  /** Builds the observation of an epic: a rich, slow kind that reports the tickets it holds as its links. */
  const epic = (name: string, linked: ReadonlyArray<string>): ObservedEntity => ({
    kind: `${PLUGIN}/epic`,
    slots: {
      noun: "Epic",
      card: "rich",
      pace: "slow",
      patience: 336,
      identifier: name.toUpperCase(),
      facts: [],
    },
    observation: {
      kind: "epic",
      ref: epicRef(name),
      title: `Epic ${name}`,
      url: `https://tracker.example/epic/${name}`,
      lifecycle: "open",
      fields: {},
      concerns: ["assigned"],
      sourceUpdatedAt: OBSERVED_AT,
      relations: { complete: true, partOf: [], linked },
    },
  });

  it("pairs the Task of a rich thing with the Tasks of the compact things it reports, and leaves a Task of an unrelated thing out", async () => {
    const board = await readLinkedBoard({
      kinds: [
        {
          kind: TICKET_KIND,
          observed: [ticket("one"), ticket("two"), ticket("loose")],
        },
        { kind: `${PLUGIN}/epic`, observed: [epic("lead", [ticketRef("one"), ticketRef("two")])] },
      ],
      tasks: [[epicRef("lead")], [ticketRef("one")], [ticketRef("two")], [ticketRef("loose")]],
    });

    const byTitle = new Map(board.cards.map((card) => [card.title, card.id]));
    const [lead, one, two] = ["Task 0", "Task 1", "Task 2"].map((title) => byTitle.get(title)!);
    expect(board.stackCandidatesTruncated).toBe(false);
    expect(board.stackCandidates).toHaveLength(2);
    expect(board.stackCandidates).toEqual(
      expect.arrayContaining([
        { leadTaskId: lead, memberTaskId: one, noun: "Ticket" },
        { leadTaskId: lead, memberTaskId: two, noun: "Ticket" },
      ]),
    );
    expect(() => Schema.encodeSync(WorkBoard)(board)).not.toThrow();
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
      }).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(boardLayer())),
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

describe("the cap on the board and a failed Task", () => {
  it("lists every Task that shows a failure, however small the cap, and fills the rest in board order", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const tasks = yield* taskRepository;
        const ids: Array<string> = [];
        for (let index = 0; index < 6; index++) {
          const task = yield* inTransaction(tasks.insert({ ...NEW_TASK, title: `Task ${index}` }));
          ids.push(task.id);
        }
        // The last two Tasks of the board are the ones a cap of three would cut.
        yield* inTransaction(
          Effect.forEach([ids[4]!, ids[5]!], (id) =>
            tasks.setFailedRun(id, uuidToString(mintUuid())),
          ),
        );
        return {
          ids,
          capped: yield* tasks.listBoardTasks(3),
          whole: yield* tasks.listBoardTasks(6),
        };
      }).pipe(Effect.provide(TestDatabase), Effect.orDie),
    );

    expect(result.capped.tasks.map((task) => task.id)).toEqual([
      result.ids[0],
      result.ids[4],
      result.ids[5],
    ]);
    expect(result.capped.truncated).toBe(true);
    expect(result.whole.tasks).toHaveLength(6);
    expect(result.whole.truncated).toBe(false);
  });
});

describe("the query plans of the board's Task statements", () => {
  /** Returns the query plan of each statement `listBoardTasks` runs. */
  const readPlans = () =>
    Effect.runPromise(
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
        return yield* Effect.forEach(statements, ([text, params]) =>
          Effect.map(
            sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${text}`, params),
            (rows) => rows.map((row) => row.detail),
          ),
        );
      }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
    );

  it("reads the failed Tasks and the others in one statement, from their two indexes, with no sort and no scan of the table", async () => {
    const plans = await readPlans();

    // One statement is one snapshot, so a Task cannot be listed twice when
    // its failure is cleared between two reads.
    expect(plans).toHaveLength(1);
    const plan = plans[0]!;
    expect(plan).toContain("SEARCH t USING INDEX tasks_failed (failed_run_id>?)");
    expect(plan).toContain("SCAN t USING INDEX tasks_board_rank");
    expect(plan.some((step) => step.includes("TEMP B-TREE"))).toBe(false);
    expect(plan.some((step) => step.startsWith("SCAN t") && !step.includes("INDEX"))).toBe(false);
  });
});

describe("the summary on a card", () => {
  const WRITTEN_AT = "2026-10-20T11:00:00.000Z";
  const SUMMARY = {
    line: "Three designs, depots worried.",
    standing: "Three refund designs are drawn. The depots object to the second.",
    left: "Pick a design.",
  };

  /** Writes one Task, lets `arrange` write its summary row, and returns the Task's card from the board. */
  const readCardAfter = (
    arrange: (taskId: string) => Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* taskRepository;
        const task = yield* inTransaction(repository.insert(NEW_TASK));
        yield* inTransaction(arrange(task.id));
        const board = yield* Effect.flatMap(TaskBoard, (reader) => reader.query());
        return board.cards[0]!;
      }).pipe(
        Effect.provideService(CurrentActor, USER),
        Effect.provide(
          TaskBoardLayer.pipe(
            Layer.provide(TaskBoardFactsLayer),
            Layer.provideMerge(buildPluginStack()),
          ),
        ),
        Effect.orDie,
      ),
    );

  const write = (taskId: string) =>
    Effect.flatMap(taskRepository, (repository) =>
      repository.writeSummary({ taskId, dirtyRevision: 1, summary: SUMMARY, at: WRITTEN_AT }),
    );
  const markDirty = (taskId: string) =>
    Effect.flatMap(taskRepository, (repository) => repository.markSummaryDirty(taskId, AT));
  const fail = (taskId: string) =>
    Effect.flatMap(taskRepository, (repository) =>
      repository.writeSummaryFailure({
        taskId,
        dirtyRevision: 2,
        reason: "no model",
        at: AT,
        chooseNextAttempt: () => AT,
      }),
    );

  it.each([
    ["no row", () => Effect.void, undefined],
    ["a row that was only marked dirty", markDirty, undefined],
    [
      "a written summary",
      (taskId: string) => Effect.andThen(markDirty(taskId), write(taskId)),
      { ...SUMMARY, generatedAt: WRITTEN_AT, stale: false },
    ],
    [
      "a written summary and a change since",
      (taskId: string) =>
        Effect.andThen(Effect.andThen(markDirty(taskId), write(taskId)), markDirty(taskId)),
      { ...SUMMARY, generatedAt: WRITTEN_AT, stale: true },
    ],
    [
      "a written summary and a failed attempt since",
      (taskId: string) =>
        Effect.andThen(
          Effect.andThen(Effect.andThen(markDirty(taskId), write(taskId)), markDirty(taskId)),
          fail(taskId),
        ),
      { ...SUMMARY, generatedAt: WRITTEN_AT, stale: true },
    ],
  ])("shows, for %s, the summary %j", async (_name, arrange, expected) => {
    const card = await readCardAfter(arrange);

    expect(card.summary).toEqual(expected);
    // A summary is a description: the facts a card shows from real rows are unchanged.
    expect(card).not.toHaveProperty("openQuestion");
    expect(card).not.toHaveProperty("failure");
  });
});
