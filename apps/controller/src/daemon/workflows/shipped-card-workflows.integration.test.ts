/**
 * Tests the two shipped card workflows end to end on a running controller,
 * with nothing stubbed: a Task links a pull request, the entity write records
 * a fact, the Event Router matches the shipped trigger, a real run executes
 * `task.update`, and the Task's stage changes.
 *
 * It also checks that `{{ inputs.fact_id }}` reaches `task.update` as a whole
 * number: the CEL expression that maps the event yields a bigint, and the
 * template renders it as a JSON number.
 *
 * A test that expects no run waits until the router has passed every event,
 * not for something to happen.
 */
import { describe, expect, it, vi } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Run, Task } from "@hercule/contract";
import { mintUuid, uuidFromString, withTransaction } from "../../db";
import { get, post, send, type ServerHarness } from "../../http/testing";
import { queryRuns, waitForRunToFinish } from "../../runs/testing";
import { waitUntil, WAIT_DEADLINE_MS } from "../../sessions/testing";
import { SHIPPED_WORKFLOWS } from "../../workflows";
import { TaskService } from "../../tasks";
import {
  ACCEPTED_GITHUB_TOKEN,
  createConnection,
  queryWorkflows,
  withSetUpController,
  type SetUpController,
} from "../../workflows/testing";
import { runEffect, waitUntilCaughtUp } from "../testing";
import { installShippedWorkflows, installShippedWorkflowsOrLog } from "./shipped-workflows";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS + 20_000 });

const PULL_REQUEST_REF = "github:pr:northwind/market#6221";
const AGENT_PULL_REQUEST_REF = "github:pr:northwind/market#6222";

const withCardController = (body: (controller: SetUpController) => Promise<void>) =>
  withSetUpController(body, [], { eventRoutingInterval: Duration.millis(10) });

interface Arranged {
  readonly controller: SetUpController;
  readonly connectionId: string;
  readonly inReviewId: string;
  readonly landedId: string;
}

/** Installs the shipped workflows on a controller that has a GitHub Connection, and finds them. */
const installShipped = async (controller: SetUpController): Promise<Arranged> => {
  const { harness, base, token } = controller;
  const connectionId = await createConnection(base, token, "github/github", {
    pat: ACCEPTED_GITHUB_TOKEN,
  });
  const exit = await harness.runWithShippedWorkflowServices(
    installShippedWorkflows(SHIPPED_WORKFLOWS),
  );
  expect(exit._tag).toBe("Success");
  const items = (await queryWorkflows(base, token)).items;
  const find = (fragment: string): string => items.find((one) => one.name.includes(fragment))!.id;
  return { controller, connectionId, inReviewId: find("In review"), landedId: find("Landed") };
};

const createTask = async (
  { base, token }: SetUpController,
  title: string,
  ...refs: ReadonlyArray<string>
): Promise<Task> => {
  const response = await post(
    base,
    "/api/v1/tasks",
    { title, description: "", provenance: refs.map((ref) => ({ ref })) },
    token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Task;
};

const readTask = async ({ base, token }: SetUpController, id: string): Promise<Task> => {
  const response = await get(base, `/api/v1/tasks/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Task;
};

/**
 * Plays an entity write as the ingest does: takes the snapshot of the linked
 * refs, runs `change`, and records the facts, all in one transaction.
 */
const writeEntity = (
  harness: ServerHarness,
  ref: string,
  change: (sql: SqlClient.SqlClient) => Effect.Effect<unknown, unknown>,
): Promise<void> =>
  harness
    .runWithShippedWorkflowServices(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tasks = yield* TaskService;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const snapshot = yield* tasks.snapshotLinkedEntities([ref]);
            yield* change(sql);
            yield* tasks.recordEntityFacts(snapshot);
          }),
        );
      }),
    )
    .then((exit) => expect(exit._tag, JSON.stringify(exit)).toBe("Success"));

/** Stores a pull request the Connection reads, with its lifecycle. */
const storePullRequest = (
  harness: ServerHarness,
  connectionId: string,
  ref: string,
  lifecycle: "open" | "completed" | "abandoned",
): Promise<void> =>
  writeEntity(harness, ref, (sql) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO external_entities
          (id, ref, kind, noun, pace, completeness, title, lifecycle, first_observed_at, updated_at)
        VALUES (${mintUuid()}, ${ref}, 'github/pull-request', 'Pull request', 'fast', 'full',
                'Cart badge counts twice', ${lifecycle}, '2026-03-01T00:00:00.000Z',
                '2026-03-01T00:00:00.000Z')`;
      yield* sql`
        INSERT INTO external_entity_observations (ref, connection_id, access)
        VALUES (${ref}, ${uuidFromString(connectionId)}, 'ok')`;
    }),
  );

