/**
 * Test helpers for the run engine's integration tests: starting a run, waiting
 * for it to finish, the checks every finished run must pass, sample workflows,
 * and a plugin action a test can hold open.
 *
 * Everything runs against a real controller over HTTP, because a run is only
 * observable through the API.
 */
import { expect } from "vitest";
import { Effect, Schema } from "effect";
import type { ActionContext, Plugin } from "@hercule/plugin-host";
import type { Issue, Run, RunStatus, StepRecord, Task } from "@hercule/contract";
import { get, post, type ServerHarness } from "../../http/testing";
import { buildActionPlugin, createPluginFixture } from "../../plugins/testing";
import type { RunPage } from "../../runs";
import { waitUntil, withFleet as sharedWithFleet, type Arranged } from "../../sessions/testing";
import { readIssues } from "../../workflows/testing";
import { FACTS, MODELS, PROVIDER, runEffect } from "../testing";

const FINAL_STATUSES: ReadonlyArray<RunStatus> = ["completed", "failed", "cancelled"];

/**
 * How far along a status is. A run or a step record may only move to a status
 * with a higher rank, and once final it never changes again.
 */
const STATUS_RANK: Record<RunStatus, number> = {
  pending: 0,
  running: 1,
  completed: 2,
  failed: 2,
  cancelled: 2,
};

/** Sends `run.start` with `body` as it is, and returns the response. */
export const requestStart = (base: string, token: string, body: unknown) =>
  post(base, "/api/v1/runs/start", body, token);

/** Sends `run.start` for a stored workflow, with `body`'s other fields such as `inputs`. */
export const requestRun = (
  base: string,
  token: string,
  workflowId: string,
  body: Record<string, unknown> = {},
) => requestStart(base, token, { workflowId, ...body });

/**
 * Starts a run of a stored workflow and returns its id. Fails the test if the
 * request is refused, or if the response holds anything but the run id.
 */
export const startRun = async (
  base: string,
  token: string,
  workflowId: string,
  body: Record<string, unknown> = {},
): Promise<string> => {
  const response = await requestRun(base, token, workflowId, body);
  expect(response.status, await response.clone().text()).toBe(200);
  const started = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(started)).toEqual(["runId"]);
  expect(started["runId"]).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  return started["runId"] as string;
};

export const readRun = async (base: string, token: string, id: string): Promise<Run> => {
  const response = await get(base, `/api/v1/runs/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Run;
};

/** Fails the test if any status moved backwards between two reads of the same run. */
const expectMovedForward = (earlier: Run, later: Run): void => {
  const describeMove = (what: string, from: RunStatus, to: RunStatus) =>
    `${what} went from ${from} to ${to}`;
  expect(
    STATUS_RANK[later.status],
    describeMove("the run", earlier.status, later.status),
  ).toBeGreaterThanOrEqual(STATUS_RANK[earlier.status]);
  if (FINAL_STATUSES.includes(earlier.status)) {
    expect(later.status, describeMove("the finished run", earlier.status, later.status)).toBe(
      earlier.status,
    );
  }
  for (const before of earlier.steps) {
    const what = `step record ${before.stepId}#${String(before.iteration)}`;
    const after = later.steps.find(
      (record) => record.stepId === before.stepId && record.iteration === before.iteration,
    );
    expect(after, `${what} disappeared`).toBeDefined();
    expect(
      STATUS_RANK[after!.status],
      describeMove(what, before.status, after!.status),
    ).toBeGreaterThanOrEqual(STATUS_RANK[before.status]);
    if (FINAL_STATUSES.includes(before.status)) {
      expect(after!.status, describeMove(what, before.status, after!.status)).toBe(before.status);
    }
  }
};

/**
 * Returns `value` narrowed to `status`. Fails the test when `value` is
 * missing or has another status, so a test can read the fields that only that
 * status has.
 */
