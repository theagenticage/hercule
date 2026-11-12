/**
 * Tests the details pane's read (`task.readDetail`), against the real sessions
 * and runs ports and rows written the way the controller writes them:
 *
 * - what the reply holds for a Task with many sessions of several kinds, an
 *   open question, and runs that include a failed one;
 * - the Tasks it refuses to describe;
 * - who may read it, and that nothing is read before they are known to;
 * - that the number of statements does not follow the number of sessions.
 *
 * The rules for working a card out from facts are tested in `board.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import {
  MAX_DETAIL_SESSIONS,
  TaskDetail,
  type Grant,
  type SessionRequest,
  type WorkflowDefinition,
} from "@hercule/contract";
import { CurrentActor, type Actor } from "../actor";
import { TaskBoardFactsLayer, TaskDetailFactsLayer } from "../daemon/tasks";
import { buildPluginStack } from "../plugins/testing";
import { TaskTrackingRunsLayer } from "../daemon/runs";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import { externalEntityRepository, type ObservedEntity } from "../external-entities";
import { runRepository } from "../runs";
import { sessionRepository } from "../sessions";
import { TaskBoardFacts } from "./board";
import { TaskDetailFacts, TaskDetails, TaskDetailsLayer } from "./detail";
import { taskRepository, type NewTask } from "./repository";
import { TaskTrackingRuns } from "./tracking";

const AT = "2026-10-20T10:00:00.000Z";
const minute = (n: number) => `2026-10-20T11:${String(n).padStart(2, "0")}:00.000Z`;

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
  title: "Fix gift card refunds",
  description: "Refunds to a Northwind gift card fail.",
  status: "open",
  stage: "building",
  priority: "normal",
  labels: ["payments"],
  projectId: undefined,
  provenance: [],
  at: AT,
  actor: "user",
};

const askQuestion = (requestId: string, text: string, subagentId?: string): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "question",
  detail: { questions: [{ question: text, header: "Refund", options: [], multiSelect: false }] },
  ...(subagentId === undefined ? {} : { subagentId }),
});

const askApproval = (requestId: string): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "command_approval",
  detail: { command: "pnpm test" },
  decisions: ["allow", "deny"],
});

const PLAN = {
  name: "Fix refunds",
  steps: [{ id: "work", kind: "agent" }],
} as unknown as WorkflowDefinition;

/** Reads details as the user, over the real ports and a fresh database. */
const DetailsOverRealPorts = TaskDetailsLayer.pipe(
  Layer.provide(Layer.mergeAll(TaskBoardFactsLayer, TaskTrackingRunsLayer, TaskDetailFactsLayer)),
  Layer.provideMerge(buildPluginStack()),
);

const insertTask = (fields: Partial<NewTask> = {}) =>
  Effect.gen(function* () {
    const tasks = yield* taskRepository;
    return (yield* tasks.insert({ ...NEW_TASK, ...fields })).id;
  }).pipe(inTransaction);

interface SessionToWrite {
  readonly taskId: string;
  /** `run` makes the session of a run's step, `agent` an Agent's session; the default is a Thread. */
  readonly kind?: "thread" | "agent" | "run";
  readonly status?: "idle" | "busy" | "exited";
  readonly requests?: ReadonlyArray<SessionRequest>;
  readonly createdAt: string;
  /** The run a session of kind `run` belongs to. */
  readonly runId?: string;
  readonly done?: boolean;
  /** The description of the subagent the requests came from, keyed by its id. */
  readonly subagents?: Readonly<Record<string, string>>;
}

