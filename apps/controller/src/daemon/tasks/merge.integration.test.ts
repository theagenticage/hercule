/**
 * Tests `task.merge` through the task service on real rows, with the real run
 * service and Run Executor (no runner) beside it: what a merge moves, what it
 * carries, how an id of a merged Task is followed, and when a merge is refused.
 *
 * The writers of a Task id that live in the sessions domain are tested beside
 * the sessions that write them: a step session opened after a merge in
 * `daemon/sessions/task-join.steps.integration.test.ts`, and a Thread moved to
 * a merged Task in `sessions/service.integration.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { MAX_TASK_DESCRIPTION_LENGTH, MAX_TASK_LABELS, type Task } from "@hercule/contract";
import { CurrentActor, type Actor } from "../../actor";
import { AfterCommit, mintUuid, uuidFromString, uuidToString, withTransaction } from "../../db";
import { PlatformEventsLayer, EventKindsLayer } from "../../events";
import { readEventsOfKind } from "../../events/testing";
import { SessionTokensLayer } from "../../permissions";
import { EventKindCatalogLayer, PluginHost } from "../../plugins";
import { buildPluginStack, USER } from "../../plugins/testing";
import { ProviderAccountRunnersLayer } from "../../provider-accounts";
import { RunService, RunServiceLayer } from "../../runs";
import { buildHeldAction, waitForHeldExecutions, type HeldAction } from "../../runs/testing";
import { RunWorkspaceStepActivityLayer } from "../../runs/workspace-step-activity";
import { WorkspaceSteps } from "../../runs/workspace-steps";
import { SettingsLayer } from "../../settings";
import { sessionRepository } from "../../sessions";
import {
  TaskService,
  TaskServiceLayer,
  taskRepository,
  TaskTracking,
  TaskTrackingLayer,
} from "../../tasks";
import { TextGeneration } from "../../text-generation";
import { AccountUsageLayer } from "../../usage";
import { WorkflowRuns, WorkflowServiceLayer, WorkflowSignals } from "../../workflows";
import { WorkspaceServiceLayer } from "../../workspaces";
import { RunExecutorLayer, TaskTrackingRunsLayer } from "../runs";
import { TaskLinkOwnersLayer } from "./link-owners";

type Deps = RunService | TaskService | TaskTracking | SqlClient.SqlClient;

/** Runs `body` against a fresh controller on a temporary database, as `actor`, with the held plugin booted. */
const run = <A, E>(body: (held: HeldAction) => Effect.Effect<A, E, Deps>, actor: Actor = USER) => {
  const held = buildHeldAction();
  const layer = RunServiceLayer.pipe(
    Layer.provideMerge(
      WorkflowServiceLayer.pipe(
        Layer.provide(EventKindsLayer.pipe(Layer.provide(EventKindCatalogLayer))),
        Layer.provide(
          Layer.succeed(WorkflowRuns)({ hasUnfinishedRun: () => Effect.succeed(false) }),
        ),
        Layer.provide(Layer.succeed(WorkflowSignals)({ readKind: () => Effect.succeedNone })),
      ),
    ),
    Layer.provideMerge(TaskServiceLayer.pipe(Layer.provide(TaskLinkOwnersLayer))),
    Layer.provideMerge(TaskTrackingLayer.pipe(Layer.provide(TaskTrackingRunsLayer))),
    Layer.provideMerge(
      WorkspaceServiceLayer.pipe(
        Layer.provide(SessionTokensLayer),
        Layer.provide(RunWorkspaceStepActivityLayer),
      ),
    ),
    Layer.provideMerge(SettingsLayer),
    Layer.provideMerge(RunExecutorLayer),
    Layer.provideMerge(PlatformEventsLayer),
    Layer.provideMerge(
      Layer.succeed(WorkspaceSteps)({
        start: () => Effect.void,
        settle: () => undefined,
        openSession: () => Effect.die("these tests run no agent step"),
        stopSessions: () => Effect.void,
      }),
    ),
    Layer.provideMerge(Layer.succeed(AfterCommit)({ publish: () => Effect.void })),
    Layer.provideMerge(
      Layer.succeed(TextGeneration)({
        generate: () => Effect.die("these tests make no model call"),
      }),
    ),
    Layer.provideMerge(ProviderAccountRunnersLayer),
    Layer.provideMerge(AccountUsageLayer),
    Layer.provideMerge(buildPluginStack()),
  );
  return Effect.runPromise(
    Effect.andThen(
      Effect.flatMap(PluginHost, (host) => host.boot([held.plugin])),
      Effect.suspend(() => body(held)),
    ).pipe(
      Effect.provideService(CurrentActor, actor),
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => held.release())),
    ) as Effect.Effect<A, E>,
  );
};

