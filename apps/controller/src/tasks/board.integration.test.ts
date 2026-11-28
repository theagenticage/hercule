/**
 * Tests `GET /tasks/board` over a real socket, against the real sessions and
 * runs ports and rows written the way the controller writes them: what a card
 * shows for a Thread alone, a handed-off Task, an open question, an approval,
 * a failed run, a live run and a deleted project, which Tasks the board leaves
 * out, and the order of the cards. The rules for working a card out from
 * facts are in `board.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import {
  WorkBoard,
  type SessionRequest,
  type TaskStage,
  type WorkCard,
  type WorkflowDefinition,
} from "@hercule/contract";
import { mintUuid, uuidFromString, uuidToString } from "../db";
import { inTransaction } from "../db/testing";
import { completeSetup, get, withServer, type ServerHarness } from "../http/testing";
import { runRepository } from "../runs";
import { sessionRepository } from "../sessions";
import { taskRepository } from "./repository";

const AT = "2026-10-20T10:00:00.000Z";
const minute = (n: number) => `2026-10-20T11:${String(n).padStart(2, "0")}:00.000Z`;
const SIGNAL = "0199e0e7-0005-7000-8000-000000000001";
const PLAN = { name: "Review pull request", steps: [] } as unknown as WorkflowDefinition;

const writeInDatabase = <A>(
  { sql }: ServerHarness,
  effect: Effect.Effect<A, unknown, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    effect.pipe(inTransaction, Effect.provideService(SqlClient.SqlClient, sql), Effect.orDie),
  );

/** Writes a project and returns its id. */
const insertProject = (harness: ServerHarness, name: string, deletedAt?: string) =>
  writeInDatabase(
    harness,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const id = mintUuid();
      yield* sql`INSERT INTO projects (id, name, created_at, updated_at, deleted_at)
                 VALUES (${id}, ${name}, ${AT}, ${AT}, ${deletedAt ?? null})`;
      return uuidToString(id);
    }),
  );

/** Writes a Task and returns its id. */
const insertTask = (
  harness: ServerHarness,
  title: string,
  fields: {
    readonly stage?: TaskStage;
    readonly projectId?: string;
    readonly handoff?: boolean;
    readonly deleted?: boolean;
  } = {},
) =>
  writeInDatabase(
    harness,
    Effect.gen(function* () {
      const tasks = yield* taskRepository;
      const stage = fields.stage ?? "building";
      const task = yield* tasks.insert({
        title,
        description: "",
        stage,
        status: stage === "done" ? "done" : "in-progress",
        priority: "normal",
        labels: [],
        projectId: fields.projectId,
        provenance: fields.handoff === true ? [{ signalId: SIGNAL, runId: mintRunId() }] : [],
        at: AT,
        actor: "user",
      });
      if (fields.deleted === true) yield* tasks.softDelete(task.id, AT);
      return task.id;
    }),
  );

const mintRunId = () => uuidToString(mintUuid());

interface SessionToWrite {
  readonly taskId: string;
  /** `run` makes a session of a run's step, `agent` an Agent's session; the default is a Thread. */
  readonly kind?: "thread" | "agent" | "run";
  readonly status?: "idle" | "busy" | "exited";
  readonly requests?: ReadonlyArray<SessionRequest>;
  readonly createdAt?: string;
  readonly lastTurnEndedAt?: string;
}

/** Writes a session of a Task and returns its id. */
const insertSession = (harness: ServerHarness, session: SessionToWrite) =>
  writeInDatabase(
    harness,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const sessions = yield* sessionRepository;
      const id = uuidToString(mintUuid());
      const kind = session.kind ?? "thread";
      yield* sessions.insert({
        id,
        title: "A session",
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
        at: session.createdAt ?? AT,
      });
      yield* sql`
        UPDATE sessions
        SET status = ${session.status ?? "idle"},
            open_requests = ${JSON.stringify(session.requests ?? [])},
            last_turn_ended_at = ${session.lastTurnEndedAt ?? null},
            run_id = ${kind === "run" ? mintUuid() : null}
        WHERE id = ${uuidFromString(id)}`;
      return id;
    }),
  );