const changeLifecycle = (
  harness: ServerHarness,
  ref: string,
  lifecycle: "open" | "completed" | "abandoned",
): Promise<void> =>
  writeEntity(
    harness,
    ref,
    (sql) => sql`UPDATE external_entities SET lifecycle = ${lifecycle} WHERE ref = ${ref}`,
  );

/** Waits until the workflow has `count` runs, all finished, and returns them oldest first. */
const waitForFinishedRuns = async (
  { base, token }: SetUpController,
  workflowId: string,
  count: number,
): Promise<ReadonlyArray<Run>> => {
  const ids = await waitUntil(`${count} runs of the workflow ${workflowId}`, async () => {
    const page = await queryRuns(base, token, `workflowId=${workflowId}`);
    return page.items.length >= count ? page.items.map((run) => run.id) : undefined;
  });
  return Promise.all(ids.map((id) => waitForRunToFinish(base, token, id)));
};

const countRuns = async ({ base, token }: SetUpController, workflowId: string): Promise<number> =>
  (await queryRuns(base, token, `workflowId=${workflowId}`)).items.length;

const countFacts = async (harness: ServerHarness): Promise<number> =>
  (await runEffect(harness.sql<{ n: number }>`SELECT count(*) AS n FROM task_entity_facts`))[0]!.n;

describe("the shipped card workflows", () => {
  it("move a card to In review when its pull request opens, and to Landed when it merges", async () => {
    await withCardController(async (controller) => {
      const { harness } = controller;
      const { connectionId, inReviewId, landedId } = await installShipped(controller);
      const task = await createTask(controller, "Fix the cart badge", PULL_REQUEST_REF);

      await storePullRequest(harness, connectionId, PULL_REQUEST_REF, "open");

      const [opened] = await waitForFinishedRuns(controller, inReviewId, 1);
      expect(opened!.status).toBe("completed");
      // The fact's id is a whole number all the way to `task.update`.
      const factId = opened!.inputs["fact_id"];
      expect(Number.isInteger(factId)).toBe(true);
      expect(opened!.inputs["task_id"]).toBe(task.id);
      expect((await readTask(controller, task.id)).stage).toBe("in-review");

      await changeLifecycle(harness, PULL_REQUEST_REF, "completed");

      const [landing] = await waitForFinishedRuns(controller, landedId, 1);
      expect(landing!.status).toBe("completed");
      expect(Number.isInteger(landing!.inputs["fact_id"])).toBe(true);
      expect((await readTask(controller, task.id)).stage).toBe("landed");
      // The merge is not an open pull request, so the first workflow stayed out of it.
      await waitUntilCaughtUp(harness);
      expect(await countRuns(controller, inReviewId)).toBe(1);
    });
  });

  it("leave a card alone while something it links is still open", async () => {
    await withCardController(async (controller) => {
      const { harness } = controller;
      const { connectionId, landedId } = await installShipped(controller);
      const task = await createTask(
        controller,
        "Fix the cart badge",
        PULL_REQUEST_REF,
        AGENT_PULL_REQUEST_REF,
      );
      await storePullRequest(harness, connectionId, PULL_REQUEST_REF, "open");
      await storePullRequest(harness, connectionId, AGENT_PULL_REQUEST_REF, "open");

      await changeLifecycle(harness, PULL_REQUEST_REF, "completed");

      // The merge carries openLinks 1, so the filter of the second workflow does not match.
      await waitUntilCaughtUp(harness);
      expect(await countRuns(controller, landedId)).toBe(0);
      expect((await readTask(controller, task.id)).stage).not.toBe("landed");

      await changeLifecycle(harness, AGENT_PULL_REQUEST_REF, "completed");

      await waitForFinishedRuns(controller, landedId, 1);
      expect((await readTask(controller, task.id)).stage).toBe("landed");
    });
  });

  // Passes only with the fence in `TaskService.update`: the run carries an
  // old `stageFactId`, so the update must change nothing.
  it("do not undo a drag when a run is played again", async () => {
    await withCardController(async (controller) => {
      const { harness, base, token } = controller;
      const { connectionId, landedId } = await installShipped(controller);
      const task = await createTask(controller, "Fix the cart badge", PULL_REQUEST_REF);
      await storePullRequest(harness, connectionId, PULL_REQUEST_REF, "completed");
      const [landing] = await waitForFinishedRuns(controller, landedId, 1);
      expect((await readTask(controller, task.id)).stage).toBe("landed");

      // The person drags the card back, then the same run plays again with the same fact.
      const dragged = await send("PATCH", base, `/api/v1/tasks/${task.id}`, {
        body: { stage: "in-review" },
        token,
      });
      expect(dragged.status, await dragged.clone().text()).toBe(200);
      const rerun = await post(base, `/api/v1/runs/${landing!.id}/rerun`, {}, token);
      expect(rerun.status, await rerun.clone().text()).toBe(200);
      await waitForFinishedRuns(controller, landedId, 2);

      expect((await readTask(controller, task.id)).stage).toBe("in-review");
    });
  });
});