/** A workflow of one step that files a task, so a run of it ends on its own. */
const FILE_DEFINITION = {
  name: "File a task",
  steps: [
    {
      id: "file",
      kind: "action" as const,
      action: "task.create",
      params: { title: "t", description: "" },
    },
  ],
};

/** A workflow whose only step fails: it updates a Task that does not exist. */
const FAIL_DEFINITION = {
  name: "Update a Task that is not there",
  steps: [
    {
      id: "update",
      kind: "action" as const,
      action: "task.update",
      params: { taskId: "0199f0b7-0000-7000-8000-00000000ffff", status: "done" },
    },
  ],
};

const AT = "2026-10-20T10:00:00.000Z";

const waitForRunToEnd = (runId: string) =>
  Effect.gen(function* () {
    const runs = yield* RunService;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const found = yield* runs.read(runId);
      if (found.status !== "pending" && found.status !== "running") return found;
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(`timed out waiting for run ${runId} to end`);
  });

const createTask = (
  title: string,
  fields: { readonly description?: string; readonly labels?: ReadonlyArray<string> } = {},
) =>
  Effect.flatMap(TaskService, (tasks) =>
    tasks.create({
      title,
      description: fields.description ?? "",
      stage: "building",
      priority: "high",
      ...(fields.labels === undefined ? {} : { labels: fields.labels }),
    }),
  );

const merge = (sourceId: string, intoTaskId: string) =>
  Effect.flatMap(TaskService, (tasks) => tasks.merge(sourceId, { intoTaskId }));

/** Makes the run fail on the Task, and returns its id. */
const failRunOn = (taskId: string) =>
  Effect.gen(function* () {
    const runs = yield* RunService;
    const { runId } = yield* runs.startOnTask({ definition: FAIL_DEFINITION }, taskId);
    yield* waitForRunToEnd(runId);
    return runId;
  });

const readFailure = (taskId: string) =>
  Effect.gen(function* () {
    const repository = yield* taskRepository;
    const state = yield* repository.readFailureState(taskId);
    return state._tag === "Some"
      ? { failedRunId: state.value.failedRunId, revision: state.value.failureRevision }
      : undefined;
  });

/** Writes a Thread on the Task and returns its id. */
const insertThread = (taskId: string) =>
  Effect.gen(function* () {
    const sessions = yield* sessionRepository;
    const id = uuidToString(mintUuid());
    yield* withTransaction(
      yield* SqlClient.SqlClient,
      sessions.insert({
        id,
        title: "Look into the refund",
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
        taskId,
        checkoutBranch: undefined,
        githubConnectionId: undefined,
        requestedAccessMode: "approval-required",
        accessMode: "approval-required",
        spec: "{}",
        modelSelection: { model: "clever", options: {} },
        parentSessionId: undefined,
        createdBy: "user",
        at: AT,
      }),
    );
    return id;
  });

/** Returns the Task each of the sessions is on. */
const readSessionTask = (sessionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly task_id: Uint8Array | null }>`
      SELECT task_id FROM sessions WHERE id = ${uuidFromString(sessionId)}`;
    return rows[0]?.task_id == null ? undefined : uuidToString(rows[0].task_id);
  });

/** Returns the Task that `task_workspaces` holds for the workspace. */
const readWorkspaceTask = (workspaceId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly task_id: Uint8Array }>`
      SELECT task_id FROM task_workspaces WHERE workspace_id = ${uuidFromString(workspaceId)}`;
    return rows[0] === undefined ? undefined : uuidToString(rows[0].task_id);
  });

