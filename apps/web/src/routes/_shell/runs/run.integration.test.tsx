/**
 * Tests for a run's page at `/runs/$runId`: the header, the inputs, the run
 * graph with each step's state on it, the steps below it as a list or a
 * timeline, Cancel, Re-run and the runs on either side of a re-run, and live
 * updates.
 *
 * The stub controller holds one run at a time. A test replaces it, as the run
 * engine would change it, and pushes the change on the `run` topic.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describeActor, toIdTail } from "@hercule/client-core";
import {
  buildCheckout,
  buildRunner,
  buildSession,
  buildWorkspace,
} from "@hercule/client-core/threads/testing";
import type {
  Run,
  RunSummary,
  RunnerDetail,
  Session,
  StepStatus,
  WorkflowDefinition,
  Workspace,
} from "@hercule/contract";
import {
  buildErrorBody,
  readPageText,
  renderApp,
  stubApi,
  type Call,
  type Handler,
} from "../../../app/testing";

type LiveStub = Awaited<ReturnType<typeof renderApp>>["live"];

/**
 * How long a test waits for the run graph. The first page that draws a graph
 * also loads the graph library, which can take a few seconds under jsdom.
 */
const GRAPH_LOAD_TIMEOUT_MS = 5_000;

/** The timeout of a test that draws the run graph, including the first load. */
const GRAPH_TEST_TIMEOUT_MS = 20_000;

/** Every status a step record can have, as the contract spells it. */
const STEP_STATUSES: readonly StepStatus[] = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "skipped",
];

/** Returns the ISO timestamp `seconds` seconds after `start`. */
const addSeconds = (start: string, seconds: number): string =>
  new Date(Date.parse(start) + seconds * 1000).toISOString();

const T0 = new Date(Date.now() - 10 * 60_000).toISOString();

/* ------------------------------------------------------------------------ */
/* The plans and runs.                                                       */
/* ------------------------------------------------------------------------ */

const WORKFLOW_ID = "0199c0ff-1111-7000-8000-000000000001";
const WORKFLOW_NAME = "File and start a task";
const TASK_ID = "0199c0ff-7777-7000-8000-000000000001";

/**
 * The starter workflow: `create` files a task, then `start` moves it to
 * in-progress. `note` is a second entry step, so a running run can have a
 * step that is running and one that is still pending at the same time.
 */
const PLAN: WorkflowDefinition = {
  name: WORKFLOW_NAME,
  inputs: [{ name: "title", schema: { type: "string" }, required: true }],
  steps: [
    {
      id: "create",
      kind: "action",
      action: "task.create",
      params: { title: "{{ inputs.title }}" },
    },
    {
      id: "start",
      kind: "action",
      action: "task.update",
      params: { taskId: "{{ steps.create.output.id }}", status: "in-progress" },
    },
    { id: "note", kind: "action", action: "task.query" },
  ],
  edges: [{ from: "create", to: "start" }],
};

/** What the `create` step returned: the created task. */
const CREATED_TASK = { id: TASK_ID, title: "Fix login", status: "open" };

const CREATE_DONE = {
  stepId: "create",
  iteration: 1,
  status: "completed",
  startedAt: T0,
  finishedAt: addSeconds(T0, 12),
  output: CREATED_TASK,
} as const;

const NOTE_DONE = {
  stepId: "note",
  iteration: 1,
  status: "completed",
  startedAt: T0,
  finishedAt: addSeconds(T0, 1),
  output: { items: [] },
} as const;

/** A run where `create` has completed, `start` is running and `note` is still pending. */
const RUNNING_RUN: Run = {
  id: "0199c0ff-2222-7000-8000-000000000001",
  workflowId: WORKFLOW_ID,
  plan: PLAN,
  inputs: { title: "Fix login" },
  origin: { kind: "manual", actor: "user" },
  subscriptions: [],
  status: "running",
  steps: [
    CREATE_DONE,
    { stepId: "note", iteration: 1, status: "pending" },
    { stepId: "start", iteration: 1, status: "running", startedAt: addSeconds(T0, 12) },
  ],
  edgeTraversals: [1],
  createdAt: T0,
  startedAt: T0,
};

/** The same run once every step has completed. */
const COMPLETED_RUN: Run = {
  ...RUNNING_RUN,
  status: "completed",
  steps: [
    CREATE_DONE,
    NOTE_DONE,
    {
      stepId: "start",
      iteration: 1,
      status: "completed",
      startedAt: addSeconds(T0, 12),
      finishedAt: addSeconds(T0, 14),
      output: { ...CREATED_TASK, status: "in-progress" },
    },
  ],
  finishedAt: addSeconds(T0, 14),
};

/** A completed run whose plan is one row: `create`, then `start`. */
const ONE_ROW_RUN: Run = {
  ...COMPLETED_RUN,
  id: "0199c0ff-2222-7000-8000-000000000005",
  plan: { ...PLAN, steps: PLAN.steps.filter((step) => step.id !== "note") },
  steps: COMPLETED_RUN.steps.filter((record) => record.stepId !== "note"),
};

const STEP_ERROR_MESSAGE = "No task has the id 0199c0ff-7777-7000-8000-00000000dead.";

/** The same run, failed because `start` could not find the task. */
const FAILED_RUN: Run = {
  ...RUNNING_RUN,
  status: "failed",
  failureReason: "step-failed",
  failedStepId: "start",
  steps: [
    CREATE_DONE,
    NOTE_DONE,
    {
      stepId: "start",
      iteration: 1,
      status: "failed",
      startedAt: addSeconds(T0, 12),
      finishedAt: addSeconds(T0, 13),
      error: { code: "not_found", message: STEP_ERROR_MESSAGE },
    },
  ],
  finishedAt: addSeconds(T0, 13),
};

/** The same run, cancelled while `start` was running and `note` was pending. */
const CANCELLED_RUN: Run = {
  ...RUNNING_RUN,
  status: "cancelled",
  steps: [
    CREATE_DONE,
    { stepId: "note", iteration: 1, status: "cancelled", finishedAt: addSeconds(T0, 13) },
    {
      stepId: "start",
      iteration: 1,
      status: "cancelled",
      startedAt: addSeconds(T0, 12),
      finishedAt: addSeconds(T0, 13),
    },
  ],
  finishedAt: addSeconds(T0, 13),
};

/**
 * A plan with routing: `lookup` reuses a task it finds, or goes on to `file`
 * one; `file` and `count` loop until there are enough tasks, at most three
 * times back; then `escalate` runs only for urgent input, and `settle` leads
 * to `finish`. `reuse` and `finish` end the run.
 */
const ROUTING_PLAN: WorkflowDefinition = {
  name: WORKFLOW_NAME,
  inputs: [{ name: "target", schema: { type: "number" }, required: true }],
  steps: [
    { id: "lookup", kind: "action", action: "task.query" },
    { id: "reuse", kind: "action", action: "task.update", terminal: true },
    { id: "file", kind: "action", action: "task.create" },
    { id: "count", kind: "action", action: "task.query" },
    { id: "escalate", kind: "action", action: "task.update", condition: "inputs.urgent" },
    { id: "settle", kind: "action", action: "task.query" },
    { id: "finish", kind: "action", action: "task.update", terminal: true },
  ],
  edges: [
    { from: "lookup", to: "reuse", condition: "size(steps.lookup.output.items) > 0" },
    { from: "lookup", to: "file", condition: "size(steps.lookup.output.items) == 0" },
    { from: "file", to: "count" },
    {
      from: "count",
      to: "file",
      condition: "size(steps.count.output.items) < inputs.target",
      maxTraversals: 3,
    },
    { from: "count", to: "escalate", condition: "size(steps.count.output.items) >= inputs.target" },
    { from: "escalate", to: "settle" },
    { from: "settle", to: "finish" },
  ],
};

/** Returns a completed record of `stepId`, which ran from `from` to `to` seconds after T0. */
const completeStep = (stepId: string, iteration: number, from: number, to: number) =>
  ({
    stepId,
    iteration,
    status: "completed",
    startedAt: addSeconds(T0, from),
    finishedAt: addSeconds(T0, to),
    output: { items: [] },
  }) as const;

/** The records of `lookup`, then `file` and `count` looping `times` times. */
const listLoopRecords = (times: number) => [
  completeStep("lookup", 1, 0, 1),
  ...Array.from({ length: times }, (_, index) => [
    completeStep("file", index + 1, 10 * index + 2, 10 * index + 4),
    completeStep("count", index + 1, 10 * index + 5, 10 * index + 7),
  ]).flat(),
];

/** What the routing run returned: the task `finish` settled. */
const ROUTING_OUTPUT = { id: "t_1", status: "in-progress" };