export const expectStatus = <T extends { readonly status: string }, S extends T["status"]>(
  value: T | undefined,
  status: S,
): Extract<T, { readonly status: S }> => {
  expect(value?.status, JSON.stringify(value)).toBe(status);
  return value as Extract<T, { readonly status: S }>;
};

/**
 * Checks what every finished run keeps true:
 * - its status is final, and it has a failure reason exactly when it failed;
 * - none of its step records is still `pending` or `running`;
 * - the first record of every step has iteration 1;
 * - every timestamp is at or after the one before it.
 */
const expectFinishedRun = (run: Run): void => {
  const where = `run ${run.id}: ${JSON.stringify(run)}`;
  if (run.status === "pending" || run.status === "running") {
    expect.fail(`the run has not finished: ${where}`);
  }
  expect("failureReason" in run, where).toBe(run.status === "failed");
  expect(run.finishedAt >= run.createdAt, where).toBe(true);
  if (run.startedAt !== undefined) {
    expect(run.startedAt >= run.createdAt, where).toBe(true);
    expect(run.finishedAt >= run.startedAt, where).toBe(true);
  }
  for (const record of run.steps) {
    if (record.status === "pending" || record.status === "running") {
      expect.fail(`step record ${record.stepId} has not finished: ${where}`);
    }
    if (record.startedAt !== undefined) {
      expect(record.finishedAt >= record.startedAt, where).toBe(true);
    }
  }
  const stepIds = new Set(run.steps.map((record) => record.stepId));
  for (const stepId of stepIds) {
    const iterations = run.steps
      .filter((record) => record.stepId === stepId)
      .map((record) => record.iteration);
    expect(Math.min(...iterations), `${stepId} in ${where}`).toBe(1);
  }
};

/**
 * Reads the run over and over until its status is final, and returns the
 * final read. Every read is compared with the read before it, and the final
 * read is checked with `expectFinishedRun`.
 */
export const waitForRunToFinish = async (base: string, token: string, id: string): Promise<Run> => {
  let previous: Run | undefined;
  const finished = await waitUntil(`finished run ${id}`, async () => {
    const run = await readRun(base, token, id);
    if (previous !== undefined) expectMovedForward(previous, run);
    previous = run;
    return FINAL_STATUSES.includes(run.status) ? run : undefined;
  });
  expectFinishedRun(finished);
  return finished;
};

/**
 * Returns how many runs the database holds, read from the table directly:
 * `run.query` pages its answer, and a refusal test needs the whole count.
 */
export const countRuns = async (harness: ServerHarness): Promise<number> => {
  const rows = await runEffect(
    harness.sql<{ readonly count: number }>`SELECT count(*) AS count FROM runs`,
  );
  return rows[0]!.count;
};

/**
 * Checks that the run request was refused with `validation`, with one issue
 * whose path starts with each of `prefixes` and no other issue, and that no
 * run was created. Returns the issues.
 */
export const expectRefusedAt = async (
  harness: ServerHarness,
  response: Response,
  prefixes: ReadonlyArray<ReadonlyArray<string>>,
  description = "the run request",
): Promise<ReadonlyArray<Issue>> => {
  const issues = await readIssues(response);
  const shown = `${description}: ${JSON.stringify(issues)}`;
  expect(issues, shown).toHaveLength(prefixes.length);
  for (const prefix of prefixes) {
    const matching = issues.filter((issue) =>
      prefix.every((segment, index) => issue.path[index] === segment),
    );
    expect(matching, `one issue under ${JSON.stringify(prefix)} in ${shown}`).toHaveLength(1);
  }
  expect(await countRuns(harness), description).toBe(0);
  return issues;
};