const readUpdatedTitle = (id: string) =>
  Effect.flatMap(TaskService, (tasks) => Effect.map(tasks.read(id), (task) => task.title));

describe("what a merge moves and carries", () => {
  it("moves the sessions, the runs, the workspace and the provenance whole, adds the merge entry, and leaves the survivor's place alone", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const sql = yield* SqlClient.SqlClient;
        const runs = yield* RunService;
        const tracking = yield* TaskTracking;
        const source = yield* createTask("Refund bug", {
          description: "Refunds to a Northwind gift card fail.",
          labels: ["payments", "bug"],
        });
        const survivor = yield* createTask("Refund flow", {
          description: "The refund screen.",
          labels: ["payments", "ux"],
        });
        const sessionId = yield* insertThread(source.id);
        const workspaceId = uuidToString(mintUuid());
        yield* withTransaction(
          sql,
          sql`INSERT INTO task_workspaces (workspace_id, task_id, joined_at)
              VALUES (${uuidFromString(workspaceId)}, ${uuidFromString(source.id)}, ${AT})`,
        );
        // A handoff on the source: its provenance entry names the run.
        const { runId } = yield* runs.startOnTask({ definition: FILE_DEFINITION }, source.id);
        yield* waitForRunToEnd(runId);
        const signalId = uuidToString(mintUuid());
        yield* tasks.recordHandoff({ taskId: source.id, entry: { signalId, runId } });
        const sourceBefore = yield* tasks.read(source.id);
        const survivorBefore = yield* tasks.read(survivor.id);
        const repository = yield* taskRepository;
        const rankBefore = yield* repository.readBoardRank(survivor.id);

        const merged = yield* merge(source.id, survivor.id);

        const legs = yield* tracking.queryLegs([runId]);
        return {
          sourceBefore,
          survivorBefore,
          merged,
          rankBefore,
          rankAfter: yield* repository.readBoardRank(survivor.id),
          sessionTask: yield* readSessionTask(sessionId),
          workspaceTask: yield* readWorkspaceTask(workspaceId),
          runTask: (yield* runs.read(runId)).taskId,
          legs,
          signalId,
          runId,
          audit: yield* readEventsOfKind("task.merged"),
          updated: yield* readEventsOfKind("task.updated"),
          source,
          survivor,
        };
      }),
    );

    expect(result.merged).toMatchObject({
      id: result.survivor.id,
      title: "Refund flow",
      stage: "building",
      priority: "high",
      labels: ["payments", "ux", "bug"],
      description:
        'The refund screen.\n\nMerged from "Refund bug":\nRefunds to a Northwind gift card fail.',
    });
    expect(result.rankAfter).toEqual(result.rankBefore);
    expect(result.sessionTask).toBe(result.survivor.id);
    expect(result.workspaceTask).toBeDefined();
    expect(result.workspaceTask).toBe(result.survivor.id);
    expect(result.runTask).toBe(result.survivor.id);
    // The source's entries moved whole, with their own time and actor, and the
    // survivor gained one entry naming the source.
    const handoff = result.sourceBefore.provenance.find((entry) => entry.signalId !== undefined)!;
    expect(result.merged.provenance).toContainEqual(handoff);
    expect(result.merged.provenance.at(-1)).toMatchObject({
      mergedTaskId: result.source.id,
      actor: "user",
    });
    expect(result.merged.provenance).toHaveLength(
      result.survivorBefore.provenance.length + result.sourceBefore.provenance.length + 1,
    );
    // Tracking finds the handoff on the survivor: the entry and the run moved together.
    expect(result.legs.legs).toHaveLength(1);
    expect(result.legs.legs[0]).toMatchObject({
      runId: result.runId,
      signalId: result.signalId,
      taskId: result.survivor.id,
    });
    // One audit entry names both Tasks, and the survivor's update lists the merge.
    expect(result.audit.map((entry) => entry.payload)).toMatchObject([
      {
        taskId: result.source.id,
        intoTaskId: result.survivor.id,
        snapshot: { id: result.source.id, title: "Refund bug" },
      },
    ]);
    const survivorUpdates = result.updated.filter(
      (event) => event.payload["taskId"] === result.survivor.id,
    );
    expect(survivorUpdates.at(-1)?.payload["changes"]).toMatchObject({
      labels: { added: ["bug"], removed: [] },
      provenance: { added: [expect.objectContaining({ mergedTaskId: result.source.id })] },
    });
  });

  it("appends nothing for a source with no description, and keeps a Task's labels when both carry them", async () => {
    const merged = await run(() =>
      Effect.gen(function* () {
        const source = yield* createTask("Empty", { labels: ["a"] });
        const survivor = yield* createTask("Keeper", { description: "Mine.", labels: ["a"] });
        return yield* merge(source.id, survivor.id);
      }),
    );

    expect(merged).toMatchObject({ description: "Mine.", labels: ["a"] });
  });
});