/** The routing run, completed: the loop ran three times, `escalate` was skipped. */
const ROUTING_COMPLETED_RUN: Run = {
  ...RUNNING_RUN,
  id: "0199c0ff-2222-7000-8000-000000000011",
  plan: ROUTING_PLAN,
  inputs: { target: 3 },
  status: "completed",
  steps: [
    ...listLoopRecords(3),
    { stepId: "escalate", iteration: 1, status: "skipped", finishedAt: addSeconds(T0, 28) },
    completeStep("settle", 1, 29, 30),
    completeStep("finish", 1, 31, 32),
  ],
  edgeTraversals: [0, 1, 3, 2, 1, 1, 1],
  output: ROUTING_OUTPUT,
  finishedAt: addSeconds(T0, 32),
};

/** The routing run in its loop: `file` runs for the third time. */
const ROUTING_LOOPING_RUN: Run = {
  ...RUNNING_RUN,
  id: "0199c0ff-2222-7000-8000-000000000012",
  plan: ROUTING_PLAN,
  inputs: { target: 3 },
  status: "running",
  steps: [
    ...listLoopRecords(2),
    { stepId: "file", iteration: 3, status: "running", startedAt: addSeconds(T0, 22) },
  ],
  edgeTraversals: [0, 1, 2, 2, 0, 0, 0],
};

const ITERATION_LIMIT_MESSAGE =
  "The run was to follow the edge from count to file again, but it has already followed it 3 times, the most this edge allows.";

/** The routing run with a target the loop cannot reach: it failed at the loop edge. */
const ITERATION_LIMIT_RUN: Run = {
  ...RUNNING_RUN,
  id: "0199c0ff-2222-7000-8000-000000000013",
  plan: ROUTING_PLAN,
  inputs: { target: 99 },
  status: "failed",
  failureReason: "iteration-limit",
  failedStepId: "count",
  failedEdge: { index: 3, message: ITERATION_LIMIT_MESSAGE },
  steps: listLoopRecords(4),
  edgeTraversals: [0, 1, 4, 3, 0, 0, 0],
  finishedAt: addSeconds(T0, 40),
};

const EXPRESSION_ERROR_MESSAGE = "no such key: urgency";

/** The routing run, failed because the condition on `count -> escalate` did not evaluate. */
const EDGE_EXPRESSION_ERROR_RUN: Run = {
  ...ITERATION_LIMIT_RUN,
  id: "0199c0ff-2222-7000-8000-000000000014",
  inputs: { target: 1 },
  failureReason: "expression-error",
  failedEdge: { index: 4, message: EXPRESSION_ERROR_MESSAGE },
  steps: listLoopRecords(1),
  edgeTraversals: [0, 1, 1, 0, 0, 0, 0],
};

const AGENT_ID = "0199c0ff-8888-7000-8000-000000000001";
const IMPLEMENT_SESSION_ID = "0199c0ff-9999-7000-8000-00000000a11c";

/** The correlation of both signal triggers: the pull request `open_pr` opened. */
const ON_THE_PULL_REQUEST = {
  event: "event.payload.prNumber",
  run: "steps.open_pr.output.prNumber",
} as const;

/**
 * A plan with an agent step and two signal triggers: the agent step
 * `implement` makes a change, and `open_pr` opens a pull request for it.
 * When the checks on that pull request fail, `checks_failed` sends the run
 * back to `implement`; when it merges, `pr_merged` leads to `done`, which
 * ends the run.
 */
const SIGNAL_PLAN: WorkflowDefinition = {
  name: WORKFLOW_NAME,
  triggers: [
    {
      id: "checks_failed",
      kind: "signal",
      on: { kind: "github.pr.checks-completed", connectionId: "any" },
      correlation: ON_THE_PULL_REQUEST,
    },
    {
      id: "pr_merged",
      kind: "signal",
      on: { kind: "github.pr.merged", connectionId: "any" },
      correlation: ON_THE_PULL_REQUEST,
    },
  ],
  steps: [
    { id: "implement", kind: "agent", agent: AGENT_ID, prompt: "Fix the login bug.", entry: true },
    { id: "open_pr", kind: "action", action: "github.pr.open" },
    { id: "done", kind: "action", action: "task.update", terminal: true },
  ],
  edges: [
    { from: "implement", to: "open_pr" },
    { from: "checks_failed", to: "implement", maxTraversals: 3 },
    { from: "pr_merged", to: "done" },
  ],
};

/** What `checks_failed` holds each time it fires: the checks' verdict on the pull request. */
const CHECKS_FAILED_OUTPUT = { conclusion: "failure", prNumber: 42 };

/** Returns the records of `implement` then `open_pr` running for the `iteration`th time. */
const listImplementRecords = (iteration: number) => {
  const from = 100 * (iteration - 1);
  return [
    { ...completeStep("implement", iteration, from, from + 60), sessionId: IMPLEMENT_SESSION_ID },
    { ...completeStep("open_pr", iteration, from + 61, from + 62), output: { prNumber: 42 } },
  ];
};

/** Returns the record of `checks_failed` firing for the `iteration`th time. */
const fireChecksFailed = (iteration: number) =>
  ({
    stepId: "checks_failed",
    iteration,
    status: "completed",
    startedAt: addSeconds(T0, 100 * iteration - 10),
    finishedAt: addSeconds(T0, 100 * iteration - 10),
    output: CHECKS_FAILED_OUTPUT,
  }) as const;

/**
 * The signal run after the checks failed twice: `implement` and `open_pr`
 * ran three times, and nothing runs now. The run waits for the checks to
 * fail again or for the pull request to merge.
 */
const SIGNAL_WAITING_RUN: Run = {
  ...RUNNING_RUN,
  id: "0199c0ff-2222-7000-8000-000000000021",
  plan: SIGNAL_PLAN,
  inputs: {},
  steps: [
    ...listImplementRecords(1),
    fireChecksFailed(1),
    ...listImplementRecords(2),
    fireChecksFailed(2),
    ...listImplementRecords(3),
  ],
  edgeTraversals: [3, 2, 0],
};

/**
 * The session `implement` drives, across all three of its records. The
 * builder's placeholder ids are replaced, because the client decodes the
 * session list, and an id must be a UUID.
 */
const IMPLEMENT_SESSION = buildSession({
  id: IMPLEMENT_SESSION_ID,
  permissionProfileId: "0199c0ff-aaaa-7000-8000-000000000001",
  instanceId: "0199c0ff-bbbb-7000-8000-000000000001",
  runnerId: "0199c0ff-cccc-7000-8000-000000000001",
  title: "Fix the login bug",
  status: "idle",
  agentId: AGENT_ID,
  runId: SIGNAL_WAITING_RUN.id,
  stepId: "implement",
});

/* ------------------------------------------------------------------------ */
/* The stub controller.                                                      */
/* ------------------------------------------------------------------------ */

/** Returns a completed run of the starter workflow with `id`, as the run list shows it. */
const buildRerunSummary = (id: string): RunSummary => ({
  id,
  workflowId: WORKFLOW_ID,
  workflowName: WORKFLOW_NAME,
  origin: { kind: "manual", actor: "user" },
  status: "completed",
  createdAt: T0,
  startedAt: T0,
  finishedAt: addSeconds(T0, 14),
});

/** The route that reads the run's saved workflow. */
const WORKFLOW_READ = `GET /api/v1/workflows/${WORKFLOW_ID}`;

/** The controller's answer to a read of a workflow that was deleted. */
const WORKFLOW_DELETED = {
  status: 404,
  body: buildErrorBody("not_found", "No workflow has that id."),
} as const;

/**
 * Renders the run's page against a stub controller that holds `run`. The
 * run's saved workflow still exists, but its source is empty, which the page
 * must not need: everything it shows comes from the run. The workflow is
 * read only to learn whether it still exists.
 * - `reruns` are the runs that re-ran it, newest first, which the run list
 *   returns for `originalRunId`. By default there are none.
 * - `sessions` are the sessions its agent steps started, which the session
 *   list returns for `runId`. By default there are none.
 * - `overrides` replaces the handler of a route, or adds a route.
 *
 * Returns the app, the stubbed API, and `hold`, which replaces the run the
 * controller holds from now on, `holdReruns`, which replaces its re-runs, and
 * `holdSessions`, which replaces its sessions.
 */
