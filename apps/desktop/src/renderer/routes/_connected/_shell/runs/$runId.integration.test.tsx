/**
 * Tests a run's page: the Runs tab's rows and bars that open it, its crumb
 * and lead, a node's card and Open thread, the Cancel, Re-run and Delete
 * workspace dialogs, a workflow that is gone, Esc, and a run that does not
 * exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Run, RunSummary, Session, Workflow, Workspace } from "@hercule/contract";
import { buildRunner, buildSession, buildWorkspace } from "@hercule/client-core/threads/testing";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  NO_SIDEBAR_RECORDS,
  renderApp,
  stubApi,
  stubElementSize,
  stubIntersectionObserver,
  type Call,
  type Handler,
} from "../../../../app/testing";

// Every element measures as wide as a window that shows every column, and
// every timeline bar is on screen.
beforeEach(() => {
  stubElementSize(1168, 800);
  stubIntersectionObserver();
  // Sunday 11 October 2026, 10:00 in UTC, the time zone the settings name.
  vi.useFakeTimers({ now: new Date("2026-10-11T10:00:00.000Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

const AT = "2026-09-01T00:00:00.000Z";
const SHIP_ID = "01a06d02-7800-7000-8000-000000000001";
const RUN_ID = "01a06d02-7900-7000-8000-000000000001";
const RERUN_ID = "01a06d02-7900-7000-8000-000000000009";
const SESSION_ID = "01a06d02-7a00-7000-8000-000000000001";
const RUNNER_ID = "01a06d02-7c00-7000-8000-000000000001";
const WORKSPACE_ID = "01a06d02-7d00-7000-8000-000000000001";

/** Ship release: a nightly schedule starts it; an agent reviews, then a pull request opens. */
const SOURCE = `name: Ship release
inputs:
  - name: version
    schema:
      type: string
    required: true
triggers:
  - id: nightly
    kind: start
    on:
      schedule: "0 1 * * *"
steps:
  - id: review
    kind: agent
    agent: 01a06d02-7b00-7000-8000-000000000001
    prompt: Review the main branch.
  - id: open_pr
    kind: action
    action: github/pr.create
edges:
  - from: review
    to: open_pr
`;

const SHIP: Workflow = { id: SHIP_ID, enabled: true, source: SOURCE, createdAt: AT, updatedAt: AT };

const PLAN: Run["plan"] = {
  name: "Ship release",
  inputs: [{ name: "version", schema: { type: "string" }, required: true }],
  triggers: [{ id: "nightly", kind: "start", on: { schedule: "0 1 * * *" } }],
  steps: [
    {
      id: "review",
      kind: "agent",
      agent: "01a06d02-7b00-7000-8000-000000000001",
      prompt: "Review the main branch.",
    },
    { id: "open_pr", kind: "action", action: "github/pr.create" },
  ],
  edges: [{ from: "review", to: "open_pr" }],
};

/**
 * The fields every run here shares: started by the user with version 2.14.0,
 * in the workspace. Each run starts half a minute after it was created.
 */
const RUN_FIELDS = {
  id: RUN_ID,
  workflowId: SHIP_ID,
  plan: PLAN,
  inputs: { version: "2.14.0" },
  origin: { kind: "manual", actor: "user" },
  runnerId: RUNNER_ID,
  workspaceId: WORKSPACE_ID,
  subscriptions: [],
  createdAt: "2026-10-11T09:29:30.000Z",
} as const;

/** The run at review, whose agent asks the user to approve a command. */
const LIVE: Run = {
  ...RUN_FIELDS,
  status: "running",
  startedAt: "2026-10-11T09:30:00.000Z",
  steps: [
    {
      stepId: "review",
      iteration: 1,
      status: "running",
      startedAt: "2026-10-11T09:30:00.000Z",
      sessionId: SESSION_ID,
    },
  ],
  edgeTraversals: [0],
};

/** The run, completed ten minutes after it started. */
const DONE: Run = {
  ...RUN_FIELDS,
  status: "completed",
  startedAt: "2026-10-11T09:30:00.000Z",
  finishedAt: "2026-10-11T09:40:00.000Z",
  steps: [
    {
      stepId: "review",
      iteration: 1,
      status: "completed",
      startedAt: "2026-10-11T09:30:00.000Z",
      finishedAt: "2026-10-11T09:35:00.000Z",
      sessionId: SESSION_ID,
      output: { verdict: "approved" },
    },
    {
      stepId: "open_pr",
      iteration: 1,
      status: "completed",
      startedAt: "2026-10-11T09:35:00.000Z",
      finishedAt: "2026-10-11T09:40:00.000Z",
      output: { number: 42 },
    },
  ],
  edgeTraversals: [1],
};