interface RunToWrite {
  readonly taskId: string;
  readonly at: string;
  /** How the run ended; absent leaves it pending. */
  readonly ending?: "completed" | "failed";
  /** The error of the step a failed run failed at. */
  readonly stepError?: string;
}

/** Writes a run of a Task, ends it as asked, and returns its id. A failed run is the one the Task shows. */
const insertRun = (harness: ServerHarness, run: RunToWrite) =>
  writeInDatabase(
    harness,
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
      if (run.ending === undefined) return id;
      yield* runs.start(id, run.at);
      if (run.ending === "completed") {
        yield* runs.finish(id, { status: "completed" }, run.at);
        return id;
      }
      const step = { stepId: "work", iteration: 1 };
      yield* runs.startStep(id, step, undefined, run.at);
      yield* runs.finishStep(
        id,
        step,
        { status: "failed", error: { code: "denied", message: run.stepError ?? "denied" } },
        { startedAt: run.at, finishedAt: run.at },
      );
      yield* runs.finish(
        id,
        { status: "failed", failureReason: "step-failed", failedStepId: "work" },
        run.at,
      );
      yield* tasks.setFailedRun(run.taskId, id);
      return id;
    }),
  );

const askQuestion = (requestId: string, text: string): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "question",
  detail: { questions: [{ question: text, header: "Refund", options: [], multiSelect: false }] },
});

const askApproval = (requestId: string): SessionRequest => ({
  requestId,
  itemId: `item-${requestId}`,
  kind: "command_approval",
  detail: { command: "pnpm test" },
  decisions: ["allow", "deny"],
});