const openRunPage = async (
  run: Run,
  {
    reruns = [],
    sessions = [],
    overrides = {},
  }: {
    readonly reruns?: readonly RunSummary[];
    readonly sessions?: readonly Session[];
    readonly overrides?: Readonly<Record<string, Handler>>;
  } = {},
) => {
  let held = run;
  let heldReruns = reruns;
  let heldSessions = sessions;
  const api = stubApi({
    "GET /api/v1/setup": { body: { complete: true } },
    "GET /api/v1/settings": {
      body: {
        controller: {},
        user: {
          "onboarding.completedSteps": ["timezone", "assistant"],
          timezone: "Europe/Amsterdam",
        },
      },
    },
    [`GET /api/v1/runs/${run.id}`]: () => ({ body: held }),
    [WORKFLOW_READ]: {
      body: { id: WORKFLOW_ID, enabled: true, source: "", createdAt: T0, updatedAt: T0 },
    },
    "GET /api/v1/workflows": { body: { items: [] } },
    "GET /api/v1/workflow-actions": { body: [] },
    "GET /api/v1/runs": (call) => ({
      body: {
        items: new URLSearchParams(call.search).get("originalRunId") === held.id ? heldReruns : [],
      },
    }),
    "GET /api/v1/sessions": (call) => ({
      body: {
        items: new URLSearchParams(call.search).get("runId") === held.id ? heldSessions : [],
      },
    }),
    ...overrides,
  });
  const app = await renderApp({ path: `/runs/${run.id}`, api: api.fetch, token: "held" });
  return {
    ...app,
    api,
    hold: (next: Run): void => {
      held = next;
    },
    holdReruns: (next: readonly RunSummary[]): void => {
      heldReruns = next;
    },
    holdSessions: (next: readonly Session[]): void => {
      heldSessions = next;
    },
  };
};

/* ------------------------------------------------------------------------ */
/* Helpers that read and use the page the way a user does.                  */
/* ------------------------------------------------------------------------ */

/** Waits for the page's header: the `<header>` that holds the title, the workflow's name. */
const findPageHeader = async (): Promise<HTMLElement> => {
  const title = await screen.findByRole("heading", { level: 1, name: WORKFLOW_NAME });
  const header = title.closest("header");
  if (header === null) throw new Error("the page's title is not in a header");
  return header;
};

/** Waits for the run graph region. */
const findRunGraph = (): Promise<HTMLElement> =>
  screen.findByRole("region", { name: "Run graph" }, { timeout: GRAPH_LOAD_TIMEOUT_MS });

/** Returns the height in pixels of the graph's pane: the region's child that holds the drawing. */
const readGraphPaneHeight = (graph: HTMLElement): number => {
  const pane = [...graph.children].find(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.querySelector(".react-flow") !== null,
  );
  if (pane === undefined) throw new Error("the run graph region has no pane with the drawing");
  return Number.parseFloat(pane.style.height);
};

/** Returns the card of step `stepId` in the run graph: a group named by the step's id. */
const getGraphCard = (graph: HTMLElement, stepId: string): HTMLElement =>
  within(graph).getByRole("group", { name: stepId });

/** Returns the statuses whose word the element's text holds. */
const readStatusWords = (element: HTMLElement): readonly StepStatus[] => {
  const text = readPageText(element).toLowerCase();
  return STEP_STATUSES.filter((status) => new RegExp(`\\b${status}\\b`).test(text));
};

/** Returns the Steps region, which holds the step list or the timeline. */
const getStepsRegion = (): HTMLElement => screen.getByRole("region", { name: "Steps" });

/** Returns the row of the step list for step `stepId`. Throws when there is none. */
const getStepRow = (stepId: string): HTMLElement => {
  const row = within(getStepsRegion())
    .queryAllByRole("listitem")
    .find((item) => readPageText(item).includes(stepId));
  if (row === undefined) throw new Error(`no row of the step list is for ${stepId}`);
  return row;
};

/** Returns every row of the step list for step `stepId`, one per step record. */
const listStepRows = (stepId: string): readonly HTMLElement[] =>
  within(getStepsRegion())
    .queryAllByRole("listitem")
    .filter((item) => new RegExp(`\\b${stepId}\\b`).test(readPageText(item)));

/** Returns the `run.cancel` requests the page made. */
const listCancels = (api: { readonly calls: readonly Call[] }, id: string): readonly Call[] =>
  api.calls.filter((call) => call.method === "POST" && call.path === `/api/v1/runs/${id}/cancel`);

/** Returns the `run.rerun` requests the page made. */
const listReruns = (api: { readonly calls: readonly Call[] }, id: string): readonly Call[] =>
  api.calls.filter((call) => call.method === "POST" && call.path === `/api/v1/runs/${id}/rerun`);

/**
 * Sends a push for the run with `id` on the `run` topic, once the page has
 * subscribed: `updated` by default, or `created` for a run that just started.
 */
const pushRunChange = async (
  live: LiveStub,
  id: string,
  kind: "created" | "updated" = "updated",
): Promise<void> => {
  await waitFor(() => {
    expect(live.topics()).toContain("run");
  });
  act(() => {
    live.push("run", { _tag: "invalidate", ids: [id], kind });
  });
};

/* ------------------------------------------------------------------------ */
/* A run's page.                                                            */
/* ------------------------------------------------------------------------ */