describe("the failure a merge carries", () => {
  it.each([
    ["only the source failed", "source", "source"],
    ["only the survivor failed", "survivor", "survivor"],
    ["both failed, the survivor's the newer", "source-then-survivor", "survivor"],
    ["both failed, the source's the newer", "survivor-then-source", "source"],
    ["neither failed", "none", "none"],
  ] as const)(
    "when %s, the survivor shows the right one and its revision rises",
    async (_name, arrangement, shows) => {
      const result = await run(() =>
        Effect.gen(function* () {
          const source = yield* createTask("Refund bug");
          const survivor = yield* createTask("Refund flow");
          const runIds: Record<string, string> = {};
          const fail = (which: "source" | "survivor") =>
            Effect.map(failRunOn(which === "source" ? source.id : survivor.id), (id) => {
              runIds[which] = id;
            });
          if (arrangement === "source" || arrangement === "source-then-survivor") {
            yield* fail("source");
          }
          if (arrangement === "survivor" || arrangement === "source-then-survivor") {
            yield* fail("survivor");
          }
          if (arrangement === "survivor-then-source") {
            yield* fail("survivor");
            yield* fail("source");
          }
          const before = yield* readFailure(survivor.id);
          yield* merge(source.id, survivor.id);
          return { runIds, before, after: yield* readFailure(survivor.id) };
        }),
      );

      expect(result.after?.failedRunId).toBe(shows === "none" ? undefined : result.runIds[shows]);
      expect(result.after!.revision).toBeGreaterThan(result.before!.revision);
    },
  );

  it("stops a recovery from before the merge from putting back a failure over the merged one", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const runs = yield* RunService;
        const source = yield* createTask("Refund bug");
        const survivor = yield* createTask("Refund flow");
        yield* failRunOn(survivor.id);
        // A Try again on the survivor ends its failure and leaves a row to restore from.
        const retry = yield* runs.startOnTask({ definition: FILE_DEFINITION }, survivor.id);
        yield* waitForRunToEnd(retry.runId);
        const sourceFailure = yield* failRunOn(source.id);
        yield* merge(source.id, survivor.id);
        const restored = yield* tasks.restoreRecoveredFailure({ runId: retry.runId });
        return { restored, sourceFailure, shown: (yield* readFailure(survivor.id))?.failedRunId };
      }),
    );

    expect(result.restored).toEqual({ restored: false, reason: "handled-since" });
    expect(result.shown).toBe(result.sourceFailure);
  });
});