export const readTask = async (base: string, token: string, id: string): Promise<Task> => {
  const response = await get(base, `/api/v1/tasks/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Task;
};

export const listTasks = async (base: string, token: string): Promise<ReadonlyArray<Task>> => {
  const response = await get(base, "/api/v1/tasks", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Task> }).items;
};

/** Returns the step records of one step, in the order the run created them. */
export const findStepRecords = (run: Run, stepId: string): ReadonlyArray<StepRecord> =>
  run.steps.filter((record) => record.stepId === stepId);

/* ------------------------------------------------------------------------ */
/* Workflow definitions for the run tests.                                   */
/* ------------------------------------------------------------------------ */

/**
 * Two steps: the first creates a task titled from the `title` input, the
 * second moves that task to in-progress. The second step reads the task id
 * from the first step's output.
 */
export const FILE_AND_START_DEFINITION = {
  name: "File and start a task",
  inputs: [{ name: "title", schema: { type: "string", minLength: 1 }, required: true }],
  steps: [
    {
      id: "create",
      kind: "action",
      action: "task.create",
      params: {
        title: "{{ inputs.title }}",
        description: "Filed by a run.",
        provenance: [{ ref: "test:ticket:79" }],
      },
    },
    {
      id: "update",
      kind: "action",
      action: "task.update",
      params: { taskId: "{{ steps.create.output.id }}", status: "in-progress" },
    },
  ],
  edges: [{ from: "create", to: "update" }],
};

/**
 * One step that creates a task, with an input of every kind a run resolves:
 * - `title`: required, with a JSON Schema;
 * - `priority`: optional, with a default;
 * - `note`: optional, with no default, so it is absent when not given;
 * - `repo`: optional, a GitHub Connection.
 */
export const INPUTS_DEFINITION = {
  name: "File a task from inputs",
  inputs: [
    { name: "title", schema: { type: "string", minLength: 1 }, required: true },
    {
      name: "priority",
      schema: { type: "string", enum: ["urgent", "high", "normal", "low"] },
      required: false,
      default: "high",
    },
    { name: "note", schema: { type: "string" }, required: false },
    { name: "repo", connection: { type: "github/github" }, required: false },
  ],
  steps: [
    {
      id: "create",
      kind: "action",
      action: "task.create",
      params: { title: "{{ inputs.title }}", description: "", priority: "{{ inputs.priority }}" },
    },
  ],
};

/** Builds an action step that creates a task, for definitions that only need some step to exist. */
export const buildCreateStep = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  kind: "action",
  action: "task.create",
  params: { title: `File the ${id} task`, description: "" },
  ...extra,
});

/* ------------------------------------------------------------------------ */
/* Starting a workflow sent with the request, listing and cancelling runs.   */
/* ------------------------------------------------------------------------ */

/**
 * Starts a run of a workflow sent with the request, as `source` or
 * `definition` in `body`, and returns the new run's id. Fails the test if the
 * request is refused, or if the response holds anything but the run id.
 */
export const startSentWorkflow = async (
  base: string,
  token: string,
  body: unknown,
): Promise<string> => {
  const response = await requestStart(base, token, body);
  expect(response.status, await response.clone().text()).toBe(200);
  const started = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(started)).toEqual(["runId"]);
  return started["runId"] as string;
};

/**
 * Reads one page of the run list. `query` is the query string without the
 * `?`, such as `status=failed&limit=2`. Fails the test if the request is
 * refused.
 */
export const queryRuns = async (base: string, token: string, query = ""): Promise<RunPage> => {
  const response = await get(base, `/api/v1/runs${query === "" ? "" : `?${query}`}`, token);
  expect(response.status, `${query}: ${await response.clone().text()}`).toBe(200);
  return (await response.json()) as RunPage;
};

export const requestCancel = (base: string, token: string, id: string) =>
  post(base, `/api/v1/runs/${id}/cancel`, {}, token);

/**
 * A plugin action that does not return until the test releases it or its run
 * is cancelled. A run with a step of this action stays `running` for as long
 * as the test needs, so the test can act on a run it knows is unfinished.
 */
export interface HeldAction {
  readonly plugin: Plugin;
  /** The qualified id a step uses to call the action. */
  readonly actionId: string;
  /** The context of every execution so far, in the order they started. */
  readonly contexts: ReadonlyArray<ActionContext>;
  /** Ends every execution that is waiting, and makes every later one return at once. */
  readonly release: () => void;
}

/**
 * Builds a plugin `hold` with one action `hold/wait`. The action takes a
 * `label` and returns `{ released: true }` once the test calls `release`, or
 * once its cancel signal aborts.
 *
 * It returns normally on abort, rather than failing, so a test can check that
 * a cancelled run ignores what an action returns after the cancel.
 */
export const buildHeldAction = (): HeldAction => {
  const contexts: Array<ActionContext> = [];
  const waiting: Array<() => void> = [];
  let released = false;
  const release = (): void => {
    released = true;
    for (const finish of waiting.splice(0)) finish();
  };
  const plugin = buildActionPlugin("hold", {
    id: "wait",
    displayName: "Wait",
    description: "Waits until the test releases it, or until its run is cancelled.",
    input: Schema.Struct({ label: Schema.String }),
    output: Schema.Struct({ released: Schema.Boolean }),
    execute: (_input, context) =>
      Effect.callback<{ released: boolean }>((resume) => {
        contexts.push(context);
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          resume(Effect.succeed({ released: true }));
        };
        if (released) return finish();
        waiting.push(finish);
        context.signal.addEventListener("abort", finish);
      }),
  });
  return { plugin, actionId: "hold/wait", contexts, release };
};

/** Builds a step that calls the held action. */
export const buildHeldStep = (held: HeldAction, id: string) => ({
  id,
  kind: "action",
  action: held.actionId,
  params: { label: id },
});

/** Waits until the held action has started `count` executions, and returns their contexts. */
export const waitForHeldExecutions = (
  held: HeldAction,
  count: number,
): Promise<ReadonlyArray<ActionContext>> =>
  waitUntil(`started ${String(count)} held action(s)`, () =>
    held.contexts.length >= count ? held.contexts : undefined,
  );

/**
 * Runs `body` against a controller with one connected runner, so sessions can
 * be spawned with the grants a test needs, and with `plugins` installed next
 * to the agent provider.
 */
export const withRunFleet = (
  body: (arranged: Arranged) => Promise<void>,
  plugins: ReadonlyArray<Plugin> = [],
): Promise<void> =>
  sharedWithFleet(body, {
    plugins: [createPluginFixture({ id: "providers", definitions: [PROVIDER] }).plugin, ...plugins],
    facts: FACTS,
    models: MODELS,
  });

/**
 * Inserts a run of `workflowId` with the status `pending` and one pending
 * step record for `stepId`, the rows a run has between its start request and
 * the moment the engine picks it up. No request can hold a run at `pending`,
 * so the rows are written directly.
 */
export const insertPendingRun = (
  harness: ServerHarness,
  fields: {
    readonly id: string;
    readonly workflowId: string;
    readonly plan: unknown;
    readonly stepId: string;
  },
): Promise<void> => {
  const createdAt = new Date().toISOString();
  return runEffect(
    Effect.andThen(
      harness.sql`
        INSERT INTO runs (id, workflow_id, plan, inputs, origin, status, created_at)
        VALUES
          (unhex(replace(${fields.id}, '-', '')),
           unhex(replace(${fields.workflowId}, '-', '')),
           ${JSON.stringify(fields.plan)}, ${JSON.stringify({})},
           ${JSON.stringify({ kind: "manual", actor: "user" })}, 'pending', ${createdAt})`,
      harness.sql`
        INSERT INTO run_steps (run_id, step_id, iteration, status, created_at)
        VALUES (unhex(replace(${fields.id}, '-', '')), ${fields.stepId}, 1, 'pending', ${createdAt})`,
    ),
  ).then(() => undefined);
};