/** Returns the run summary the Runs tab lists for `run`. */
const summarize = (run: Run): RunSummary =>
  run.status === "running"
    ? {
        id: run.id,
        workflowId: run.workflowId,
        workflowName: run.plan.name,
        origin: run.origin,
        createdAt: run.createdAt,
        status: "running",
        startedAt: run.startedAt,
        activeStepIds: ["review"],
        awaitedSignalIds: [],
      }
    : {
        id: run.id,
        workflowId: run.workflowId,
        workflowName: run.plan.name,
        origin: run.origin,
        createdAt: run.createdAt,
        status: "completed",
        startedAt: DONE.startedAt,
        finishedAt: "2026-10-11T09:40:00.000Z",
      };

/** The review step's session, which asks the user to approve a command. */
const ASKING: Session = buildSession({
  id: SESSION_ID,
  kind: "run",
  runId: RUN_ID,
  stepId: "review",
  runnerId: RUNNER_ID,
  permissionProfileId: "01a06d02-7e00-7000-8000-000000000001",
  instanceId: "01a06d02-7f00-7000-8000-000000000001",
  openRequests: [
    {
      requestId: "r-1",
      itemId: "tool-1",
      decisions: ["allow", "deny"],
      kind: "command_approval",
      detail: { command: "npm audit fix --force" },
    },
  ],
});

/** A run's workspace in a project's main checkout, which a cancel does not touch. */
const MAIN_CHECKOUT: Workspace = buildWorkspace({ id: WORKSPACE_ID, runnerId: RUNNER_ID });

/** A run's own workspace, which its run deletes when it ends. */
const AUTOMATIC: Workspace = buildWorkspace({
  id: WORKSPACE_ID,
  runnerId: RUNNER_ID,
  kind: "ephemeral",
  retentionPolicy: "automatic",
});

/** A run's own workspace, kept until someone deletes it. */
const KEPT: Workspace = { ...AUTOMATIC, retentionPolicy: "manual" };

/**
 * Opens the app at `path`, with `run` and `workspace`, and `overrides` over
 * the controller's answers. A session listing filtered to the run gets
 * `sessions`, and a run listing filtered to the run's re-runs gets none.
 */
const openApp = async ({
  path = `/runs/${RUN_ID}`,
  run = LIVE,
  sessions = [ASKING],
  workspace = MAIN_CHECKOUT,
  overrides = {},
}: {
  readonly path?: string;
  readonly run?: Run;
  readonly sessions?: readonly Session[];
  readonly workspace?: Workspace;
  readonly overrides?: Readonly<Record<string, Handler>>;
} = {}) => {
  const sidebar = buildSidebarHandlers({
    ...NO_SIDEBAR_RECORDS,
    runners: [buildRunner(RUNNER_ID, "moss")],
    workspaces: [workspace],
  });
  const answerSidebarSessions = sidebar["GET /api/v1/sessions"] as (call: Call) => unknown;
  const calls = stubApi({
    ...sidebar,
    "GET /api/v1/sessions": (call) =>
      new URLSearchParams(call.search).get("runId") === null
        ? (answerSidebarSessions(call) as { body: unknown })
        : { body: { items: sessions } },
    "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
    "GET /api/v1/workflows": { body: { items: [] } },
    [`GET /api/v1/workflows/${SHIP_ID}`]: { body: SHIP },
    "GET /api/v1/triggers": { body: { items: [] } },
    "GET /api/v1/runs": (call) =>
      new URLSearchParams(call.search).get("originalRunId") === null
        ? { body: { items: [summarize(run)] } }
        : { body: { items: [] } },
    [`GET /api/v1/runs/${RUN_ID}`]: { body: run },
    "GET /api/v1/agents": { body: { items: [] } },
    "GET /api/v1/workflow-actions": { body: [] },
    ...overrides,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path },
  );
  return { calls, ...app };
};

/** Opens the run's page and waits for its heading. */
const openRun = async (options: Parameters<typeof openApp>[0] = {}) => {
  const app = await openApp(options);
  await screen.findByRole("heading", { level: 1 });
  return app;
};

const getCrumbs = () => screen.getByRole("navigation", { name: "The run's place in Workflows" });
const getDialog = (name: string) => screen.getByRole("dialog", { name });