describe("an id of a merged Task", () => {
  it("reads and updates the survivor, and is gone from the query, the board and the search", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const repository = yield* taskRepository;
        const source = yield* createTask("Refund bug", { description: "gift cards" });
        const survivor = yield* createTask("Refund flow");
        const other = yield* createTask("Update the footer");
        yield* merge(source.id, survivor.id);

        const read = yield* tasks.read(source.id);
        const updated = yield* tasks.update({ id: source.id, title: "Refund flow, renamed" });
        const afterOther = yield* tasks.move({ id: other.id, afterTaskId: source.id });
        const moved = yield* tasks.move({ id: source.id, afterTaskId: other.id });
        const listed = yield* tasks.query({});
        const searched = yield* tasks.query({ text: "gift" });
        const board = yield* repository.listBoardTasks(100);
        return {
          source,
          survivor,
          other,
          read,
          updated,
          afterOther,
          moved,
          listed: listed.items.map((task) => task.id),
          searched: searched.items.map((task) => task.id),
          board: board.map((card) => card.id),
          resolved: yield* tasks.resolveTaskId(source.id),
          title: yield* readUpdatedTitle(survivor.id),
        };
      }),
    );

    expect(result.read.id).toBe(result.survivor.id);
    expect(result.updated).toMatchObject({
      id: result.survivor.id,
      title: "Refund flow, renamed",
    });
    expect(result.title).toBe("Refund flow, renamed");
    // A move that names the merged Task as a neighbour follows it too, and the
    // moved Task is never its own neighbour.
    expect(result.afterOther.id).toBe(result.other.id);
    expect(result.moved.id).toBe(result.survivor.id);
    expect(result.listed).not.toContain(result.source.id);
    expect(result.listed).toContain(result.survivor.id);
    expect(result.searched).not.toContain(result.source.id);
    expect(result.board).not.toContain(result.source.id);
    expect(result.board).toContain(result.survivor.id);
    expect(result.resolved).toBe(result.survivor.id);
  });

  it("follows one hop after two merges: A into B, then B into C", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const sql = yield* SqlClient.SqlClient;
        const a = yield* createTask("A");
        const b = yield* createTask("B");
        const c = yield* createTask("C");
        yield* merge(a.id, b.id);
        yield* merge(b.id, c.id);
        const rows = yield* sql<{ readonly id: Uint8Array; readonly merged_into_id: Uint8Array }>`
          SELECT id, merged_into_id FROM tasks WHERE merged_into_id IS NOT NULL`;
        return {
          a,
          b,
          c,
          resolvedA: yield* tasks.resolveTaskId(a.id),
          resolvedB: yield* tasks.resolveTaskId(b.id),
          readA: (yield* tasks.read(a.id)).id,
          pointers: rows.map((row) => [uuidToString(row.id), uuidToString(row.merged_into_id)]),
        };
      }),
    );

    expect(result.resolvedA).toBe(result.c.id);
    expect(result.resolvedB).toBe(result.c.id);
    expect(result.readA).toBe(result.c.id);
    expect(result.pointers).toEqual(
      expect.arrayContaining([
        [result.a.id, result.c.id],
        [result.b.id, result.c.id],
      ]),
    );
  });

  it("is refused by delete, naming the survivor, and leaves the survivor alone", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const source = yield* createTask("Refund bug");
        const survivor = yield* createTask("Refund flow");
        yield* merge(source.id, survivor.id);
        const refusal = yield* Effect.flip(tasks.delete(source.id));
        return { refusal, survivor, stillThere: (yield* tasks.read(survivor.id)).id };
      }),
    );

    expect(result.refusal).toMatchObject({ error: { code: "not_found" } });
    expect(JSON.stringify(result.refusal)).toContain(
      `merged into Refund flow (${result.survivor.id}); delete that task if you mean it`,
    );
    expect(result.stillThere).toBe(result.survivor.id);
  });
});

describe("the repoint of the Tasks merged into the source", () => {
  it("reads the partial index of merged Tasks, not the whole table", async () => {
    const plan = await run(() =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* taskRepository;
        const statements: Array<readonly [string, ReadonlyArray<unknown>]> = [];
        yield* withTransaction(
          sql,
          tasks.markMerged(uuidToString(mintUuid()), uuidToString(mintUuid())),
        ).pipe(
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
      }),
    );

    expect(plan.join("\n")).toContain("USING INDEX tasks_merged_into");
  });
});

