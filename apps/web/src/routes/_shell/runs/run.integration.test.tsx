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
        user: { "onboarding.completedSteps": ["timezone"], timezone: "Europe/Amsterdam" },
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
