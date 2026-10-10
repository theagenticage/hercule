/**
 * PROTOTYPE. Tests the open workflow's route:
 *
 * - the header's button that hides the list and shows it again keeps the
 *   workflow open;
 * - a run's row opens the run's own page;
 * - the workflow's switch and a start trigger's switch save when pressed,
 *   and go back to the saved value when the save fails;
 * - a workflow's mark in the list pops in when its state changes, and is
 *   drawn still when the list opens.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  renderWorkflowSource,
  type Run,
  type RunSummary,
  type Trigger,
  type Workflow,
  type WorkflowDefinition,
} from "@hercule/contract";
import { agentsQuery } from "../../../../app/queries";
import type { Handler } from "../../../../app/testing";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  NO_SIDEBAR_RECORDS,
  renderApp,
  stubApi,
  stubElementSize,
} from "../../../../app/testing";
import type { WorkflowListEntry } from "../../../../screens/workflows/proposed-contract";
import {
  runQuery,
  runSessionsQuery,
  triggersQuery,
  waitingRunSessionsQuery,
  workflowActionsQuery,
  workflowListQuery,
  workflowQuery,
  workflowRunsQuery,
  workflowTriggersQuery,
} from "../../../../screens/workflows/workflow-queries";

const WORKFLOW_ID = "01a0ec64-6e80-7000-8000-c00000000001";
const AT = "2026-10-01T09:00:00.000Z";

/** A workflow of one action step, which a schedule starts, and which the user started twice. */
const DEFINITION: WorkflowDefinition = {
  name: "Nightly backup",
  triggers: [{ id: "nightly", kind: "start", on: { schedule: "0 2 * * *" } }],
  steps: [{ id: "dump", kind: "action", action: "github/pr.create" }],
};

/** The workflow's one trigger, as the controller stores it. */
const NIGHTLY: Trigger = {
  workflowId: "01a0ec64-6e80-7000-8000-c00000000001",
  workflowName: "Nightly backup",
  triggerId: "nightly",
  kind: "start",
  on: { schedule: "0 2 * * *" },
  status: "active",
  createdAt: "2026-10-01T09:00:00.000Z",
  updatedAt: "2026-10-01T09:00:00.000Z",
};

/** Returns a completed run of the workflow, created at `createdAt`. */
const buildRun = (id: string, createdAt: string): Run => ({
  id,
  workflowId: WORKFLOW_ID,
  plan: DEFINITION,
  inputs: {},
  origin: { kind: "manual", actor: "user" },
  steps: [
    {
      stepId: "dump",
      iteration: 1,
      status: "completed",
      startedAt: createdAt,
      finishedAt: createdAt,
      output: null,
    },
  ],
  edgeTraversals: [],
  subscriptions: [],
  createdAt,
  status: "completed",
  startedAt: createdAt,
  finishedAt: createdAt,
});

/** The workflow's runs, newest first. */
const RUNS = [
  buildRun("01a0ec64-6e80-7000-8000-d00000000002", "2026-10-02T09:00:00.000Z"),
  buildRun("01a0ec64-6e80-7000-8000-d00000000001", AT),
];
const OLDER_RUN_ID = RUNS[1]!.id;

const WORKFLOW: Workflow = {
  id: WORKFLOW_ID,
  enabled: true,
  source: renderWorkflowSource(DEFINITION),
  createdAt: AT,
  updatedAt: AT,
};

const LIST_ENTRY: WorkflowListEntry = {
  id: WORKFLOW_ID,
  name: DEFINITION.name,
  enabled: true,
  updatedAt: AT,
  recentRuns: RUNS.map((run) => ({
    id: run.id,
    status: run.status,
    waitingOnUser: false,
    createdAt: run.createdAt,
    stepIds: [],
  })),
};

const SUMMARIES: ReadonlyArray<RunSummary> = RUNS.map((run) => ({
  id: run.id,
  workflowId: WORKFLOW_ID,
  workflowName: DEFINITION.name,
  origin: run.origin,
  createdAt: run.createdAt,
  status: "completed",
  startedAt: run.createdAt,
  finishedAt: run.createdAt,
}));

/**
 * Starts the app signed in at `path`, with the workflow's records in the
 * query cache, since the contract cannot serve the list's recent runs yet.
 * `handlers` answer the operations a test sends. Returns the app and the
 * calls the stubbed API received.
 */