describe("a writer that reads a Task id before a merge and writes after it", () => {
  it("starts and re-runs a run on the survivor, whichever id it holds", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const runs = yield* RunService;
        const source = yield* createTask("Refund bug");
        const survivor = yield* createTask("Refund flow");
        const original = yield* runs.startOnTask({ definition: FILE_DEFINITION }, source.id);
        yield* waitForRunToEnd(original.runId);
        yield* merge(source.id, survivor.id);

        const started = yield* runs.startOnTask({ definition: FILE_DEFINITION }, source.id);
        const replayed = yield* runs.rerun(original.runId, { mode: "replay" });
        const restamped = yield* runs
          .rerun(started.runId, { mode: "re-stamp" })
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        const ended = yield* Effect.forEach(
          [started.runId, replayed.runId, ...(restamped === undefined ? [] : [restamped.runId])],
          waitForRunToEnd,
        );
        return {
          survivor,
          ended: ended.map((one) => one.taskId),
          original: yield* runs.read(original.runId),
        };
      }),
    );

    expect(result.original.taskId).toBe(result.survivor.id);
    expect(result.ended.every((taskId) => taskId === result.survivor.id)).toBe(true);
  });

  it("lets a workflow that is running when the Task is merged update the survivor with the old id", async () => {
    const result = await run((held) =>
      Effect.gen(function* () {
        const runs = yield* RunService;
        const source = yield* createTask("Refund bug");
        const survivor = yield* createTask("Refund flow");
        const { runId } = yield* runs.startOnTask(
          {
            definition: {
              name: "Wait, then rename",
              steps: [
                { id: "wait", kind: "action", action: held.actionId, params: { label: "wait" } },
                {
                  id: "rename",
                  kind: "action",
                  action: "task.update",
                  params: { taskId: source.id, title: "Renamed by the workflow" },
                },
              ],
              edges: [{ from: "wait", to: "rename" }],
            },
          },
          source.id,
        );
        yield* Effect.promise(() => waitForHeldExecutions(held, 1));
        yield* merge(source.id, survivor.id);
        held.release();
        const ended = yield* waitForRunToEnd(runId);
        return { ended, title: yield* readUpdatedTitle(survivor.id), survivor };
      }),
    );

    expect(result.ended).toMatchObject({ status: "completed", taskId: result.survivor.id });
    expect(result.title).toBe("Renamed by the workflow");
  });
});

describe("the join rule, after a merge", () => {
  it("joins the survivor for a Thread named onto, spawned from, or reopened on the merged Task", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const source = yield* createTask("Refund bug");
        const survivor = yield* createTask("Refund flow");
        yield* merge(source.id, survivor.id);
        const input = {
          workspaceId: null,
          sessionKind: "thread" as const,
          title: "A Thread",
          projectId: undefined,
        };
        const named = yield* tasks.joinSession({
          ...input,
          requestedTaskId: source.id,
          callerTaskId: undefined,
        });
        const spawned = yield* tasks.joinSession({
          ...input,
          requestedTaskId: undefined,
          callerTaskId: source.id,
        });
        const reopened = yield* tasks.rejoinThread({
          currentTaskId: source.id,
          workspaceId: null,
          title: "A Thread",
          projectId: undefined,
          actor: "user",
        });
        return { survivor, named, spawned, reopened };
      }),
    );

    expect(result.named).toEqual({ taskId: result.survivor.id, created: false });
    expect(result.spawned).toEqual({ taskId: result.survivor.id, created: false });
    expect(result.reopened).toBe(result.survivor.id);
  });

  it("never renames the survivor with the generated title of a Thread whose Task was merged away", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        // The survivor has the title the generated one replaces, so only the merged check of
        // the title adoption keeps it from being renamed.
        const survivor = yield* createTask("a session");
        const made = yield* tasks.joinSession({
          requestedTaskId: undefined,
          callerTaskId: undefined,
          workspaceId: null,
          sessionKind: "thread",
          title: "a session",
          projectId: undefined,
        });
        yield* merge(made!.taskId, survivor.id);
        const updatesBefore = (yield* readEventsOfKind("task.updated")).length;
        yield* tasks.adoptGeneratedTitle({
          taskId: made!.taskId,
          from: "a session",
          to: "Fix the refund bug",
        });
        return {
          survivor,
          title: yield* readUpdatedTitle(survivor.id),
          newUpdates: (yield* readEventsOfKind("task.updated")).length - updatesBefore,
        };
      }),
    );

    expect(result.title).toBe("a session");
    expect(result.newUpdates).toBe(0);
  });
});

