/**
 * Tests for a run's page at `/runs/$runId`: the header, the inputs, the run
 * graph with each step's state on it, the steps below it as a list or a
 * timeline, Cancel, and live updates.
 *
 * The stub controller holds one run at a time. A test replaces it, as the run
 * engine would change it, and pushes the change on the `run` topic.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describeActor } from "@hercule/client-core";
import type { Run, StepStatus, WorkflowDefinition } from "@hercule/contract";
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

/* ------------------------------------------------------------------------ */
/* The stub controller.                                                      */
/* ------------------------------------------------------------------------ */

/**
 * Renders the run's page against a stub controller that holds `run`. The
 * run's workflow is gone from the controller in every test, which the page
 * must not need: everything it shows comes from the run.
 * - `overrides` replaces the handler of a route, or adds a route.
 *
 * Returns the app, the stubbed API, and `hold`, which replaces the run the
 * controller holds from now on.
 */
const openRunPage = async (
  run: Run,
  { overrides = {} }: { readonly overrides?: Readonly<Record<string, Handler>> } = {},
) => {
  let held = run;
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
    [`GET /api/v1/workflows/${WORKFLOW_ID}`]: {
      status: 404,
      body: buildErrorBody("not_found", "No workflow has that id."),
    },
    "GET /api/v1/workflows": { body: { items: [] } },
    "GET /api/v1/workflow-actions": { body: [] },
    ...overrides,
  });
  const app = await renderApp({ path: `/runs/${run.id}`, api: api.fetch, token: "held" });
  return {
    ...app,
    api,
    hold: (next: Run): void => {
      held = next;
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

/** Sends an `updated` push for the run with `id` on the `run` topic, once the page has subscribed. */
const pushRunUpdate = async (live: LiveStub, id: string): Promise<void> => {
  await waitFor(() => {
    expect(live.topics()).toContain("run");
  });
  act(() => {
    live.push("run", { _tag: "invalidate", ids: [id], kind: "updated" });
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
    await pushRunUpdate(live, RUNNING_RUN.id);

    await waitFor(() => {
      expect(readStatusWords(getStepRow("start"))).toEqual(["completed"]);
    });
    expect(readPageText(await findPageHeader()).toLowerCase()).toContain("completed");
    expect(within(await findPageHeader()).queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("shows everything from the run when its workflow was deleted", async () => {
    await openRunPage(COMPLETED_RUN);

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
    await pushRunUpdate(live, RUNNING_RUN.id);

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