describe("the Runs tab", () => {
  it("opens a run's page from a row of the list", async () => {
    const { router } = await openApp({ path: `/workflows/${SHIP_ID}` });
    const runs = await screen.findByRole("tabpanel");
    const row = (await within(runs).findAllByRole("link"))[0]!;

    await userEvent.click(row);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/runs/${RUN_ID}`));
    expect(await screen.findByRole("heading", { level: 1, name: "Waiting on you" })).toBeTruthy();
  });

  it("opens a run's page from a bar of the timeline", async () => {
    const { router } = await openApp({ path: `/workflows/${SHIP_ID}?runsView=timeline` });
    const lanes = await screen.findByRole("group", { name: "Runs, Today" });

    await userEvent.click(within(lanes).getByRole("link"));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/runs/${RUN_ID}`));
  });
});

describe("a run's page", () => {
  it("shows the crumb with when the run started, the state, what the run asks, who started it and its inputs", async () => {
    const { router } = await openRun();

    const crumbs = getCrumbs();
    expect(within(crumbs).getByRole("link", { name: "Ship release" }).getAttribute("href")).toBe(
      `/workflows/${SHIP_ID}`,
    );
    expect(crumbs.textContent).toContain("Run Today 09:30");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Waiting on you");
    expect(screen.getByText("Started by you")).toBeTruthy();
    expect(screen.getByLabelText("Inputs").textContent).toBe("version2.14.0");
    expect(screen.getByRole("button", { name: "Cancel run…" })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Open thread" }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/threads/${SESSION_ID}`));
  });

  it("shows the Hercule face with Workflows selected, as the book draws it", async () => {
    await openRun();

    const nav = screen.getByRole("navigation", { name: "Hercule" });
    const workflows = within(nav).getByRole("link", { name: "Workflows" });
    expect(workflows.getAttribute("aria-current")).toBe("page");
    expect(workflows.classList.contains("is-on")).toBe(true);
  });

  it("opens a node's card, whose Open thread opens the step's session", async () => {
    const { router } = await openRun();
    const graph = screen.getByRole("group", { name: "The steps of Ship release" });
    const step = within(graph).getByRole("button", { name: /^review, / });

    await userEvent.click(step);

    // jsdom hides every popover, so the card is found with hidden elements.
    const card = screen.getByRole("dialog", { hidden: true });
    expect(card.textContent).toContain("Waiting on you");
    await userEvent.click(within(card).getByRole("button", { name: /Open thread/, hidden: true }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/threads/${SESSION_ID}`));
  });

  it("switches the steps to the timeline, replacing the history entry", async () => {
    const { router } = await openRun();
    const length = router.history.length;
    const picker = screen.getByRole("group", { name: "Show the steps as" });

    await userEvent.click(within(picker).getByRole("button", { name: "Timeline" }));

    await waitFor(() => expect(router.state.location.search).toEqual({ view: "timeline" }));
    expect(router.history.length).toBe(length);
    expect(screen.queryByRole("group", { name: "The steps of Ship release" })).toBeNull();
  });

  it("goes to the run's workflow on Esc", async () => {
    const { router } = await openRun();

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(router.state.location.pathname).toBe(`/workflows/${SHIP_ID}`));
  });
});

describe("a run with a text generation step", () => {
  const REASON = "No provider instance can generate text";
  /** The run at `screen`, a text generation step, running while its call waits for a runner. */
  const SCREENING: Run = {
    ...LIVE,
    plan: {
      ...PLAN,
      steps: [
        {
          id: "screen",
          kind: "text-generation",
          instructions: "Decide whether the release needs notes.",
          input: "{{ inputs.version }}",
          outputSchema: { type: "object" },
        },
      ],
      edges: [],
    },
    steps: [
      { stepId: "screen", iteration: 1, status: "running", startedAt: "2026-10-11T09:30:00.000Z" },
    ],
    edgeTraversals: [],
  };
  /** Returns the controller's own record, with text generation unavailable for `reason`. */
  const buildController = (reason: string | null) => ({
    id: "01a06d02-a000-7000-8000-000000000001",
    publicKey: "bm90LWEta2V5",
    version: "0.1.0",
    defaultRunnerId: null,
    localRunnerId: null,
    textGeneration: { model: null, lastFailure: null, unavailableReason: reason },
  });

  it("says it waits for text generation, and why, with a link to Settings > System", async () => {
    await openRun({
      run: SCREENING,
      sessions: [],
      overrides: { "GET /api/v1/controller": { body: buildController(REASON) } },
    });

    const facts = await screen.findByRole("definition", {
      name: (_, element) => element.textContent?.startsWith("Waiting for text generation") ?? false,
    });
    expect(facts.textContent).toBe(`Waiting for text generation: ${REASON}.`);
    expect(within(facts).getByRole("link", { name: "text generation" }).getAttribute("href")).toBe(
      "/settings/system",
    );
  });

  it("says nothing about text generation while it is available", async () => {
    await openRun({
      run: SCREENING,
      sessions: [],
      overrides: { "GET /api/v1/controller": { body: buildController(null) } },
    });

    expect(document.body.textContent).not.toContain("Waiting for text generation");
  });
});

describe("Cancel run", () => {
  it("cancels a run in a main checkout without asking about its workspace", async () => {
    const { calls } = await openRun({
      overrides: {
        [`POST /api/v1/runs/${RUN_ID}/cancel`]: {
          body: { ...LIVE, status: "cancelled", finishedAt: "2026-10-11T10:00:00.000Z" },
        },
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Cancel run…" }));

    const dialog = getDialog("Cancel this run?");
    expect(dialog.textContent).toContain(
      "Its running steps stop and their sessions end, and so do the runs it started. You can re-run it afterwards.",
    );
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(document.activeElement).toBe(
      within(dialog).getByRole("button", { name: "Keep running" }),
    );

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel run" }));

    await waitFor(() =>
      expect(
        calls.find((call) => call.method === "POST" && call.path.endsWith("/cancel"))?.body,
      ).toEqual({ keepWorkspace: false }),
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Cancelled"),
    );
  });

  it("asks whether to delete the run's own workspace, and keeps it when unchecked", async () => {
    const { calls } = await openRun({
      workspace: AUTOMATIC,
      overrides: {
        [`POST /api/v1/runs/${RUN_ID}/cancel`]: {
          body: { ...LIVE, status: "cancelled", finishedAt: "2026-10-11T10:00:00.000Z" },
        },
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Cancel run…" }));
    const dialog = getDialog("Cancel this run?");
    const checkbox = within(dialog).getByRole("checkbox", { name: "Delete workspace" });
    expect(checkbox).toHaveProperty("checked", true);

    await userEvent.click(checkbox);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel run" }));

    await waitFor(() =>
      expect(
        calls.find((call) => call.method === "POST" && call.path.endsWith("/cancel"))?.body,
      ).toEqual({ keepWorkspace: true }),
    );
  });

  it("shows why a cancel was refused", async () => {
    await openRun({
      overrides: {
        [`POST /api/v1/runs/${RUN_ID}/cancel`]: {
          status: 409,
          body: buildErrorBody("invalid_state", "The run has already ended."),
        },
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Cancel run…" }));
    const dialog = getDialog("Cancel this run?");
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel run" }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Not cancelled: The run has already ended.",
    );
  });
});

describe("Re-run", () => {
  it("re-runs as it ran when that radio is picked, then opens the new run's page", async () => {
    const { calls, router } = await openRun({
      run: DONE,
      overrides: {
        [`POST /api/v1/runs/${RUN_ID}/rerun`]: { body: { runId: RERUN_ID } },
        [`GET /api/v1/runs/${RERUN_ID}`]: {
          body: { ...LIVE, id: RERUN_ID, originalRunId: RUN_ID },
        },
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Re-run…" }));

    const dialog = getDialog("Re-run with the same inputs?");
    const choices = within(dialog).getByRole("radiogroup", { name: "Re-run from" });
    expect(
      within(choices).getByRole("radio", { name: /From the current workflow/ }),
    ).toHaveProperty("checked", true);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Re-run" }));

    await userEvent.click(within(choices).getByRole("radio", { name: /As it ran/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Re-run" }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/runs/${RERUN_ID}`));
    expect(
      calls.find((call) => call.method === "POST" && call.path.endsWith("/rerun"))?.body,
    ).toEqual({ mode: "replay" });
  });

  it("re-runs as it ran when the workflow turns out deleted while the dialog is open", async () => {
    let isDeleted = false;
    const { calls, live } = await openRun({
      run: DONE,
      overrides: {
        [`GET /api/v1/workflows/${SHIP_ID}`]: () =>
          isDeleted
            ? { status: 404, body: buildErrorBody("not_found", "No workflow has this id.") }
            : { body: SHIP },
        [`POST /api/v1/runs/${RUN_ID}/rerun`]: { body: { runId: RERUN_ID } },
        [`GET /api/v1/runs/${RERUN_ID}`]: {
          body: { ...LIVE, id: RERUN_ID, originalRunId: RUN_ID },
        },
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "Re-run…" }));
    const dialog = getDialog("Re-run with the same inputs?");
    expect(within(dialog).getByRole("radio", { name: /From the current workflow/ })).toHaveProperty(
      "checked",
      true,
    );

    isDeleted = true;
    act(() => live.pushInvalidation("workflow", [SHIP_ID]));

    await waitFor(() => expect(within(dialog).queryByRole("radiogroup")).toBeNull());
    await userEvent.click(within(dialog).getByRole("button", { name: "Re-run" }));

    await waitFor(() =>
      expect(
        calls.find((call) => call.method === "POST" && call.path.endsWith("/rerun"))?.body,
      ).toEqual({ mode: "replay" }),
    );
  });
});

describe("Delete workspace", () => {
  it("deletes the ended run's workspace after asking", async () => {
    const { calls } = await openRun({
      run: DONE,
      sessions: [],
      workspace: KEPT,
      overrides: { [`DELETE /api/v1/workspaces/${WORKSPACE_ID}`]: { body: KEPT } },
    });

    await userEvent.click(screen.getByRole("button", { name: "Delete workspace…" }));

    const dialog = getDialog("Delete the run's workspace?");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep it" }));

    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(
        calls.some(
          (call) => call.method === "DELETE" && call.path === `/api/v1/workspaces/${WORKSPACE_ID}`,
        ),
      ).toBe(true),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Delete the run's workspace?" })).toBeNull(),
    );
  });
});