describe("a summary", () => {
  it("that is being written for the source is dropped, the source keeps none, and the survivor is marked to be written", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const sql = yield* SqlClient.SqlClient;
        const source = yield* createTask("Refund bug");
        const survivor = yield* createTask("Refund flow");
        yield* tasks.markSummaryDirty(source.id);
        // Long enough ago for the writer to take it.
        yield* withTransaction(
          sql,
          sql`UPDATE task_summaries SET dirty_at = '2020-01-01T00:00:00.000Z'`,
        );
        const [attempt] = yield* tasks.claimSummaryAttempts({ limit: 5 });
        yield* merge(source.id, survivor.id);
        const stored = yield* tasks.storeSummary({
          taskId: attempt!.taskId,
          dirtyRevision: attempt!.dirtyRevision,
          summary: { line: "Refunds fail", standing: "Found.", left: "A fix." },
        });
        const failed = yield* tasks.failSummary({
          taskId: attempt!.taskId,
          dirtyRevision: attempt!.dirtyRevision,
          reason: "timeout",
        });
        const rows = yield* sql<{ readonly task_id: Uint8Array; readonly dirty_at: string | null }>`
          SELECT task_id, dirty_at FROM task_summaries`;
        return {
          claimed: attempt!.taskId,
          source,
          survivor,
          stored,
          failed,
          rows: rows.map((row) => [uuidToString(row.task_id), row.dirty_at !== null]),
        };
      }),
    );

    expect(result.claimed).toBe(result.source.id);
    expect(result.stored).toBe(false);
    expect(result.failed).toBe(false);
    expect(result.rows).toEqual([[result.survivor.id, true]]);
  });
});

describe("the survivor's summary", () => {
  it.each([
    ["with its description changed by the merge", "Refunds fail", "Refunds fail on gift cards"],
    ["with its description kept", "", "Refunds fail on gift cards"],
  ])("is marked as out of date once, %s", async (_name, sourceDescription, survivorDescription) => {
    const raised = await run(() =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const source = yield* createTask("Refund bug", { description: sourceDescription });
        const survivor = yield* createTask("Refund flow", { description: survivorDescription });
        const readRevision = Effect.map(
          sql<{ readonly dirty_revision: number }>`
            SELECT dirty_revision FROM task_summaries WHERE task_id = ${uuidFromString(survivor.id)}`,
          (rows) => rows[0]?.dirty_revision ?? 0,
        );
        const before = yield* readRevision;
        yield* merge(source.id, survivor.id);
        return (yield* readRevision) - before;
      }),
    );

    expect(raised).toBe(1);
  });
});