const readBoard = async (base: string, token: string) => {
  const response = await get(base, "/api/v1/tasks/board", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return Schema.decodeUnknownSync(WorkBoard)(await response.json());
};

const indexByTitle = (cards: ReadonlyArray<WorkCard>) =>
  new Map(cards.map((card) => [card.title, card] as const));

describe("task.queryBoard", () => {
  it("gives each card what its Thread, run and project say, from the real rows", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const storefront = await insertProject(harness, "Northwind Storefront");
      const archive = await insertProject(harness, "Northwind Archive", AT);

      const threadOnly = await insertTask(harness, "Thread only", {
        stage: "exploring",
        projectId: storefront,
      });
      await insertSession(harness, {
        taskId: threadOnly,
        createdAt: minute(1),
        status: "exited",
      });
      const newerThread = await insertSession(harness, {
        taskId: threadOnly,
        createdAt: minute(2),
        lastTurnEndedAt: minute(30),
      });

      const handedOff = await insertTask(harness, "Handed off", { handoff: true });
      await insertRun(harness, { taskId: handedOff, at: minute(10), ending: "completed" });
      await insertSession(harness, {
        taskId: handedOff,
        kind: "run",
        status: "exited",
        createdAt: minute(5),
      });
      const handedOffStep = await insertSession(harness, {
        taskId: handedOff,
        kind: "run",
        status: "exited",
        createdAt: minute(9),
      });

      const asking = await insertTask(harness, "Asks a question", { projectId: storefront });
      const askingThread = await insertSession(harness, {
        taskId: asking,
        status: "busy",
        requests: [askApproval("a1"), askQuestion("q1", "Which refund window?")],
      });

      const approving = await insertTask(harness, "Needs approval", { projectId: storefront });
      const approvingThread = await insertSession(harness, {
        taskId: approving,
        status: "busy",
        requests: [askApproval("a1")],
      });

      const failing = await insertTask(harness, "Failed", { projectId: storefront });
      const failedRun = await insertRun(harness, {
        taskId: failing,
        at: minute(20),
        ending: "failed",
        stepError: "permission denied on ops-db",
      });
      // A newer run that completed does not clear the failure the Task shows.
      await insertRun(harness, { taskId: failing, at: minute(25), ending: "completed" });
      const failingThread = await insertSession(harness, {
        taskId: failing,
        status: "busy",
        requests: [askQuestion("q2", "Retry the deploy?")],
      });

      const stepRun = await insertTask(harness, "Run step", { stage: "in-review" });
      const stepSession = await insertSession(harness, {
        taskId: stepRun,
        kind: "run",
        status: "busy",
        requests: [askQuestion("q3", "A question that is not a Thread's")],
      });
      await insertRun(harness, { taskId: stepRun, at: minute(40) });

      const orphan = await insertTask(harness, "Orphan", { stage: "planned" });
      await insertTask(harness, "Plain", { stage: "planned" });
      await writeInDatabase(
        harness,
        Effect.gen(function* () {
          // The project is deleted after the Task joined it, as the projects domain deletes.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE tasks SET project_id = ${uuidFromString(archive)}
                     WHERE id = ${uuidFromString(orphan)}`;
        }),
      );

      await insertTask(harness, "Finished", { stage: "done" });
      await insertTask(harness, "Removed", { deleted: true });

      const board = await readBoard(harness.base, token);
      const cards = indexByTitle(board.cards);

      expect(board.truncated).toBe(false);
      expect(board.cards).toHaveLength(8);
      expect(board).toMatchObject({ places: [], edges: [], groupings: [], contextComplete: true });
      expect(cards.get("Plain")).toMatchObject({ entityMarks: [], contextRefs: [] });
      expect(cards.get("Thread only")).toMatchObject({
        stage: "exploring",
        projectId: storefront,
        threadCount: 2,
        openSessionId: newerThread,
        lastActivityAt: minute(30),
      });
      expect(cards.get("Thread only")).not.toHaveProperty("openQuestion");
      expect(cards.get("Thread only")).not.toHaveProperty("workingSessionId");
      expect(cards.get("Handed off")).not.toHaveProperty("projectId");
      expect(cards.get("Handed off")).toMatchObject({
        openSessionId: handedOffStep,
        threadCount: 0,
        lastActivityAt: minute(10),
      });
      expect(cards.get("Handed off")).not.toHaveProperty("failure");
      expect(cards.get("Asks a question")).toMatchObject({
        openQuestion: { sessionId: askingThread, requestId: "q1", text: "Which refund window?" },
        openSessionId: askingThread,
        workingSessionId: askingThread,
      });
      expect(cards.get("Needs approval")).toMatchObject({
        openSessionId: approvingThread,
        workingSessionId: approvingThread,
      });
      expect(cards.get("Needs approval")).not.toHaveProperty("openQuestion");
      expect(cards.get("Failed")).toMatchObject({
        failure: {
          runId: failedRun,
          workflowName: "Review pull request",
          cause: "permission denied on ops-db",
        },
        openQuestion: { sessionId: failingThread, requestId: "q2" },
        workingSessionId: failingThread,
        lastActivityAt: minute(25),
      });
      expect(cards.get("Run step")).toMatchObject({
        workingSessionId: stepSession,
        threadCount: 0,
      });
      expect(cards.get("Run step")).not.toHaveProperty("openQuestion");
      expect(cards.get("Run step")).toMatchObject({ openSessionId: stepSession });
      expect(cards.get("Orphan")).not.toHaveProperty("projectId");
      expect(cards.get("Plain")).not.toHaveProperty("projectId");
      expect(cards.has("Finished")).toBe(false);
      expect(cards.has("Removed")).toBe(false);
    });
  });

  it("orders the cards by project, then stage, then rank, with a Task of a deleted project among the Tasks that have no project", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const storefront = await insertProject(harness, "Northwind Storefront");
      const archive = await insertProject(harness, "Northwind Archive", AT);

      await insertTask(harness, "none 1", { stage: "planned" });
      const orphan = await insertTask(harness, "orphan", { stage: "planned" });
      await insertTask(harness, "none 2", { stage: "planned" });
      await insertTask(harness, "none building", { stage: "building" });
      await insertTask(harness, "none exploring", { stage: "exploring" });
      await insertTask(harness, "store 1", { stage: "planned", projectId: storefront });
      await insertTask(harness, "store 2", { stage: "planned", projectId: storefront });
      await writeInDatabase(
        harness,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE tasks SET project_id = ${uuidFromString(archive)}
                     WHERE id = ${uuidFromString(orphan)}`;
        }),
      );

      const { cards } = await readBoard(harness.base, token);

      expect(cards.map((card) => card.title)).toEqual([
        "none exploring",
        "none 1",
        "orphan",
        "none 2",
        "none building",
        "store 1",
        "store 2",
      ]);
    });
  });
});