describe("a run whose workflow is gone", () => {
  it("names a deleted workflow without a link, and re-runs it only as it ran", async () => {
    await openRun({
      run: DONE,
      overrides: {
        [`GET /api/v1/workflows/${SHIP_ID}`]: {
          status: 404,
          body: buildErrorBody("not_found", "No workflow has this id."),
        },
      },
    });

    await waitFor(() => expect(getCrumbs().textContent).toContain("Ship releasedeleted"));
    expect(within(getCrumbs()).queryByRole("link", { name: /Ship release/ })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Re-run…" }));

    const dialog = getDialog("Re-run with the same inputs?");
    expect(within(dialog).queryByRole("radiogroup")).toBeNull();
    expect(dialog.textContent).toContain(
      "This run's workflow was deleted, so the new run follows this run's plan, as it was frozen when the run started.",
    );
  });

  it("does not read a deleted workflow again when another of its runs opens", async () => {
    const { calls, router, live } = await openRun({
      run: DONE,
      overrides: {
        [`GET /api/v1/workflows/${SHIP_ID}`]: {
          status: 404,
          body: buildErrorBody("not_found", "No workflow has this id."),
        },
        [`GET /api/v1/runs/${RERUN_ID}`]: { body: { ...DONE, id: RERUN_ID } },
      },
    });
    await waitFor(() => expect(getCrumbs().textContent).toContain("Ship releasedeleted"));
    // The controller's first push on the `workflow` topic reads every workflow
    // again, the deleted one too, so count only after that read has finished.
    await waitFor(() => expect(live.readTopics()).toContain("workflow"));
    await live.waitForFirstPushes();
    const countWorkflowReads = () =>
      calls.filter((call) => call.method === "GET" && call.path === `/api/v1/workflows/${SHIP_ID}`)
        .length;
    const readsBefore = countWorkflowReads();

    await act(() => router.navigate({ to: "/runs/$runId", params: { runId: RERUN_ID } }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/runs/${RERUN_ID}`));
    expect(getCrumbs().textContent).toContain("Ship releasedeleted");
    expect(countWorkflowReads()).toBe(readsBefore);
  });

  it("names a workflow that was never saved, and Esc goes to Workflows", async () => {
    const { router } = await openRun({ run: { ...DONE, workflowId: null } });

    expect(getCrumbs().textContent).toContain("Ship releasenot saved");

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows"));
  });
});

describe("a run that does not exist", () => {
  it("says so, with a link to Workflows", async () => {
    await openApp({
      overrides: {
        [`GET /api/v1/runs/${RUN_ID}`]: {
          status: 404,
          body: buildErrorBody("not_found", "No run has this id."),
        },
      },
    });

    expect(
      await screen.findByRole("heading", { level: 1, name: "This run was not found." }),
    ).toBeTruthy();
    // The sidebar's Workflows row is a link too, so the page's is found in main.
    const page = screen.getByRole("main");
    expect(within(page).getByRole("link", { name: "Workflows" }).getAttribute("href")).toBe(
      "/workflows",
    );
  });
});