describe("a merge is refused", () => {
  /** Runs `attempt` and returns its error, and whether the source was left unmerged. */
  const refusedWith = (
    arrange: (
      source: Task,
      survivor: Task,
    ) => Effect.Effect<{ readonly sourceId: string; readonly intoTaskId: string }, unknown, Deps>,
  ) =>
    run(() =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const source = yield* createTask("Refund bug");
        const survivor = yield* createTask("Refund flow");
        const { sourceId, intoTaskId } = yield* arrange(source, survivor);
        const error = yield* Effect.flip(merge(sourceId, intoTaskId));
        return {
          error: error as { readonly error: { readonly code: string; readonly message: string } },
          sourceStillThere: (yield* tasks.read(source.id)).id === source.id,
        };
      }),
    );

  it.each([
    [
      "the same Task",
      (source: Task) => Effect.succeed({ sourceId: source.id, intoTaskId: source.id }),
      "validation",
      "itself",
    ],
    [
      "a Task that does not exist",
      (source: Task) =>
        Effect.succeed({ sourceId: source.id, intoTaskId: "0199f0b7-0000-7000-8000-00000000ffff" }),
      "not_found",
      "no such task",
    ],
    [
      "a source that does not exist",
      (source: Task) =>
        Effect.succeed({ sourceId: "0199f0b7-0000-7000-8000-00000000ffff", intoTaskId: source.id }),
      "not_found",
      "no such task",
    ],
  ])("for %s", async (_name, arrange, code, message) => {
    const result = await refusedWith((source) => arrange(source));
    expect(result.error.error).toMatchObject({ code });
    expect(JSON.stringify(result.error)).toContain(message);
  });

  it("for a deleted Task, on either side", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const live = yield* createTask("Refund bug");
        const deleted = yield* createTask("Refund flow");
        yield* tasks.delete(deleted.id);
        return [
          yield* Effect.flip(merge(live.id, deleted.id)),
          yield* Effect.flip(merge(deleted.id, live.id)),
        ];
      }),
    );

    expect(result).toMatchObject([
      { error: { code: "not_found" } },
      { error: { code: "not_found" } },
    ]);
  });

  it("for a Task that was merged already, on either side, saying where it went", async () => {
    const result = await run(() =>
      Effect.gen(function* () {
        const a = yield* createTask("A");
        const b = yield* createTask("B");
        const c = yield* createTask("C");
        yield* merge(a.id, b.id);
        return [yield* Effect.flip(merge(a.id, c.id)), yield* Effect.flip(merge(c.id, a.id))];
      }),
    );

    for (const error of result) {
      expect(error).toMatchObject({ error: { code: "validation" } });
      expect(JSON.stringify(error)).toContain("already merged");
    }
  });

  it.each(["done", "dropped"] as const)(
    "for a Task at %s, on either side, saying to reopen it",
    async (stage) => {
      const result = await run(() =>
        Effect.gen(function* () {
          const tasks = yield* TaskService;
          const live = yield* createTask("Refund bug");
          const finished = yield* createTask("Refund flow");
          yield* tasks.update({ id: finished.id, stage });
          return [
            yield* Effect.flip(merge(live.id, finished.id)),
            yield* Effect.flip(merge(finished.id, live.id)),
          ];
        }),
      );

      for (const error of result) {
        expect(error).toMatchObject({ error: { code: "invalid_state" } });
        expect(JSON.stringify(error)).toContain("reopen");
      }
    },
  );

  it("when the labels together are more than a Task may carry, saying what to do", async () => {
    const label = (prefix: string, n: number) => `${prefix}-${String(n)}`;
    const result = await refusedWith((source, survivor) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        yield* tasks.update({
          id: source.id,
          addLabels: Array.from({ length: 40 }, (_, n) => label("a", n)),
        });
        yield* tasks.update({
          id: survivor.id,
          addLabels: Array.from({ length: 40 }, (_, n) => label("b", n)),
        });
        return { sourceId: source.id, intoTaskId: survivor.id };
      }),
    );

    expect(result.error.error.code).toBe("validation");
    expect(result.error.error.message + JSON.stringify(result.error)).toContain(
      String(MAX_TASK_LABELS),
    );
    expect(JSON.stringify(result.error)).toContain("remove some labels");
    expect(result.sourceStillThere).toBe(true);
  });

  it("when the descriptions together are longer than a Task may hold, saying what to do", async () => {
    const result = await refusedWith((source, survivor) =>
      Effect.gen(function* () {
        const tasks = yield* TaskService;
        const long = "x".repeat(MAX_TASK_DESCRIPTION_LENGTH - 100);
        yield* tasks.update({ id: source.id, description: long });
        yield* tasks.update({ id: survivor.id, description: long });
        return { sourceId: source.id, intoTaskId: survivor.id };
      }),
    );

    expect(result.error.error.code).toBe("validation");
    expect(JSON.stringify(result.error)).toContain("shorten the description");
  });

  it("for a session, which may not merge even when it holds the grant", async () => {
    const session: Actor = {
      _tag: "session",
      sessionId: "0199e0e7-0002-7000-8000-000000000000",
      profileId: "0199e0e7-0003-7000-8000-000000000000",
      grants: ["task.update", "task.read", "task.create"],
      profileGrants: ["task.update", "task.read", "task.create"],
      assistantId: null,
      agentId: null,
    };
    // The refusal comes before either Task is read, so the ids need no rows.
    const error = await run(
      () =>
        Effect.flip(
          merge("0199f0b7-0000-7000-8000-00000000a001", "0199f0b7-0000-7000-8000-00000000a002"),
        ),
      session,
    );

    expect(error).toMatchObject({ error: { code: "forbidden" } });
  });
});