/** Writes a session of a Task and returns its id. */
const insertSession = (session: SessionToWrite) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sessions = yield* sessionRepository;
    const id = uuidToString(mintUuid());
    const kind = session.kind ?? "thread";
    yield* sessions.insert({
      id,
      title: `A ${kind} at ${session.createdAt}`,
      role: undefined,
      permissionProfileId: uuidToString(mintUuid()),
      agentId: kind === "thread" ? undefined : uuidToString(mintUuid()),
      conversationId: undefined,
      step: undefined,
      providerAccountId: uuidToString(mintUuid()),
      harnessId: "test/test",
      runnerId: uuidToString(mintUuid()),
      workspaceId: null,
      projectId: undefined,
      taskId: session.taskId,
      checkoutBranch: undefined,
      githubConnectionId: undefined,
      requestedAccessMode: "approval-required",
      accessMode: "approval-required",
      spec: "{}",
      modelSelection: { model: "clever", options: {} },
      parentSessionId: undefined,
      createdBy: "user",
      at: session.createdAt,
    });
    yield* sql`
      UPDATE sessions
      SET status = ${session.status ?? "idle"},
          open_requests = ${JSON.stringify(session.requests ?? [])},
          run_id = ${session.runId === undefined ? null : uuidFromString(session.runId)},
          done_at = ${session.done === true ? session.createdAt : null},
          done_by = ${session.done === true ? "user" : null}
      WHERE id = ${uuidFromString(id)}`;
    for (const [subagentId, description] of Object.entries(session.subagents ?? {})) {
      yield* sql`
        INSERT INTO session_subagents (session_id, subagent_id, description, status, started_at)
        VALUES (${uuidFromString(id)}, ${subagentId}, ${description}, 'running', ${session.createdAt})`;
    }
    return id;
  }).pipe(inTransaction);

interface RunToWrite {
  readonly taskId: string;
  readonly at: string;
  /** How the run ends; absent leaves it running. */
  readonly ending?: "completed" | "failed";
  /** The session the run's agent step ran in. */
  readonly stepSessionId?: string;
}

/** Writes a run of a Task and ends it as asked. A failed run is the one the Task shows. */
const insertRun = (run: RunToWrite) =>
  Effect.gen(function* () {
    const runs = yield* runRepository;
    const tasks = yield* taskRepository;
    const id = yield* runs.insert(
      {
        workflowId: null,
        plan: PLAN,
        inputs: {},
        origin: { kind: "manual", actor: "user" },
        entryStepIds: ["work"],
        taskId: run.taskId,
      },
      run.at,
    );
    if (run.ending === undefined && run.stepSessionId === undefined) return id;
    yield* runs.start(id, run.at);
    const step = { stepId: "work", iteration: 1 };
    yield* runs.startStep(
      id,
      step,
      run.stepSessionId === undefined ? undefined : { sessionId: run.stepSessionId },
      run.at,
    );
    if (run.ending === "completed") {
      yield* runs.finishStep(
        id,
        step,
        { status: "completed", output: { text: "Refunds now reach the gift card." } },
        { startedAt: run.at, finishedAt: run.at },
      );
      yield* runs.finish(id, { status: "completed" }, run.at);
    } else if (run.ending === "failed") {
      yield* runs.finishStep(
        id,
        step,
        { status: "failed", error: { code: "denied", message: "permission denied on ops-db" } },
        { startedAt: run.at, finishedAt: run.at },
      );
      yield* runs.finish(
        id,
        { status: "failed", failureReason: "step-failed", failedStepId: "work" },
        run.at,
      );
      yield* tasks.setFailedRun(run.taskId, id);
    }
    return id;
  }).pipe(inTransaction);

/** Reads the details of a Task as `actor`, and returns the exit. */
const readDetailsAs = (actor: Actor, id: string) =>
  Effect.flatMap(TaskDetails, (details) => details.read(id)).pipe(
    Effect.provideService(CurrentActor, actor),
    Effect.exit,
  );

/**
 * Writes a Task with thirteen sessions of every kind and status, an open
 * question asked by a subagent, a failed run, a running run and a completed
 * run, and returns the ids the assertions need.
 */