describe("the first install", () => {
  it("corrects a card whose pull request was linked before the workflows existed, and only once", async () => {
    await withCardController(async (controller) => {
      const { harness, base, token } = controller;
      const connectionId = await createConnection(base, token, "github/github", {
        pat: ACCEPTED_GITHUB_TOKEN,
      });
      const task = await createTask(controller, "Fix the cart badge", PULL_REQUEST_REF);
      await storePullRequest(harness, connectionId, PULL_REQUEST_REF, "open");
      // The router has passed the events of the link and the write, so none of
      // them can start a run of a workflow that does not exist yet.
      await waitUntilCaughtUp(harness);
      const factsBefore = await countFacts(harness);

      await harness.runWithShippedWorkflowServices(installShippedWorkflows(SHIPPED_WORKFLOWS));

      const inReview = (await queryWorkflows(base, token)).items.find((one) =>
        one.name.includes("In review"),
      )!;
      await waitForFinishedRuns(controller, inReview.id, 1);
      expect((await readTask(controller, task.id)).stage).toBe("in-review");
      expect(await countFacts(harness)).toBe(factsBefore + 1);

      // A later start installs nothing, so it writes no fact that could undo a drag.
      await harness.runWithShippedWorkflowServices(installShippedWorkflows(SHIPPED_WORKFLOWS));
      expect(await countFacts(harness)).toBe(factsBefore + 1);
    });
  });

  it("leaves nothing when the reconciliation fails, and the next start installs everything", async () => {
    await withCardController(async (controller) => {
      const { harness, base, token } = controller;
      const connectionId = await createConnection(base, token, "github/github", {
        pat: ACCEPTED_GITHUB_TOKEN,
      });
      await createTask(controller, "Fix the cart badge", PULL_REQUEST_REF);
      await storePullRequest(harness, connectionId, PULL_REQUEST_REF, "open");
      await waitUntilCaughtUp(harness);
      const factsBefore = await countFacts(harness);
      const eventsBefore = (await harness.platformEvents("task.entityChanged")).length;

      // The reconciliation writes its facts, then the process dies before the commit.
      const crashAfterReconciling = Effect.flatMap(TaskService, (tasks) =>
        installShippedWorkflows(SHIPPED_WORKFLOWS).pipe(
          Effect.provideService(TaskService, {
            ...tasks,
            recordFirstInstallFacts: () =>
              Effect.andThen(tasks.recordFirstInstallFacts(), Effect.die("crash")),
          }),
        ),
      );
      expect((await harness.runWithShippedWorkflowServices(crashAfterReconciling))._tag).toBe(
        "Failure",
      );
      // At boot the same failure is logged, and the boot goes on.
      const bootAfterCrash = await harness.runWithShippedWorkflowServices(
        Effect.flatMap(TaskService, (tasks) =>
          installShippedWorkflowsOrLog(SHIPPED_WORKFLOWS).pipe(
            Effect.provideService(TaskService, {
              ...tasks,
              recordFirstInstallFacts: () => Effect.die("crash"),
            }),
          ),
        ),
      );
      expect(bootAfterCrash._tag).toBe("Success");

      expect((await queryWorkflows(base, token)).items).toEqual([]);
      expect(await runEffect(harness.sql`SELECT key FROM shipped_workflows`)).toEqual([]);
      expect(await countFacts(harness)).toBe(factsBefore);
      expect(await harness.platformEvents("task.entityChanged")).toHaveLength(eventsBefore);

      await harness.runWithShippedWorkflowServices(installShippedWorkflows(SHIPPED_WORKFLOWS));

      expect((await queryWorkflows(base, token)).items).toHaveLength(2);
      expect(await countFacts(harness)).toBe(factsBefore + 1);
    });
  });
});