const openApp = async (path: string, handlers: Readonly<Record<string, Handler>> = {}) => {
  const calls = stubApi({ ...buildSidebarHandlers(NO_SIDEBAR_RECORDS), ...handlers });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    {
      path,
      seed: ({ queryClient, controller }) => {
        if (controller === null) throw new Error("the app has no controller to read from");
        const client = controller.client;
        queryClient.setQueryData(workflowListQuery().queryKey, [LIST_ENTRY]);
        queryClient.setQueryData(workflowQuery(client, WORKFLOW_ID).queryKey, WORKFLOW);
        queryClient.setQueryData(workflowTriggersQuery(client, WORKFLOW_ID).queryKey, [NIGHTLY]);
        queryClient.setQueryData(triggersQuery(client).queryKey, [NIGHTLY]);
        queryClient.setQueryData(waitingRunSessionsQuery().queryKey, []);
        queryClient.setQueryData(agentsQuery(client).queryKey, []);
        queryClient.setQueryData(workflowActionsQuery(client).queryKey, []);
        queryClient.setQueryData(workflowRunsQuery(client, WORKFLOW_ID).queryKey, {
          pages: [{ items: SUMMARIES }],
          pageParams: [undefined],
        });
        for (const run of RUNS) {
          queryClient.setQueryData(runQuery(client, run.id).queryKey, run);
          queryClient.setQueryData(runSessionsQuery(client, run.id).queryKey, []);
        }
      },
    },
  );
  return { ...app, calls };
};

describe("the open workflow's route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hides the list and shows it again, keeping the workflow open", async () => {
    const { router } = await openApp(`/workflows/${WORKFLOW_ID}`);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Hide the list" }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({ full: true });
    });
    expect(router.state.location.pathname).toBe(`/workflows/${WORKFLOW_ID}`);
    expect(screen.getByRole("region", { name: "Nightly backup" })).toBeDefined();
    expect(document.querySelector(".wf-list")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Show the list" }));
    await waitFor(() => {
      expect(router.state.location.search).toEqual({});
    });
    expect(screen.getByRole("region", { name: "Nightly backup" })).toBeDefined();
    expect(document.querySelector(".wf-list")).not.toBeNull();
  });

  it("opens a run's page from its row", async () => {
    const { router } = await openApp(`/workflows/${WORKFLOW_ID}?full=true`);
    const user = userEvent.setup();

    // The rows are newest first, so the second is the older run.
    const rows = screen.getAllByRole("button", { name: /^Completed, started by You/ });
    await user.click(rows[1]!);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/runs/${OLDER_RUN_ID}`);
    });
    expect(await screen.findByRole("link", { name: "Nightly backup" })).toBeDefined();
  });

  it("turns the workflow off with its switch", async () => {
    const { calls } = await openApp(`/workflows/${WORKFLOW_ID}?full=true`, {
      [`PATCH /api/v1/workflows/${WORKFLOW_ID}`]: {
        body: { workflow: { ...WORKFLOW, enabled: false }, warnings: [] },
      },
    });
    const user = userEvent.setup();

    const toggle = screen.getByRole("switch", { name: "Enabled" });
    await user.click(toggle);
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({ enabled: false });
  });

  it("puts the workflow's switch back and says why when the save fails", async () => {
    await openApp(`/workflows/${WORKFLOW_ID}?full=true`, {
      [`PATCH /api/v1/workflows/${WORKFLOW_ID}`]: {
        status: 500,
        body: buildErrorBody("internal", "The database is locked."),
      },
    });
    const user = userEvent.setup();

    const toggle = screen.getByRole("switch", { name: "Enabled" });
    await user.click(toggle);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not save: The database is locked.",
    );
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("pauses a start trigger with its switch", async () => {
    const { calls } = await openApp(`/workflows/${WORKFLOW_ID}?full=true`, {
      [`POST /api/v1/workflows/${WORKFLOW_ID}/triggers/nightly/pause`]: {
        body: { ...NIGHTLY, status: "paused" },
      },
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /^Triggers/ }));
    const toggle = screen.getByRole("switch", { name: "nightly starts runs" });
    await user.click(toggle);
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false");
    });
    expect(
      calls.some((call) => call.path === `/api/v1/workflows/${WORKFLOW_ID}/triggers/nightly/pause`),
    ).toBe(true);
  });
});

describe("the list beside the open workflow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("pops in a workflow's mark when its state changes, and draws it still when the list opens", async () => {
    // The list is virtualized, and draws no rows in a page that measures 0.
    stubElementSize(320, 800);
    const { context } = await openApp(`/workflows/${WORKFLOW_ID}`);
    const row = await screen.findByRole("link", { name: "Nightly backup" });
    expect(row.querySelector(".wl-mark.is-new")).toBeNull();

    // A new run starts, so the workflow's mark changes from done to working.
    const started = { ...LIST_ENTRY.recentRuns[0]!, id: "01a0ec64-6e80-7000-8000-d00000000003" };
    context.queryClient.setQueryData(workflowListQuery().queryKey, [
      { ...LIST_ENTRY, recentRuns: [{ ...started, status: "running" }, ...LIST_ENTRY.recentRuns] },
    ]);
    await waitFor(() => {
      expect(row.querySelector(".wl-mark.is-new > .mark--working")).not.toBeNull();
    });
  });
});