const writeBusyTask = Effect.gen(function* () {
  const taskId = yield* insertTask();
  const failedRun = yield* insertRun({ taskId, at: minute(20), ending: "failed" });
  const runningRun = yield* insertRun({ taskId, at: minute(25) });
  const finishedThreads: Array<string> = [];
  for (let n = 1; n <= 8; n++) {
    finishedThreads.push(yield* insertSession({ taskId, createdAt: minute(n), status: "exited" }));
  }
  const doneThread = yield* insertSession({ taskId, createdAt: minute(15), done: true });
  // A step session belongs to its run, and is unfinished only while that run is.
  const finishedStep = yield* insertSession({
    taskId,
    kind: "run",
    status: "exited",
    createdAt: minute(9),
    runId: failedRun,
  });
  const askingThread = yield* insertSession({
    taskId,
    createdAt: minute(30),
    status: "busy",
    requests: [askApproval("a1"), askQuestion("q1", "Which refund window?", "sub-1")],
    subagents: { "sub-1": "Checks the ledger" },
  });
  const agentSession = yield* insertSession({
    taskId,
    kind: "agent",
    createdAt: minute(31),
    status: "busy",
  });
  const runningStep = yield* insertSession({
    taskId,
    kind: "run",
    createdAt: minute(32),
    status: "busy",
    runId: runningRun,
  });
  // The newest run completed, and its agent step ran in the Agent's session.
  const completedRun = yield* insertRun({
    taskId,
    at: minute(40),
    ending: "completed",
    stepSessionId: agentSession,
  });
  return {
    taskId,
    failedRun,
    runningRun,
    completedRun,
    finishedThreads,
    doneThread,
    finishedStep,
    askingThread,
    agentSession,
    runningStep,
  };
});