describe("A run's page > the header", () => {
  it("shows the workflow's name, the status, how the run started, its times and its failure reason", async () => {
    await openRunPage(FAILED_RUN);

    const header = await findPageHeader();
    const text = readPageText(header);
    // The failure reason, which also shows that the run failed.
    expect(text).toMatch(/step.failed/i);
    expect(text).toContain(describeActor("user").label);
    // The times are machine-readable, whatever words show them.
    const times = [...header.querySelectorAll("time")].map((time) => time.dateTime);
    expect(times).toEqual(expect.arrayContaining([FAILED_RUN.startedAt, FAILED_RUN.finishedAt]));
  });

  it("shows the inputs the run started with", async () => {
    await openRunPage(COMPLETED_RUN);

    await findPageHeader();
    const main = readPageText(screen.getByRole("main"));
    expect(main).toContain("title");
    expect(main).toContain("Fix login");
  });

  it("offers Cancel only while the run is pending or running", async () => {
    await openRunPage(RUNNING_RUN);
    expect(within(await findPageHeader()).getByRole("button", { name: "Cancel" })).toBeDefined();
  });

  it.each([
    { run: COMPLETED_RUN, status: "completed" },
    { run: FAILED_RUN, status: "failed" },
    { run: CANCELLED_RUN, status: "cancelled" },
  ])("offers no Cancel on a $status run", async ({ run }) => {
    await openRunPage(run);
    const header = await findPageHeader();
    expect(within(header).queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("puts the focus on Keep running when the cancel question shows, and back on Cancel after Keep running", async () => {
    const user = userEvent.setup();
    const { api } = await openRunPage(RUNNING_RUN);

    await user.click(within(await findPageHeader()).getByRole("button", { name: "Cancel" }));

    const keepRunning = screen.getByRole("button", { name: "Keep running" });
    expect(document.activeElement).toBe(keepRunning);

    await user.click(keepRunning);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
    expect(listCancels(api, RUNNING_RUN.id)).toEqual([]);
  });

  it("shows a question in place before it cancels, then cancels and shows the run cancelled", async () => {
    const user = userEvent.setup();
    const { api, hold } = await openRunPage(RUNNING_RUN, {
      overrides: {
        [`POST /api/v1/runs/${RUNNING_RUN.id}/cancel`]: () => {
          hold(CANCELLED_RUN);
          return { body: CANCELLED_RUN };
        },
      },
    });

    await user.click(within(await findPageHeader()).getByRole("button", { name: "Cancel" }));

    // Nothing is cancelled until the question is answered.
    const confirm = await screen.findByRole("button", { name: "Confirm" });
    expect(listCancels(api, RUNNING_RUN.id)).toEqual([]);

    await user.click(confirm);

    await waitFor(() => {
      expect(readPageText(screen.getByRole("heading", { level: 1 }).closest("header"))).toMatch(
        /cancelled/i,
      );
    });
    expect(listCancels(api, RUNNING_RUN.id)).toHaveLength(1);
    const header = await findPageHeader();
    expect(within(header).queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});

describe("A run's page > the steps", { timeout: GRAPH_TEST_TIMEOUT_MS }, () => {
  it("shows the steps as a list by default, one row per step record with its status, duration and error", async () => {
    await openRunPage(FAILED_RUN);
    await findPageHeader();

    expect(screen.getByRole("radio", { name: "List" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("radio", { name: "Timeline" }).getAttribute("aria-checked")).toBe(
      "false",
    );

    const create = getStepRow("create");
    expect(readStatusWords(create)).toEqual(["completed"]);
    // `create` took 12 seconds.
    expect(readPageText(create)).toMatch(/\b12(\.0)?\s?s\b/);

    const start = getStepRow("start");
    expect(readStatusWords(start)).toEqual(["failed"]);
    expect(readPageText(start)).toContain(STEP_ERROR_MESSAGE);
  });

  it("shows a step's output only once its row is expanded", async () => {
    const user = userEvent.setup();
    await openRunPage(COMPLETED_RUN);
    await findPageHeader();

    const row = getStepRow("create");
    expect(readPageText(row)).not.toContain(TASK_ID);

    const toggle = within(row).getByRole("button", { expanded: false });
    await user.click(toggle);

    await waitFor(() => {
      expect(readPageText(getStepRow("create"))).toContain(TASK_ID);
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("switches the steps to a timeline with one bar per step record", async () => {
    const user = userEvent.setup();
    await openRunPage(COMPLETED_RUN);
    await findPageHeader();

    await user.click(screen.getByRole("radio", { name: "Timeline" }));

    await waitFor(() => {
      expect(screen.getByRole("radio", { name: "Timeline" }).getAttribute("aria-checked")).toBe(
        "true",
      );
    });
    const steps = getStepsRegion();
    // The list's rows are gone, and each step record still shows, now as a bar.
    expect(within(steps).queryAllByRole("button", { expanded: false })).toEqual([]);
    for (const record of COMPLETED_RUN.steps) {
      expect(within(steps).getByText(record.stepId)).toBeDefined();
    }
  });

  it("updates the header and the steps live when a change is pushed on the run topic", async () => {
    const { live, hold } = await openRunPage(RUNNING_RUN);
    const header = await findPageHeader();
    expect(readPageText(header).toLowerCase()).toContain("running");
    expect(readStatusWords(getStepRow("start"))).toEqual(["running"]);

    hold(COMPLETED_RUN);
    await pushRunChange(live, RUNNING_RUN.id);

    await waitFor(() => {
      expect(readStatusWords(getStepRow("start"))).toEqual(["completed"]);
    });
    expect(readPageText(await findPageHeader()).toLowerCase()).toContain("completed");
    expect(within(await findPageHeader()).queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("shows everything from the run when its workflow was deleted", async () => {
    await openRunPage(COMPLETED_RUN, { overrides: { [WORKFLOW_READ]: WORKFLOW_DELETED } });

    await findPageHeader();
    const graph = await findRunGraph();
    for (const step of PLAN.steps) {
      expect(getGraphCard(graph, step.id)).toBeDefined();
      expect(getStepRow(step.id)).toBeDefined();
    }
    expect(screen.queryByText("This screen did not load")).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* The run graph shows where the run is.                                    */
/* ------------------------------------------------------------------------ */

describe("A run's page > the run graph", { timeout: GRAPH_TEST_TIMEOUT_MS }, () => {
  it.each([
    {
      run: RUNNING_RUN,
      expected: { create: "completed", start: "running", note: "pending" },
    },
    {
      run: FAILED_RUN,
      expected: { create: "completed", start: "failed", note: "completed" },
    },
    {
      run: CANCELLED_RUN,
      expected: { create: "completed", start: "cancelled", note: "cancelled" },
    },
  ] as const)(
    "draws each step of a $run.status run with its own state",
    async ({ run, expected }) => {
      await openRunPage(run);

      const graph = await findRunGraph();
      for (const [stepId, status] of Object.entries(expected)) {
        await waitFor(() => {
          expect(readStatusWords(getGraphCard(graph, stepId))).toEqual([status]);
        });
      }
    },
  );

  it("moves a step's state on the graph live when a change is pushed on the run topic", async () => {
    const { live, hold } = await openRunPage(RUNNING_RUN);
    const graph = await findRunGraph();
    await waitFor(() => {
      expect(readStatusWords(getGraphCard(graph, "start"))).toEqual(["running"]);
    });

    hold(COMPLETED_RUN);
    await pushRunChange(live, RUNNING_RUN.id);

    await waitFor(() => {
      expect(readStatusWords(getGraphCard(graph, "start"))).toEqual(["completed"]);
    });
    expect(readStatusWords(getGraphCard(graph, "note"))).toEqual(["completed"]);
  });
});

/* ------------------------------------------------------------------------ */
/* Routing: loops, skipped steps, the failed edge and the run's output.     */
/* ------------------------------------------------------------------------ */

describe("A run's page > routing on the graph", { timeout: GRAPH_TEST_TIMEOUT_MS }, () => {
  it("shows ×n on the card of a step that ran more than once, and nothing on a step that ran once", async () => {
    await openRunPage(ROUTING_COMPLETED_RUN);

    const graph = await findRunGraph();
    await waitFor(() => {
      expect(readPageText(getGraphCard(graph, "file"))).toMatch(/×\s?3/);
    });
    expect(readPageText(getGraphCard(graph, "count"))).toMatch(/×\s?3/);
    expect(readPageText(getGraphCard(graph, "lookup"))).not.toContain("×");
  });

  it("draws a skipped step with the skipped mark and the word skipped", async () => {
    await openRunPage(ROUTING_COMPLETED_RUN);

    const graph = await findRunGraph();
    const escalate = getGraphCard(graph, "escalate");
    await waitFor(() => {
      expect(readStatusWords(escalate)).toEqual(["skipped"]);
    });
    expect(escalate.dataset.state).toBe("skipped");
    expect(escalate.querySelector('svg[data-mark="skipped"]')).not.toBeNull();
  });

  it("shows how often the run went along a capped edge out of its cap", async () => {
    await openRunPage(ROUTING_LOOPING_RUN);

    const graph = await findRunGraph();
    expect(await within(graph).findByText("2/3")).toBeDefined();
    expect(within(graph).queryByText("max 3")).toBeNull();
  });

  it("shows the badge of the edge a run failed on at its iteration limit in the failure colour", async () => {
    await openRunPage(ITERATION_LIMIT_RUN);

    const graph = await findRunGraph();
    const badge = await within(graph).findByText("3/3");
    expect(badge.classList.contains("text-fail")).toBe(true);
  });

  it("grows the graph pane for a plan with more than one row of steps", async () => {
    // The pane's height follows the drawing, so a plan that branches into two
    // rows gets a taller pane than a plan of one row. jsdom measures no width,
    // so both panes use the same zoom and only the drawings' heights differ.
    const oneRow = await openRunPage(ONE_ROW_RUN);
    const oneRowHeight = readGraphPaneHeight(await findRunGraph());
    oneRow.unmount();

    await openRunPage(ROUTING_COMPLETED_RUN);
    const twoRowHeight = readGraphPaneHeight(await findRunGraph());
    expect(twoRowHeight).toBeGreaterThan(oneRowHeight);
  });
});

describe("A run's page > routing in the header", () => {
  it("names the step and the edge of an iteration limit in plain words, and shows the failure message", async () => {
    await openRunPage(ITERATION_LIMIT_RUN);

    const header = await findPageHeader();
    expect(readPageText(header)).toMatch(/iteration limit at count\s*→\s*file/i);
    expect(readPageText(screen.getByRole("main"))).toContain(ITERATION_LIMIT_MESSAGE);
  });

  it("calls a failed edge condition an expression error, not a template error", async () => {
    await openRunPage(EDGE_EXPRESSION_ERROR_RUN);

    const header = await findPageHeader();
    const text = readPageText(header);
    expect(text).toMatch(/expression error at count\s*→\s*escalate/i);
    expect(text).not.toMatch(/template/i);
    expect(readPageText(screen.getByRole("main"))).toContain(EXPRESSION_ERROR_MESSAGE);
  });
});

describe("A run's page > routing in the steps", { timeout: GRAPH_TEST_TIMEOUT_MS }, () => {
  it("numbers the rows of a step that ran more than once, and not the rows of a step that ran once", async () => {
    await openRunPage(ROUTING_COMPLETED_RUN);
    await findPageHeader();

    const fileRows = listStepRows("file");
    expect(fileRows).toHaveLength(3);
    expect(fileRows.map((row) => /#\s?(\d+)/.exec(readPageText(row))?.[1])).toEqual([
      "1",
      "2",
      "3",
    ]);
    expect(readPageText(getStepRow("lookup"))).not.toMatch(/#\s?\d/);
  });

  it("shows a skipped row with the skipped mark and the word skipped, in the list and the timeline", async () => {
    const user = userEvent.setup();
    await openRunPage(ROUTING_COMPLETED_RUN);
    await findPageHeader();

    const row = getStepRow("escalate");
    expect(readStatusWords(row)).toEqual(["skipped"]);
    expect(row.querySelector('svg[data-mark="skipped"]')).not.toBeNull();

    await user.click(screen.getByRole("radio", { name: "Timeline" }));
    await waitFor(() => {
      expect(getStepsRegion().querySelector('svg[data-mark="skipped"]')).not.toBeNull();
    });
    expect(readPageText(getStepsRegion()).toLowerCase()).toMatch(/\bskipped\b/);
  });
});

/* ------------------------------------------------------------------------ */
/* Agent steps and signal triggers.                                         */
/* ------------------------------------------------------------------------ */

describe("A run's page > agent steps and signals", { timeout: GRAPH_TEST_TIMEOUT_MS }, () => {
  /** Returns the links to a session's thread inside `element`. */
  const listSessionLinks = (element: HTMLElement): readonly HTMLElement[] =>
    within(element)
      .queryAllByRole("link")
      .filter((link) => link.getAttribute("href")?.startsWith("/threads/") === true);

  it("links each record of an agent step to its session, with the session's title and status", async () => {
    await openRunPage(SIGNAL_WAITING_RUN, { sessions: [IMPLEMENT_SESSION] });
    await findPageHeader();

    const rows = listStepRows("implement");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(readPageText(row)).toContain("Agent step");
      const [link, ...others] = listSessionLinks(row);
      expect(others).toEqual([]);
      expect(link?.textContent).toBe("Fix the login bug");
      expect(link?.getAttribute("href")).toBe(`/threads/${IMPLEMENT_SESSION_ID}`);
      expect(readPageText(row)).toMatch(/Session Fix the login bug · idle/);
    }
    // An action step's row and a signal's row have no session.
    expect(listSessionLinks(listStepRows("open_pr")[0]!)).toEqual([]);
    expect(listSessionLinks(listStepRows("checks_failed")[0]!)).toEqual([]);
  });

  it("shows the same session line on the timeline", async () => {
    const user = userEvent.setup();
    await openRunPage(SIGNAL_WAITING_RUN, { sessions: [IMPLEMENT_SESSION] });
    await findPageHeader();

    await user.click(screen.getByRole("radio", { name: "Timeline" }));

    await waitFor(() => {
      expect(listSessionLinks(getStepsRegion())).toHaveLength(3);
    });
    expect(readPageText(getStepsRegion())).toContain("Session Fix the login bug · idle");
  });

  it("names a session it has not read by the tail of its id", async () => {
    await openRunPage(SIGNAL_WAITING_RUN);
    await findPageHeader();

    const [link] = listSessionLinks(listStepRows("implement")[0]!);
    expect(link?.textContent).toBe(`session ${toIdTail(IMPLEMENT_SESSION_ID)}`);
    expect(link?.getAttribute("href")).toBe(`/threads/${IMPLEMENT_SESSION_ID}`);
  });

  it("updates the session line live when the session changes", async () => {
    const { live, holdSessions } = await openRunPage(SIGNAL_WAITING_RUN, {
      sessions: [IMPLEMENT_SESSION],
    });
    await findPageHeader();

    holdSessions([{ ...IMPLEMENT_SESSION, title: "Fix the login redirect", status: "busy" }]);
    await waitFor(() => {
      expect(live.topics()).toContain("session");
    });
    act(() => {
      live.push("session", { _tag: "invalidate", ids: [IMPLEMENT_SESSION_ID], kind: "updated" });
    });

    await waitFor(() => {
      expect(readPageText(listStepRows("implement")[0])).toContain(
        "Session Fix the login redirect · busy",
      );
    });
  });

  it("says in the live hue which signals a running run with nothing left to run waits on", async () => {
    await openRunPage(SIGNAL_WAITING_RUN, { sessions: [IMPLEMENT_SESSION] });

    const header = await findPageHeader();
    expect(readPageText(header)).toMatch(
      /running [^·]+·waiting on checks_failed or pr_merged·started by/,
    );
    const waiting = within(header).getByText(/waiting on/);
    expect(waiting.className).toContain("text-live");
  });

  it("says nothing of signals while a step still runs, or once the run has ended", async () => {
    const running: Run = {
      ...SIGNAL_WAITING_RUN,
      steps: [
        ...SIGNAL_WAITING_RUN.steps.slice(0, -1),
        {
          stepId: "open_pr",
          iteration: 3,
          status: "running",
          startedAt: addSeconds(T0, 261),
        },
      ],
    };
    const { hold, live } = await openRunPage(running);
    expect(readPageText(await findPageHeader())).not.toContain("waiting on");

    hold({ ...SIGNAL_WAITING_RUN, status: "cancelled", finishedAt: addSeconds(T0, 300) });
    await pushRunChange(live, SIGNAL_WAITING_RUN.id);
    await waitFor(() => {
      expect(readPageText(screen.getByRole("main"))).toMatch(/cancelled after/);
    });
    expect(readPageText(await findPageHeader())).not.toContain("waiting on");
  });

  it("shows each time a signal fired as a row labelled Signal that opens to what it holds", async () => {
    const user = userEvent.setup();
    await openRunPage(SIGNAL_WAITING_RUN, { sessions: [IMPLEMENT_SESSION] });
    await findPageHeader();

    const rows = listStepRows("checks_failed");
    expect(rows).toHaveLength(2);
    expect(readPageText(rows[0])).toContain("Signal");
    expect(readStatusWords(rows[0]!)).toEqual(["completed"]);
    // A signal fires at one moment, so its row shows no duration.
    expect(readPageText(rows[0])).not.toMatch(/\dms\b/);
    // A signal that has not fired has no row: it is not a step the run failed to reach.
    expect(listStepRows("pr_merged")).toEqual([]);

    expect(readPageText(rows[0])).not.toContain("failure");
    await user.click(within(rows[0]!).getByRole("button", { expanded: false }));

    await waitFor(() => {
      expect(readPageText(listStepRows("checks_failed")[0])).toContain("failure");
    });
  });

  it("counts on the graph how often a signal fired", async () => {
    await openRunPage(SIGNAL_WAITING_RUN, { sessions: [IMPLEMENT_SESSION] });

    const graph = await findRunGraph();
    await waitFor(() => {
      expect(readPageText(getGraphCard(graph, "implement"))).toMatch(/×\s?3/);
    });
    expect(readPageText(graph)).toMatch(/checks_failed\s?×\s?2/);
    expect(readPageText(graph)).not.toMatch(/pr_merged\s?×/);
  });
});

describe("A run's page > its runner and workspace", () => {
  const RUNNER_ID = "0199c0ff-3333-7000-8000-000000000001";
  const WORKSPACE_ID = "0199c0ff-4444-7000-8000-000000000001";
  const BRANCH = `hercule/run-${RUNNING_RUN.id}`;
  const OFFLINE_RUNNER: RunnerDetail = {
    ...buildRunner(RUNNER_ID, "mac-mini"),
    connectivity: "offline",
    lastSeenAt: addSeconds(T0, 20),
    negotiatedCapabilities: null,
    protocolVersion: null,
  };
  /**
   * The running run, pinned to the runner and working in an ephemeral
   * workspace, with two steps running: `start`, which commits in the
   * workspace, and `note`, which runs on the controller.
   */
  const PINNED_RUN: Run = {
    ...RUNNING_RUN,
    plan: {
      ...PLAN,
      steps: [
        ...PLAN.steps.filter((step) => step.id !== "start"),
        { id: "start", kind: "action", action: "git.commit" },
      ],
    },
    steps: [
      CREATE_DONE,
      { stepId: "note", iteration: 1, status: "running", startedAt: T0 },
      { stepId: "start", iteration: 1, status: "running", startedAt: addSeconds(T0, 12) },
    ],
    runnerId: RUNNER_ID,
    workspaceId: WORKSPACE_ID,
  };
  const ACTIONS = [
    { id: "git.commit", runsIn: "workspace" },
    { id: "task.query", runsIn: "controller" },
  ].map((action) => ({ ...action, displayName: action.id, description: "", inputSchema: {} }));

  it("shows the runner and the workspace, and a running workspace step waits while the runner is offline", async () => {
    let runner = OFFLINE_RUNNER;
    const { live } = await openRunPage(PINNED_RUN, {
      overrides: {
        [`GET /api/v1/runners/${RUNNER_ID}`]: () => ({ body: runner }),
        [`GET /api/v1/workspaces/${WORKSPACE_ID}`]: {
          body: buildWorkspace({
            id: WORKSPACE_ID,
            runnerId: RUNNER_ID,
            kind: "ephemeral",
            checkouts: [
              {
                ...buildCheckout(TASK_ID, BRANCH),
                checkoutId: "0199c0ff-5555-7000-8000-000000000001",
              },
            ],
          }),
        },
        "GET /api/v1/resources": { body: { items: [] } },
        "GET /api/v1/workflow-actions": { body: ACTIONS },
      },
    });

    const header = await findPageHeader();
    const runnerLink = within(header).getByRole("link", { name: "mac-mini" });
    expect(runnerLink.getAttribute("href")).toBe(`/fleet/${RUNNER_ID}`);
    expect(readPageText(header)).toContain(BRANCH);
    expect(readPageText(getStepRow("start"))).toMatch(
      /Waiting for runner mac-mini to reconnect \(offline since .+\)/,
    );
    // Only a running step that runs in the workspace waits for the runner.
    expect(readPageText(getStepRow("create"))).not.toContain("Waiting for runner");
    expect(readPageText(getStepRow("note"))).not.toContain("Waiting for runner");

    // The timeline shows the same line, once.
    await userEvent.setup().click(screen.getByRole("radio", { name: "Timeline" }));
    await waitFor(() => {
      expect(readPageText(getStepsRegion()).match(/Waiting for runner mac-mini/g)).toHaveLength(1);
    });

    runner = { ...OFFLINE_RUNNER, connectivity: "online" };
    await waitFor(() => {
      expect(live.topics()).toContain("runner");
    });
    act(() => {
      live.push("runner", { _tag: "invalidate", ids: [RUNNER_ID], kind: "updated" });
    });

    await waitFor(() => {
      expect(readPageText(getStepsRegion())).not.toContain("Waiting for runner");
    });
  });

  it("shows what runner a pending workspace step waits for while no runner has taken the run", async () => {
    const unpinned: Run = {
      ...RUNNING_RUN,
      plan: PINNED_RUN.plan,
      steps: [
        CREATE_DONE,
        { stepId: "note", iteration: 1, status: "running", startedAt: T0 },
        { stepId: "start", iteration: 1, status: "pending" },
      ],
    };
    await openRunPage(unpinned, {
      overrides: { "GET /api/v1/workflow-actions": { body: ACTIONS } },
    });

    await findPageHeader();
    expect(readPageText(getStepRow("start"))).toContain(
      "Waiting for a runner that can run git.commit",
    );
    expect(readPageText(getStepRow("note"))).not.toContain("Waiting for");
  });
});

describe("A run's page > what happens to its workspace", () => {
  const WORKSPACE_ID = "0199c0ff-4444-7000-8000-000000000002";
  const WORKSPACE = buildWorkspace({
    id: WORKSPACE_ID,
    runnerId: "0199c0ff-3333-7000-8000-000000000002",
    kind: "ephemeral",
  });
  /** The run working in an ephemeral workspace, not yet pinned to a runner. */
  const IN_WORKSPACE: Run = { ...RUNNING_RUN, workspaceId: WORKSPACE_ID };
  /** When the ended runs below ended. */
  const ENDED_AT = "2026-09-24T23:30:00.000Z";
  /** 23:30 UTC on 8 Oct is 9 Oct in Amsterdam, the user's timezone. */
  const KEPT_UNTIL = "2026-10-08T23:30:00.000Z";
  const FAILED_IN_WORKSPACE: Run = {
    ...FAILED_RUN,
    workspaceId: WORKSPACE_ID,
    finishedAt: ENDED_AT,
  };
  const CANCELLED_IN_WORKSPACE: Run = {
    ...CANCELLED_RUN,
    workspaceId: WORKSPACE_ID,
    finishedAt: ENDED_AT,
  };

  /**
   * Opens the page of `run`, whose workspace the stub controller holds as
   * `initial` until the run is cancelled or the workspace is deleted. A cancel
   * keeps the workspace until `KEPT_UNTIL` when it asks to keep it, and until
   * the cancel otherwise, as the controller does. Returns the opened page, and
   * `setWorkspace` to change what the stub controller holds.
   */
  const openWithWorkspace = async (run: Run, initial: Workspace = WORKSPACE) => {
    let workspace = initial;
    const opened = await openRunPage(run, {
      overrides: {
        [`GET /api/v1/workspaces/${WORKSPACE_ID}`]: () => ({ body: workspace }),
        [`DELETE /api/v1/workspaces/${WORKSPACE_ID}`]: () => {
          workspace = { ...WORKSPACE, status: "deleted", disposedAt: "2026-10-03T08:00:00.000Z" };
          return { body: {} };
        },
        "GET /api/v1/resources": { body: { items: [] } },
        [`POST /api/v1/runs/${run.id}/cancel`]: (call) => {
          const keeps = (call.body as { keepWorkspace?: boolean }).keepWorkspace === true;
          workspace = { ...workspace, keptUntil: keeps ? KEPT_UNTIL : ENDED_AT };
          return { body: CANCELLED_IN_WORKSPACE };
        },
      },
    });
    return {
      ...opened,
      setWorkspace: (next: Workspace) => {
        workspace = next;
      },
    };
  };

  const getWorkspaceCheckbox = (): HTMLInputElement =>
    screen.getByRole("checkbox", { name: "Delete workspace" });

  it("asks on cancel whether to delete the workspace too, ticked by default, and says until when a kept one is kept", async () => {
    const user = userEvent.setup();
    const { api } = await openWithWorkspace(IN_WORKSPACE);

    const header = await findPageHeader();
    await user.click(within(header).getByRole("button", { name: "Cancel" }));
    expect(getWorkspaceCheckbox().checked).toBe(true);
    await user.click(getWorkspaceCheckbox());
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(listCancels(api, IN_WORKSPACE.id).map((call) => call.body)).toEqual([
        { keepWorkspace: true },
      ]);
    });
    // The cancel fixed until when the workspace is kept, and the page reads
    // the workspace again without a reload.
    await waitFor(() => {
      expect(readPageText(header)).toContain("Workspace kept until 9 Oct");
    });
  });

  it("deletes the workspace on cancel when the box stays ticked, and says it will be deleted shortly", async () => {
    const user = userEvent.setup();
    const { api } = await openWithWorkspace(IN_WORKSPACE);

    const header = await findPageHeader();
    await user.click(within(header).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(listCancels(api, IN_WORKSPACE.id).map((call) => call.body)).toEqual([
        { keepWorkspace: false },
      ]);
    });
    // The workspace exists until the controller's next sweep deletes it.
    await waitFor(() => {
      expect(readPageText(header)).toContain("Workspace will be deleted shortly");
    });
    expect(within(header).queryByRole("button", { name: "Delete workspace" })).toBeNull();
  });

  it("does not ask about a workspace when the run has none", async () => {
    const user = userEvent.setup();
    await openRunPage(RUNNING_RUN);

    await user.click(within(await findPageHeader()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("says until when a failed run's workspace is kept, and after Delete workspace, when it was deleted", async () => {
    const user = userEvent.setup();
    const { api } = await openWithWorkspace(FAILED_IN_WORKSPACE, {
      ...WORKSPACE,
      keptUntil: KEPT_UNTIL,
    });

    const header = await findPageHeader();
    await waitFor(() => {
      expect(readPageText(header)).toContain("Workspace kept until 9 Oct");
    });

    await user.click(within(header).getByRole("button", { name: "Delete workspace" }));
    // Nothing is deleted until the question is answered.
    const confirm = screen.getByRole("button", { name: "Delete" });
    expect(api.calls.filter((call) => call.method === "DELETE")).toEqual([]);
    await user.click(confirm);

    await waitFor(() => {
      expect(readPageText(header)).toContain("Workspace deleted 3 Oct");
    });
    expect(readPageText(header)).not.toContain("Workspace kept");
    expect(within(header).queryByRole("button", { name: "Delete workspace" })).toBeNull();
    expect(api.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      `/api/v1/workspaces/${WORKSPACE_ID}`,
    ]);
  });

  it("reads the workspace again when the run ends while the page is open", async () => {
    const { hold, live, setWorkspace } = await openWithWorkspace(IN_WORKSPACE);
    const header = await findPageHeader();

    // The run fails, which releases its lease as the controller records it.
    setWorkspace({ ...WORKSPACE, keptUntil: KEPT_UNTIL });
    hold(FAILED_IN_WORKSPACE);
    await pushRunChange(live, IN_WORKSPACE.id);

    await waitFor(() => {
      expect(readPageText(header)).toContain("Workspace kept until 9 Oct");
    });
  });
});

describe("A run's page > a run a trigger started", () => {
  const ISSUE_URL = "https://github.com/acme/api/issues/7";

  const BY_TRIGGER: Run = {
    ...COMPLETED_RUN,
    origin: { kind: "trigger", triggerId: "on_issue", eventId: 42 },
    triggerEvent: {
      id: 42,
      source: "github",
      connectionId: "0199c0ff-3333-7000-8000-000000000001",
      system: "github",
      kind: "github.issue.opened",
      occurredAt: "2026-09-27T15:21:08.000Z",
      receivedAt: "2026-09-27T15:21:09.000Z",
      dedupKey: "delivery-1",
      refs: [],
      url: ISSUE_URL,
      payload: { issue: { number: 7, title: "Login fails" } },
      actor: null,
    },
  };

  /**
   * A run whose trigger matched an event, but whose inputs did not validate.
   * The run never started, so it has no start time and no step records.
   */
  const INVALID_RUN: Run = {
    id: "0199c0ff-2222-7000-8000-000000000009",
    workflowId: WORKFLOW_ID,
    plan: PLAN,
    inputs: {},
    origin: { kind: "trigger", triggerId: "on_issue", eventId: 43 },
    subscriptions: [],
    status: "failed",
    failureReason: "validation-error",
    failureMessage: "The input title is required, and the trigger's mapping gave it no value.",
    steps: [],
    edgeTraversals: [],
    createdAt: T0,
    finishedAt: addSeconds(T0, 1),
  };

  it("names the trigger and the kind of event that started the run in the header", async () => {
    await openRunPage(BY_TRIGGER);

    const header = await findPageHeader();
    expect(readPageText(header)).toContain("started by trigger on_issue on github.issue.opened");
  });

  it("shows the triggering event above the inputs: its kind, source, time, id, link and payload", async () => {
    await openRunPage(BY_TRIGGER);
    await findPageHeader();

    const block = screen.getByRole("region", { name: "Triggering event" });
    // Each fact is a term and its description, read here as pairs.
    const facts = Object.fromEntries(
      [...block.querySelectorAll("dt")].map((term) => [
        readPageText(term),
        readPageText(term.nextElementSibling as HTMLElement),
      ]),
    );
    expect(facts).toEqual({
      kind: "github.issue.opened",
      source: "github",
      occurred: "27 Sep 17:21:08",
      event: "42 Open",
    });
    expect(block.querySelector("time")?.dateTime).toBe(BY_TRIGGER.triggerEvent?.occurredAt);
    expect(within(block).getByRole("link", { name: "Open" }).getAttribute("href")).toBe(ISSUE_URL);
    // The payload shows as JSON, keys and strings quoted.
    expect(readPageText(block)).toContain('"title": "Login fails"');
    const inputs = screen.getByRole("region", { name: "Inputs" });
    expect(block.compareDocumentPosition(inputs) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("links the triggering event only when its address is http or https", async () => {
    const triggerEvent = BY_TRIGGER.triggerEvent;
    if (triggerEvent === undefined) throw new Error("BY_TRIGGER has no triggering event");
    await openRunPage({
      ...BY_TRIGGER,
      triggerEvent: { ...triggerEvent, url: "data:text/html,<h1>Sign in</h1>" },
    });
    await findPageHeader();

    const block = screen.getByRole("region", { name: "Triggering event" });
    expect(within(block).queryByRole("link")).toBeNull();
    expect(readPageText(block)).not.toContain("Open");
  });

  it("shows no triggering event for a run the user started", async () => {
    await openRunPage(COMPLETED_RUN);
    await findPageHeader();

    expect(screen.queryByRole("region", { name: "Triggering event" })).toBeNull();
  });

  it("shows why a run whose inputs did not validate failed, from when it was created", async () => {
    await openRunPage(INVALID_RUN);

    const header = await findPageHeader();
    const text = readPageText(header);
    expect(text).toMatch(/validation error/i);
    expect(text).toContain(INVALID_RUN.failureMessage);
    expect(text).toContain("started by trigger on_issue");
    const times = [...header.querySelectorAll("time")].map((time) => time.dateTime);
    expect(times).toEqual([INVALID_RUN.createdAt, INVALID_RUN.finishedAt]);
  });
});

describe("A run's page > the output", () => {
  it("shows the run's output in an Output card under the inputs", async () => {
    await openRunPage(ROUTING_COMPLETED_RUN);
    await findPageHeader();

    const output = screen.getByRole("region", { name: "Output" });
    const text = readPageText(output);
    expect(text).toContain("t_1");
    expect(text).toContain("in-progress");
    const inputs = screen.getByRole("region", { name: "Inputs" });
    expect(inputs.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    { run: COMPLETED_RUN, status: "completed" },
    { run: FAILED_RUN, status: "failed" },
  ])("shows no Output card on a $status run with no output", async ({ run }) => {
    await openRunPage(run);
    await findPageHeader();

    expect(screen.queryByRole("region", { name: "Output" })).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
/* Re-running a run, and the runs on either side of a re-run.               */
/* ------------------------------------------------------------------------ */

/** The run that re-running the completed run starts. */
const RERUN: Run = {
  ...COMPLETED_RUN,
  id: "0199c0ff-2222-7000-8000-000000000021",
  originalRunId: COMPLETED_RUN.id,
};

/** A completed run of a workflow that was sent with `run.start` and never stored. */
const SENT_WORKFLOW_RUN: Run = {
  ...COMPLETED_RUN,
  id: "0199c0ff-2222-7000-8000-000000000022",
  workflowId: null,
};

const RERUN_QUESTION = "Re-run with the same inputs?";

/** Waits for the re-run question: the group named by the question, which holds its controls. */
const findRerunQuestion = (): Promise<HTMLElement> =>
  screen.findByRole("group", { name: RERUN_QUESTION });

/**
 * Returns the header's line that links the runs on either side of a re-run,
 * the text that starts "re-run of" or "re-run as", or `null` when the header
 * has none.
 */
const queryRerunLine = (header: HTMLElement): HTMLElement | null =>
  within(header).queryByText(/^re-run (of|as)\b/);

/** Returns the smallest element that holds both `a` and `b`. */
const findSmallestCommonAncestor = (a: HTMLElement, b: HTMLElement): HTMLElement => {
  let ancestor: HTMLElement | null = a;
  while (ancestor !== null && !ancestor.contains(b)) ancestor = ancestor.parentElement;
  if (ancestor === null) throw new Error("the two elements are not in one document");
  return ancestor;
};

/** Returns the header's link to run `id`, named by its id's tail. */
const getHeaderRunLink = (header: HTMLElement, id: string): HTMLElement =>
  within(header).getByRole("link", { name: `run ${toIdTail(id)}` });

describe("A run's page > Re-run", () => {
  it.each([
    { run: COMPLETED_RUN, status: "completed" },
    { run: FAILED_RUN, status: "failed" },
    { run: CANCELLED_RUN, status: "cancelled" },
  ])("offers Re-run on a $status run", async ({ run }) => {
    await openRunPage(run);
    expect(within(await findPageHeader()).getByRole("button", { name: "Re-run" })).toBeDefined();
  });

  it("offers no Re-run while the run is running", async () => {
    await openRunPage(RUNNING_RUN);
    expect(within(await findPageHeader()).queryByRole("button", { name: "Re-run" })).toBeNull();
  });

  it("asks which workflow the new run follows, from the current workflow by default, and explains each choice", async () => {
    const user = userEvent.setup();
    const { api } = await openRunPage(COMPLETED_RUN);

    await user.click(within(await findPageHeader()).getByRole("button", { name: "Re-run" }));

    const question = await findRerunQuestion();
    const current = within(question).getByRole("radio", { name: "From the current workflow" });
    const asItRan = within(question).getByRole("radio", { name: "As it ran" });
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(readPageText(question)).toContain("the workflow as it is saved now");

    await user.click(asItRan);

    expect(asItRan.getAttribute("aria-checked")).toBe("true");
    expect(readPageText(question)).toContain("as it was frozen when the run started");
    // Nothing is re-run until the question is answered.
    expect(listReruns(api, COMPLETED_RUN.id)).toEqual([]);
  });

  it("puts the focus on Cancel when the question shows, and back on Re-run after Cancel", async () => {
    const user = userEvent.setup();
    const { api } = await openRunPage(COMPLETED_RUN);

    await user.click(within(await findPageHeader()).getByRole("button", { name: "Re-run" }));
    const decline = within(await findRerunQuestion()).getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(decline);

    await user.click(decline);

    expect(screen.queryByRole("group", { name: RERUN_QUESTION })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Re-run" }));
    expect(listReruns(api, COMPLETED_RUN.id)).toEqual([]);
  });

  it("re-runs from the current workflow on confirm, and goes to the new run, which links back", async () => {
    const user = userEvent.setup();
    const { api, router } = await openRunPage(COMPLETED_RUN, {
      overrides: {
        [`POST /api/v1/runs/${COMPLETED_RUN.id}/rerun`]: { body: { runId: RERUN.id } },
        [`GET /api/v1/runs/${RERUN.id}`]: { body: RERUN },
      },
    });

    await user.click(within(await findPageHeader()).getByRole("button", { name: "Re-run" }));
    await user.click(within(await findRerunQuestion()).getByRole("button", { name: "Re-run" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/runs/${RERUN.id}`);
    });
    expect(listReruns(api, COMPLETED_RUN.id).map((call) => call.body)).toEqual([
      { mode: "re-stamp" },
    ]);
    const header = await findPageHeader();
    await waitFor(() => {
      expect(getHeaderRunLink(header, COMPLETED_RUN.id).getAttribute("href")).toBe(
        `/runs/${COMPLETED_RUN.id}`,
      );
    });
  });

  it("re-runs as it ran when that is picked", async () => {
    const user = userEvent.setup();
    const { api } = await openRunPage(COMPLETED_RUN, {
      overrides: {
        [`POST /api/v1/runs/${COMPLETED_RUN.id}/rerun`]: { body: { runId: RERUN.id } },
        [`GET /api/v1/runs/${RERUN.id}`]: { body: RERUN },
      },
    });

    await user.click(within(await findPageHeader()).getByRole("button", { name: "Re-run" }));
    const question = await findRerunQuestion();
    await user.click(within(question).getByRole("radio", { name: "As it ran" }));
    await user.click(within(question).getByRole("button", { name: "Re-run" }));

    await waitFor(() => {
      expect(listReruns(api, COMPLETED_RUN.id).map((call) => call.body)).toEqual([
        { mode: "replay" },
      ]);
    });
  });

  it("offers a run of a workflow that was never stored only a re-run as it ran, and says why", async () => {
    const user = userEvent.setup();
    const { api } = await openRunPage(SENT_WORKFLOW_RUN, {
      overrides: {
        [`POST /api/v1/runs/${SENT_WORKFLOW_RUN.id}/rerun`]: { body: { runId: RERUN.id } },
        [`GET /api/v1/runs/${RERUN.id}`]: { body: RERUN },
      },
    });

    await user.click(within(await findPageHeader()).getByRole("button", { name: "Re-run" }));
    const question = await findRerunQuestion();
    expect(within(question).queryAllByRole("radio")).toEqual([]);
    expect(readPageText(question)).toContain("never saved");

    await user.click(within(question).getByRole("button", { name: "Re-run" }));

    await waitFor(() => {
      expect(listReruns(api, SENT_WORKFLOW_RUN.id).map((call) => call.body)).toEqual([
        { mode: "replay" },
      ]);
    });
  });

  it("offers a run whose workflow was deleted only a re-run as it ran, and says why", async () => {
    const user = userEvent.setup();
    const { api } = await openRunPage(COMPLETED_RUN, {
      overrides: {
        [WORKFLOW_READ]: WORKFLOW_DELETED,
        [`POST /api/v1/runs/${COMPLETED_RUN.id}/rerun`]: { body: { runId: RERUN.id } },
        [`GET /api/v1/runs/${RERUN.id}`]: { body: RERUN },
      },
    });

    await user.click(within(await findPageHeader()).getByRole("button", { name: "Re-run" }));
    const question = await findRerunQuestion();
    expect(within(question).queryAllByRole("radio")).toEqual([]);
    expect(readPageText(question)).toContain("workflow was deleted");

    await user.click(within(question).getByRole("button", { name: "Re-run" }));

    await waitFor(() => {
      expect(listReruns(api, COMPLETED_RUN.id).map((call) => call.body)).toEqual([
        { mode: "replay" },
      ]);
    });
  });

  it("offers only a re-run as it ran once the workflow is deleted while the question shows", async () => {
    const user = userEvent.setup();
    let isDeleted = false;
    const { api, live } = await openRunPage(COMPLETED_RUN, {
      overrides: {
        [WORKFLOW_READ]: () =>
          isDeleted
            ? WORKFLOW_DELETED
            : {
                body: { id: WORKFLOW_ID, enabled: true, source: "", createdAt: T0, updatedAt: T0 },
              },
        [`POST /api/v1/runs/${COMPLETED_RUN.id}/rerun`]: { body: { runId: RERUN.id } },
        [`GET /api/v1/runs/${RERUN.id}`]: { body: RERUN },
      },
    });
    await user.click(within(await findPageHeader()).getByRole("button", { name: "Re-run" }));
    const question = await findRerunQuestion();
    expect(within(question).getAllByRole("radio")).toHaveLength(2);

    isDeleted = true;
    await waitFor(() => {
      expect(live.topics()).toContain("workflow");
    });
    act(() => {
      live.push("workflow", { _tag: "invalidate", ids: [WORKFLOW_ID], kind: "deleted" });
    });

    await waitFor(() => {
      expect(within(question).queryAllByRole("radio")).toEqual([]);
    });
    expect(readPageText(question)).toContain("workflow was deleted");
    await user.click(within(question).getByRole("button", { name: "Re-run" }));
    await waitFor(() => {
      expect(listReruns(api, COMPLETED_RUN.id).map((call) => call.body)).toEqual([
        { mode: "replay" },
      ]);
    });
  });

  it("stays on the run and says why in full, on a row of its own, when the controller refuses the re-run", async () => {
    const user = userEvent.setup();
    const message =
      "This run's workflow has been deleted, so there is no stored workflow to re-stamp from. Replay the original run's plan instead.";
    const { router } = await openRunPage(COMPLETED_RUN, {
      overrides: {
        [`POST /api/v1/runs/${COMPLETED_RUN.id}/rerun`]: {
          status: 409,
          body: buildErrorBody("invalid_state", message),
        },
      },
    });

    const header = await findPageHeader();
    await user.click(within(header).getByRole("button", { name: "Re-run" }));
    await user.click(within(await findRerunQuestion()).getByRole("button", { name: "Re-run" }));

    const alert = await within(header).findByRole("alert");
    expect(alert.textContent).toBe(`Not re-run: ${message}`);
    expect(alert.className).not.toContain("truncate");
    // The title and the Re-run button share the title row, and the refusal
    // is not on it.
    const title = within(header).getByRole("heading", { level: 1, name: WORKFLOW_NAME });
    const titleRow = findSmallestCommonAncestor(
      title,
      within(header).getByRole("button", { name: "Re-run" }),
    );
    expect(titleRow).not.toBe(header);
    expect(titleRow.contains(alert)).toBe(false);
    expect(router.state.location.pathname).toBe(`/runs/${COMPLETED_RUN.id}`);
  });

  it("starts no second run when Re-run is clicked again while the first re-run is still starting", async () => {
    const user = userEvent.setup();
    let answerRerun: () => void = () => undefined;
    const { api, router } = await openRunPage(COMPLETED_RUN, {
      overrides: {
        [`POST /api/v1/runs/${COMPLETED_RUN.id}/rerun`]: () =>
          new Promise((resolve) => {
            answerRerun = () => {
              resolve({ body: { runId: RERUN.id } });
            };
          }),
        [`GET /api/v1/runs/${RERUN.id}`]: { body: RERUN },
      },
    });

    const header = await findPageHeader();
    await user.click(within(header).getByRole("button", { name: "Re-run" }));
    await user.click(within(await findRerunQuestion()).getByRole("button", { name: "Re-run" }));
    await waitFor(() => {
      expect(listReruns(api, COMPLETED_RUN.id)).toHaveLength(1);
    });

    // The first re-run is still starting: Re-run shows again, but asks nothing.
    const again = within(header).getByRole("button", { name: "Re-run" });
    expect(again.getAttribute("aria-disabled")).toBe("true");
    await user.click(again);
    expect(screen.queryByRole("group", { name: RERUN_QUESTION })).toBeNull();

    answerRerun();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/runs/${RERUN.id}`);
    });
    expect(listReruns(api, COMPLETED_RUN.id)).toHaveLength(1);
  });
});

describe("A run's page > the runs on either side of a re-run", () => {
  it("links the run this run is a re-run of", async () => {
    await openRunPage(RERUN);

    const header = await findPageHeader();
    expect(readPageText(queryRerunLine(header))).toBe(
      `re-run of run ${toIdTail(COMPLETED_RUN.id)}`,
    );
    expect(getHeaderRunLink(header, COMPLETED_RUN.id).getAttribute("href")).toBe(
      `/runs/${COMPLETED_RUN.id}`,
    );
  });

  it("links the runs that re-ran this run, newest first, and counts the rest past three", async () => {
    const ids = [1, 2, 3, 4, 5].map((n) => `0199c0ff-3333-7000-8000-00000000000${String(n)}`);
    const { api } = await openRunPage(COMPLETED_RUN, { reruns: ids.map(buildRerunSummary) });

    const header = await findPageHeader();
    const tails = ids.map(toIdTail);
    expect(readPageText(queryRerunLine(header))).toBe(
      `re-run as run ${tails[0] ?? ""}, run ${tails[1] ?? ""}, run ${tails[2] ?? ""} and 2 more`,
    );
    for (const id of ids.slice(0, 3)) {
      expect(getHeaderRunLink(header, id).getAttribute("href")).toBe(`/runs/${id}`);
    }
    expect(
      api.calls.some(
        (call) =>
          call.path === "/api/v1/runs" &&
          new URLSearchParams(call.search).get("originalRunId") === COMPLETED_RUN.id,
      ),
    ).toBe(true);
  });

  it("shows no such line for a run that is not a re-run and was not re-run", async () => {
    await openRunPage(COMPLETED_RUN);

    expect(queryRerunLine(await findPageHeader())).toBeNull();
  });

  it("links a re-run that starts while the page is open, when it is pushed on the run topic", async () => {
    const { live, holdReruns } = await openRunPage(COMPLETED_RUN);
    const header = await findPageHeader();
    expect(queryRerunLine(header)).toBeNull();

    holdReruns([buildRerunSummary(RERUN.id)]);
    await pushRunChange(live, RERUN.id, "created");

    await waitFor(() => {
      expect(readPageText(queryRerunLine(header))).toBe(`re-run as run ${toIdTail(RERUN.id)}`);
    });
  });
});