describe("task.readDetail", () => {
  it("gives the Task, its card, its unfinished sessions first then the newest, and its runs", async () => {
    const { ids, exit, detail } = await Effect.runPromise(
      Effect.gen(function* () {
        const ids = yield* writeBusyTask;
        const exit = yield* readDetailsAs(USER, ids.taskId);
        if (exit._tag !== "Success") return { ids, exit, detail: undefined };
        // The reply must fit the contract it is sent over, bounds included.
        const detail = Schema.decodeUnknownSync(TaskDetail)(
          Schema.encodeSync(TaskDetail)(exit.value),
        );
        return { ids, exit, detail };
      }).pipe(Effect.provide(DetailsOverRealPorts)),
    );

    expect(exit._tag).toBe("Success");
    expect(detail!.task).toMatchObject({
      id: ids.taskId,
      title: "Fix gift card refunds",
      description: "Refunds to a Northwind gift card fail.",
      labels: ["payments"],
    });
    expect(detail!.card).toMatchObject({
      id: ids.taskId,
      stage: "building",
      openQuestion: { sessionId: ids.askingThread, requestId: "q1", text: "Which refund window?" },
      failure: { runId: ids.failedRun, cause: "permission denied on ops-db" },
      workingSessionId: ids.runningStep,
    });

    expect(detail!.sessionCount).toBe(13);
    expect(detail!.sessions).toHaveLength(MAX_DETAIL_SESSIONS);
    // The three unfinished sessions come first, newest first. Then the finished
    // ones, newest first: the Done Thread, the finished step, then the Threads.
    expect(detail!.sessions.map((session) => session.id)).toEqual([
      ids.runningStep,
      ids.agentSession,
      ids.askingThread,
      ids.doneThread,
      ids.finishedStep,
      ...ids.finishedThreads.toReversed().slice(0, 5),
    ]);
    expect(detail!.sessions.map((session) => session.kind).slice(0, 5)).toEqual([
      "run",
      "agent",
      "thread",
      "thread",
      "run",
    ]);
    expect(detail!.sessions.map((session) => session.status).slice(0, 3)).toEqual([
      "busy",
      "busy",
      "busy",
    ]);
    expect(detail!.sessions.map((session) => session.done)).toEqual([
      false,
      false,
      false,
      true,
      ...Array.from({ length: 6 }, () => false),
    ]);
    // Open Requests are the ones the Session record shows, with the asking subagent's name.
    expect(detail!.sessions[2]!.openRequests).toEqual([
      askApproval("a1"),
      { ...askQuestion("q1", "Which refund window?", "sub-1"), subagentName: "Checks the ledger" },
    ]);
    expect(detail!.sessions[0]!.openRequests).toEqual([]);

    expect(detail!.runCount).toBe(3);
    // Tracking lists the runs oldest first.
    expect(detail!.runs.map((run) => [run.id, run.status])).toEqual([
      [ids.failedRun, "failed"],
      [ids.runningRun, "pending"],
      [ids.completedRun, "completed"],
    ]);
    expect(detail!.runs[0]!.failureCause).toBe("permission denied on ops-db");
    expect(detail!.runs[2]!.sessionId).toBe(ids.agentSession);
  });

  it("gives a Task with no session and no run empty lists and zero counts", async () => {
    const detail = await Effect.runPromise(
      Effect.gen(function* () {
        const taskId = yield* insertTask({ title: "Plain" });
        const details = yield* TaskDetails;
        return yield* details.read(taskId);
      }).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(DetailsOverRealPorts)),
    );

    expect(detail.card.title).toBe("Plain");
    expect(detail.sessions).toEqual([]);
    expect(detail.sessionCount).toBe(0);
    expect(detail.runs).toEqual([]);
    expect(detail.runCount).toBe(0);
  });

  it("lists the Thread that asks the card's question even when ten newer sessions are unfinished", async () => {
    const { askingThread, newer, detail } = await Effect.runPromise(
      Effect.gen(function* () {
        const taskId = yield* insertTask();
        // The oldest unfinished Thread asks, and the board shows the oldest asking Thread.
        const askingThread = yield* insertSession({
          taskId,
          createdAt: minute(1),
          status: "busy",
          requests: [askQuestion("q1", "Which refund window?")],
        });
        const newer: Array<string> = [];
        for (let n = 2; n <= 12; n++) {
          newer.push(yield* insertSession({ taskId, createdAt: minute(n), status: "busy" }));
        }
        const details = yield* TaskDetails;
        return { askingThread, newer, detail: yield* details.read(taskId) };
      }).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(DetailsOverRealPorts)),
    );

    expect(detail.card.openQuestion?.sessionId).toBe(askingThread);
    expect(detail.sessionCount).toBe(12);
    expect(detail.sessions).toHaveLength(MAX_DETAIL_SESSIONS);
    // The asking Thread takes the last place, and the nine newest sessions keep theirs.
    expect(detail.sessions.map((session) => session.id)).toEqual([
      ...newer.toReversed().slice(0, MAX_DETAIL_SESSIONS - 1),
      askingThread,
    ]);
    expect(detail.sessions.at(-1)!.openRequests).toHaveLength(1);
  });

  it("carries the Task's summary on its card, and only there", async () => {
    const detail = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const taskId = yield* insertTask();
        yield* inTransaction(
          sql`INSERT INTO task_summaries (task_id, line, standing_text, left_text, input_revision,
                                          generated_at, dirty_revision, attempt_count)
              VALUES (${uuidFromString(taskId)}, 'Fixing gift card refunds', 'The refund call is fixed.',
                      'Add a test.', 1, ${AT}, 1, 0)`,
        );
        const details = yield* TaskDetails;
        return yield* details.read(taskId);
      }).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(DetailsOverRealPorts)),
    );

    expect(detail.card.summary).toEqual({
      line: "Fixing gift card refunds",
      standing: "The refund call is fixed.",
      left: "Add a test.",
      generatedAt: AT,
      stale: false,
    });
    expect(detail).not.toHaveProperty("summary");
  });

  it("shows a Task of a deleted project in no project, as the board does", async () => {
    const detail = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projectId = mintUuid();
        yield* inTransaction(
          sql`INSERT INTO projects (id, name, created_at, updated_at, deleted_at)
              VALUES (${projectId}, 'Northwind Archive', ${AT}, ${AT}, ${AT})`,
        );
        const taskId = yield* insertTask({ projectId: uuidToString(projectId) });
        const details = yield* TaskDetails;
        return yield* details.read(taskId);
      }).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(DetailsOverRealPorts)),
    );

    expect(detail.card).not.toHaveProperty("projectId");
  });

  it("returns the details of the Task a merged id was merged into, whose id differs", async () => {
    const detail = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const survivor = yield* insertTask({ title: "Refund flow" });
        const mergedAway = yield* insertTask({ title: "Refund bug" });
        yield* inTransaction(
          sql`UPDATE tasks SET merged_into_id = ${uuidFromString(survivor)}
              WHERE id = ${uuidFromString(mergedAway)}`,
        );
        const details = yield* TaskDetails;
        return {
          survivor,
          detail: yield* details.read(mergedAway).pipe(Effect.provideService(CurrentActor, USER)),
        };
      }).pipe(Effect.provide(DetailsOverRealPorts)),
    );

    expect(detail.detail.task).toMatchObject({ id: detail.survivor, title: "Refund flow" });
    expect(detail.detail.card.id).toBe(detail.survivor);
  });

  it("fails with NotFound for a missing Task and a deleted Task, and with InvalidState saying why for a finished one", async () => {
    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const tasks = yield* taskRepository;
        const deleted = yield* insertTask({ title: "Removed" });
        yield* inTransaction(tasks.softDelete(deleted, AT));
        const done = yield* insertTask({ title: "Shipped", stage: "done", status: "done" });
        const dropped = yield* insertTask({ title: "Abandoned", stage: "dropped" });
        return yield* Effect.all({
          missing: readDetailsAs(USER, uuidToString(mintUuid())),
          deleted: readDetailsAs(USER, deleted),
          done: readDetailsAs(USER, done),
          dropped: readDetailsAs(USER, dropped),
        });
      }).pipe(Effect.provide(DetailsOverRealPorts)),
    );

    expect(JSON.stringify(exits.missing)).toContain("no such task");
    expect(JSON.stringify(exits.deleted)).toContain("no such task");
    for (const exit of [exits.done, exits.dropped]) {
      expect(JSON.stringify(exit)).toContain("invalid_state");
      expect(JSON.stringify(exit)).toContain("this task is finished");
    }
  });
});

describe("the outside things a Task links", () => {
  const PLUGIN = "acme-tracker";
  const CONNECTION = "0199e0e7-0010-7000-8000-000000000001";
  const PROJECT_A = `${PLUGIN}:project:harbour`;
  const PROJECT_B = `${PLUGIN}:project:lighthouse`;
  const ticketRef = (name: string) => `${PLUGIN}:ticket:${name}`;

  const ticket = (name: string, partOf: ReadonlyArray<string>): ObservedEntity => ({
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
      sourceUpdatedAt: AT,
      relations: { complete: true, partOf, linked: [] },
    },
    fieldRows: [],
  });

  const project = (ref: string, title: string): ObservedEntity => ({
    kind: `${PLUGIN}/project`,
    slots: { noun: "Project", pace: "context", caption: "Tracker project" },
    observation: { kind: "project", ref, title, fields: {}, concerns: [], sourceUpdatedAt: AT },
    fieldRows: [],
  });

  /**
   * Stores one Connection's reading of the projects and of `tickets`, and
   * returns the id of a Task that links every ticket, in order.
   */
  const writeLinkedTask = (tickets: ReadonlyArray<ObservedEntity>) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const entities = yield* externalEntityRepository;
      const tasks = yield* taskRepository;
      return yield* withTransaction(
        sql,
        Effect.gen(function* () {
          yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
              status, labels, config, created_at, updated_at)
            VALUES (${uuidFromString(CONNECTION)}, ${PLUGIN}, ${`${PLUGIN}/account`}, 'a', 'a', 'a',
              'connected', '[]', '{}', ${AT}, ${AT})`;
          for (const [kind, observed] of [
            [
              `${PLUGIN}/project`,
              [project(PROJECT_A, "Harbour"), project(PROJECT_B, "Lighthouse")],
            ],
            [`${PLUGIN}/ticket`, tickets],
          ] as const) {
            yield* entities.reconcile({
              connectionId: CONNECTION,
              kind,
              complete: true,
              observed,
              actor: `plugin:${PLUGIN}`,
              environment: { now: AT, activePluginIds: [PLUGIN] },
            });
          }
          const task = yield* tasks.insert({
            ...NEW_TASK,
            provenance: tickets.map((each) => ({ ref: each.observation.ref })),
          });
          return task.id;
        }),
      );
    });

  /** Reads the details of a Task that links `tickets`, counting the statements the read sends. */
  const readLinkedDetail = (
    tickets: ReadonlyArray<ObservedEntity>,
    change: Effect.Effect<unknown, unknown, SqlClient.SqlClient> = Effect.void,
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const taskId = yield* writeLinkedTask(tickets);
        yield* change;
        const statements: Array<string> = [];
        const detail = yield* Effect.flatMap(TaskDetails, (details) => details.read(taskId)).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile()[0]);
              return statement;
            }),
          ),
        );
        return {
          statements,
          detail: Schema.decodeUnknownSync(TaskDetail)(Schema.encodeSync(TaskDetail)(detail)),
        };
      }).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(DetailsOverRealPorts)),
    );

  it("carries the linked things in the order they were linked, with the places above them and the steps between", async () => {
    const { detail } = await readLinkedDetail([
      ticket("one", [PROJECT_A, PROJECT_B]),
      ticket("two", [PROJECT_A]),
    ]);

    expect(detail.entities.map((entity) => entity.ref)).toEqual([
      ticketRef("one"),
      ticketRef("two"),
    ]);
    expect(detail.entities[0]).toMatchObject({
      title: "Ticket one",
      identifier: "ONE",
      noun: "Ticket",
      restricted: false,
    });
    expect(detail.places.map((place) => place.ref)).toEqual(
      [PROJECT_A, PROJECT_B, ticketRef("one"), ticketRef("two")].toSorted(),
    );
    expect(detail.edges).toHaveLength(3);
    expect(detail.edges).toEqual(
      expect.arrayContaining([
        { fromRef: ticketRef("one"), toRef: PROJECT_A },
        { fromRef: ticketRef("one"), toRef: PROJECT_B },
        { fromRef: ticketRef("two"), toRef: PROJECT_A },
      ]),
    );
  });

  it("marks a place no Connection can read as restricted, with no title", async () => {
    const { detail } = await readLinkedDetail(
      [ticket("one", [PROJECT_A, PROJECT_B])],
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        withTransaction(
          sql,
          sql`UPDATE external_entity_observations SET access = 'inaccessible'
              WHERE ref = ${PROJECT_B}`,
        ),
      ),
    );

    const restricted = detail.places.find((place) => place.ref === PROJECT_B);
    expect(restricted).toMatchObject({ restricted: true, noun: "Project" });
    expect(restricted).not.toHaveProperty("title");
    expect(detail.places.find((place) => place.ref === PROJECT_A)).toMatchObject({
      restricted: false,
      title: "Harbour",
    });
  });

  it("gives a Task that links nothing no entities, places or edges", async () => {
    const { detail } = await readLinkedDetail([]);

    expect(detail.entities).toEqual([]);
    expect(detail.places).toEqual([]);
    expect(detail.edges).toEqual([]);
  });

  it("walks up from the linked things once, for the card and the pane together", async () => {
    const { statements } = await readLinkedDetail([ticket("one", [PROJECT_A, PROJECT_B])]);

    expect(statements.filter((text) => text.includes("WITH RECURSIVE"))).toHaveLength(1);
  });

  it("sends the same number of statements for 1 linked thing and for 20", async () => {
    const names = (count: number) => Array.from({ length: count }, (_, n) => `t${String(n)}`);
    const small = await readLinkedDetail(
      names(1).map((name) => ticket(name, [PROJECT_A, PROJECT_B])),
    );
    const large = await readLinkedDetail(
      names(20).map((name) => ticket(name, [PROJECT_A, PROJECT_B])),
    );

    expect(large.detail.entities).toHaveLength(20);
    expect(large.statements).toHaveLength(small.statements.length);
  });
});

describe("who may read the details", () => {
  /** Reads the details as `actor` over ports that record each time they are asked. */
  const readAs = (actor: Actor) => {
    const asked: Array<string> = [];
    const result = Effect.runPromise(
      Effect.gen(function* () {
        const taskId = yield* insertTask();
        return yield* readDetailsAs(actor, taskId);
      }).pipe(
        Effect.provide(
          TaskDetailsLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(TaskBoardFacts)({
                  readStackCandidates: () => Effect.succeed({ candidates: [], truncated: false }),
                  readFacts: (tasks) =>
                    Effect.sync(() => {
                      asked.push("card facts");
                      return {
                        cards: tasks.map(() => ({
                          sessions: [],
                          threadCount: 0,
                          lastTurnEndedAt: undefined,
                          lastRunEndedAt: undefined,
                          failure: undefined,
                          stageCause: undefined,
                          linkedRefs: [],
                          entityMarks: [],
                          contextRefs: [],
                        })),
                        context: { places: [], edges: [], groupings: [], contextComplete: true },
                      };
                    }),
                }),
                Layer.succeed(TaskTrackingRuns)({
                  readRunHistory: () =>
                    Effect.sync(() => {
                      asked.push("run history");
                      return { runs: [], agentStep: undefined, endingActionStepName: undefined };
                    }),
                  readLatestRuns: () => Effect.die("not read by the details"),
                  readWorkflowName: () => Effect.die("not read by the details"),
                  readWorkflowNames: () => Effect.die("not read by the details"),
                  readTaskIds: () => Effect.die("not read by the details"),
                  readLegRuns: () => Effect.die("not read by the details"),
                }),
                Layer.succeed(TaskDetailFacts)({
                  readSessions: () =>
                    Effect.sync(() => {
                      asked.push("sessions");
                      return { sessions: [], total: 0 };
                    }),
                  countRuns: () =>
                    Effect.sync(() => {
                      asked.push("run count");
                      return 0;
                    }),
                }),
              ),
            ),
            Layer.provideMerge(TestDatabase),
          ),
        ),
      ),
    );
    return { result, asked };
  };

  it("lets the user read them, and a session that holds the task, session and run read grants", async () => {
    for (const actor of [USER, buildSessionActor(["task.read", "session.read", "run.read"])]) {
      const { result, asked } = readAs(actor);
      const exit = await result;

      expect(exit._tag).toBe("Success");
      expect(asked).toEqual(["card facts", "sessions", "run history", "run count"]);
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
      const { result, asked } = readAs(buildSessionActor(grants));

      const exit = await result;

      expect(JSON.stringify(exit)).toContain(`"grant":"${missing}"`);
      expect(JSON.stringify(exit)).toContain("forbidden");
      expect(asked).toEqual([]);
    },
  );
});

describe("the cost of the details read", () => {
  /** Counts the statements one read sends, for a Task with `count` sessions and a failed run among its runs. */
  const countStatements = (count: number) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const taskId = yield* insertTask();
        yield* insertRun({ taskId, at: minute(1), ending: "failed" });
        for (let n = 0; n < count; n++) {
          yield* insertSession({ taskId, createdAt: minute(n + 2), status: "busy" });
        }
        yield* insertRun({ taskId, at: minute(50), ending: "completed" });
        const statements: Array<string> = [];
        const detail = yield* Effect.flatMap(TaskDetails, (details) => details.read(taskId)).pipe(
          Effect.provideService(Statement.CurrentTransformer, (statement) =>
            Effect.sync(() => {
              statements.push(statement.compile()[0]);
              return statement;
            }),
          ),
        );
        return { statements, detail };
      }).pipe(Effect.provideService(CurrentActor, USER), Effect.provide(DetailsOverRealPorts)),
    );

  it("sends the same number of statements for 1 session and for 40, and reads no transcript", async () => {
    const small = await countStatements(1);
    const large = await countStatements(40);

    expect(small.detail.sessionCount).toBe(1);
    expect(large.detail.sessionCount).toBe(40);
    expect(large.detail.sessions).toHaveLength(MAX_DETAIL_SESSIONS);
    expect(large.statements).toHaveLength(small.statements.length);
    expect(large.statements.some((text) => text.includes("session_stream"))).toBe(false);
  });
});

describe("the query plan of the Task's sessions statement", () => {
  it("finds the Task's sessions by an index on their Task and reads no other session", async () => {
    const plan = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sessions = yield* sessionRepository;
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* sessions
          .listOfTask(uuidToString(mintUuid()), MAX_DETAIL_SESSIONS, uuidToString(mintUuid()))
          .pipe(
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

    expect(
      plan.some((step) => step.startsWith("SEARCH s USING") && step.includes("task_id=?")),
    ).toBe(true);
    expect(plan.some((step) => step.startsWith("SCAN s") || step.startsWith("SCAN sessions"))).toBe(
      false,
    );
  });
});
