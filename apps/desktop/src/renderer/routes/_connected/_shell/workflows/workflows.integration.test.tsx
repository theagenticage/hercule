/**
 * Tests the workflow list: its groups and rows, the filters and the search,
 * ⌘F, the empty list, and how the `workflow` and `run` topics keep it
 * current while the window is visible.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RunSummary, Session, Trigger, TriggerOn, WorkflowSummary } from "@hercule/contract";
import {
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  setVisibility,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  type Call,
  type Handler,
} from "../../../../app/testing";

// Every element measures as wide as a window that shows every column, and
// the virtualized list draws the rows that fit its height.
beforeEach(() => {
  stubElementSize(1168, 800);
  // Sunday 11 October 2026, 10:00 in UTC, the time zone the settings name.
  vi.useFakeTimers({ now: new Date("2026-10-11T10:00:00.000Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  setVisibility("visible");
  localStorage.clear();
});

const AT = "2026-09-01T00:00:00.000Z";

const buildWorkflow = (id: string, name: string, enabled = true): WorkflowSummary => ({
  id,
  name,
  enabled,
  updatedAt: AT,
});

const SHIP = buildWorkflow("01a06d02-7800-7000-8000-000000000001", "Ship release");
const SYNC = buildWorkflow("01a06d02-7800-7000-8000-000000000002", "Nightly sync");
const TRIAGE = buildWorkflow("01a06d02-7800-7000-8000-000000000003", "Triage issues");
const CLEANUP = buildWorkflow("01a06d02-7800-7000-8000-000000000004", "Old cleanup", false);
const REPORT = buildWorkflow("01a06d02-7800-7000-8000-000000000005", "Ad hoc report");
const WORKFLOWS = [SHIP, SYNC, TRIAGE, CLEANUP, REPORT];

/** Returns start trigger `triggerId` of `workflow`, firing on `on`. */
const buildTrigger = (
  workflow: WorkflowSummary,
  triggerId: string,
  on: TriggerOn,
  over: Partial<Trigger> = {},
): Trigger => ({
  workflowId: workflow.id,
  workflowName: workflow.name,
  triggerId,
  kind: "start",
  on,
  status: "active",
  health: { state: "ok" },
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const TRIGGERS: Trigger[] = [
  buildTrigger(
    SHIP,
    "nightly",
    { schedule: "0 1 * * *" },
    { nextFireAt: "2026-10-12T01:00:00.000Z" },
  ),
  buildTrigger(
    SYNC,
    "fridays",
    { schedule: "0 14 * * 5" },
    { nextFireAt: "2026-10-16T14:00:00.000Z" },
  ),
  buildTrigger(TRIAGE, "on_issue", { kind: "github.issue.opened" }),
  buildTrigger(CLEANUP, "weekly", { schedule: "0 3 * * 1" }),
];

/** Returns the fields every run of `workflow` shares, created at `createdAt`. */
const buildRunFields = (id: string, workflow: WorkflowSummary, createdAt: string) => ({
  id,
  workflowId: workflow.id,
  workflowName: workflow.name,
  origin: { kind: "manual" as const, actor: "user" },
  createdAt,
});

const SHIP_LIVE: RunSummary = {
  ...buildRunFields("01a06d02-7900-7000-8000-000000000001", SHIP, "2026-10-11T09:30:00.000Z"),
  status: "running",
  startedAt: "2026-10-11T09:30:00.000Z",
  activeStepIds: ["review"],
  awaitedSignalIds: [],
};
const SHIP_DONE: RunSummary = {
  ...buildRunFields("01a06d02-7900-7000-8000-000000000002", SHIP, "2026-10-10T09:30:00.000Z"),
  status: "completed",
  startedAt: "2026-10-10T09:30:00.000Z",
  finishedAt: "2026-10-10T09:40:00.000Z",
};
const SHIP_CANCELLED: RunSummary = {
  ...buildRunFields("01a06d02-7900-7000-8000-000000000003", SHIP, "2026-10-09T09:30:00.000Z"),
  status: "cancelled",
  finishedAt: "2026-10-09T09:31:00.000Z",
};
const SYNC_FAILED: RunSummary = {
  ...buildRunFields("01a06d02-7900-7000-8000-000000000004", SYNC, "2026-10-11T08:15:00.000Z"),
  status: "failed",
  failureReason: "step-failed",
  failedStepId: "test",
  startedAt: "2026-10-11T08:15:00.000Z",
  finishedAt: "2026-10-11T08:20:00.000Z",
};
const SYNC_DONE: RunSummary = {
  ...buildRunFields("01a06d02-7900-7000-8000-000000000005", SYNC, "2026-10-10T08:15:00.000Z"),
  status: "completed",
  startedAt: "2026-10-10T08:15:00.000Z",
  finishedAt: "2026-10-10T08:20:00.000Z",
};
const TRIAGE_LIVE: RunSummary = {
  ...buildRunFields("01a06d02-7900-7000-8000-000000000006", TRIAGE, "2026-10-11T09:50:00.000Z"),
  status: "running",
  startedAt: "2026-10-11T09:50:00.000Z",
  activeStepIds: ["fix"],
  awaitedSignalIds: [],
};
const REPORT_DONE: RunSummary = {
  ...buildRunFields("01a06d02-7900-7000-8000-000000000007", REPORT, "2026-10-01T12:00:00.000Z"),
  status: "completed",
  startedAt: "2026-10-01T12:00:00.000Z",
  finishedAt: "2026-10-01T12:05:00.000Z",
};

/** Every run, newest first, as `run.query` lists them. */
const RUNS = [
  TRIAGE_LIVE,
  SHIP_LIVE,
  SYNC_FAILED,
  SHIP_DONE,
  SYNC_DONE,
  SHIP_CANCELLED,
  REPORT_DONE,
];

/** The session of Ship release's review step, waiting on the user to approve a push. */
const WAITING: Session = {
  ...SIDEBAR_FIXTURE.threads[0]!,
  id: "01a06d02-7a00-7000-8000-000000000001",
  title: "Ship release · review",
  status: "busy",
  runId: SHIP_LIVE.id,
  stepId: "review",
  openRequests: [
    {
      requestId: "r-1",
      itemId: "tool-1",
      decisions: ["allow", "deny"],
      kind: "command_approval",
      detail: { command: "git push" },
    },
  ],
};

/** Answers `run.query`: a workflow's strip when it names one, else the runs with the status it names. */
const answerRunQuery = (call: Call) => {
  const params = new URLSearchParams(call.search);
  const workflowId = params.get("workflowId");
  const status = params.get("status");
  return {
    body: {
      items: RUNS.filter((run) =>
        workflowId === null ? run.status === status : run.workflowId === workflowId,
      ),
    },
  };
};

/** Opens the app at the workflow list, with `workflows` and the fixture's triggers and runs. */
const openWorkflows = async (workflows: readonly WorkflowSummary[] = WORKFLOWS) => {
  const handlers: Readonly<Record<string, Handler>> = {
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, agentSessions: [WAITING] }),
    "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
    "GET /api/v1/workflows": { body: { items: workflows } },
    "GET /api/v1/triggers": { body: { items: TRIGGERS } },
    "GET /api/v1/runs": answerRunQuery,
  };
  const calls = stubApi(handlers);
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: "/workflows" },
  );
  await screen.findByRole("heading", { level: 1, name: "Workflows" });
  return { calls, ...app };
};

const getList = () => screen.getByRole("navigation", { name: "Workflows" });
const getFilters = () => screen.getByRole("navigation", { name: "Filter workflows" });
const getSearch = () => screen.getByRole("searchbox", { name: "Search workflows" });

/** Returns the text of each cell of `workflow`'s row, in column order. */
const readCells = (workflow: WorkflowSummary): string[] => {
  const row = within(getList()).getByRole("link", { name: workflow.name });
  return [...row.children].map((cell) => cell.textContent ?? "");
};

/** Returns the names of the list's headings and rows, in order. */
const readList = (): string[] =>
  [...getList().querySelectorAll("[data-key]")].map(
    (item) => item.getAttribute("aria-label") ?? item.textContent ?? "",
  );

describe("the workflow list", () => {
  it("draws the groups in order, each with its count, and the rows sorted by name", async () => {
    await openWorkflows();

    expect(readList()).toEqual([
      "Needs you 1",
      "Ship release",
      "Failing 1",
      "Nightly sync",
      "Running 1",
      "Triage issues",
      "Everything else 2",
      "Ad hoc report",
      "Old cleanup",
    ]);
    expect(within(getList()).getByRole("heading", { level: 2, name: "Needs you 1" })).toBeTruthy();
    expect(
      within(getList()).getByRole("heading", { name: "Needs you 1" }).querySelector(".count--you"),
    ).not.toBeNull();
  });

  it("shows what starts each workflow, its strip, its success, its last run and when it next starts", async () => {
    await openWorkflows();

    // Mark, name, Starts on, strip, Success, Last run, its time, Next.
    expect(readCells(SHIP)).toEqual([
      "",
      "Ship release",
      "Daily at 01:00",
      "",
      "100%",
      "review asks: Run git push?",
      "09:30",
      "Mon 01:00",
    ]);
    expect(readCells(SYNC)).toEqual([
      "",
      "Nightly sync",
      "Fridays at 14:00",
      "",
      "50%",
      "Failed at test",
      "08:15",
      "Fri 14:00",
    ]);
    expect(readCells(TRIAGE).slice(2)).toEqual([
      "github.issue.opened",
      "",
      "",
      "At fix",
      "09:50",
      "On event",
    ]);
    expect(readCells(REPORT).slice(2)).toEqual([
      "On demand",
      "",
      "100%",
      "Done",
      "1 Oct",
      "On demand",
    ]);
    expect(readCells(CLEANUP).slice(5)).toEqual(["No runs yet", "", "Off"]);

    const ship = within(getList()).getByRole("link", {
      name: "Ship release",
      description: "review asks: Run git push?",
    });
    // The strip: the cancelled run as a dot named for it, then the completed
    // run's mark and the waiting run's, oldest first.
    const strip = ship.querySelector(".strip")!;
    expect(strip.children).toHaveLength(3);
    expect(within(ship).getByRole("img", { name: "Cancelled" })).toBe(strip.firstElementChild);
    expect(ship.querySelector(".status-text--you")?.textContent).toBe("review asks: Run git push?");
    expect(
      within(getList()).getByRole("link", { name: "Old cleanup" }).classList.contains("is-off"),
    ).toBe(true);
  });

  it("opens a workflow from its row, and marks the row selected", async () => {
    const { router } = await openWorkflows();
    const row = within(getList()).getByRole("link", { name: "Nightly sync" });
    expect(row.getAttribute("href")).toBe(`/workflows/${SYNC.id}`);

    await userEvent.click(row);

    await waitFor(() => expect(router.state.location.pathname).toBe(`/workflows/${SYNC.id}`));
    expect(row.getAttribute("aria-current")).toBe("page");
    expect(row.classList.contains("is-on")).toBe(true);
    // The list stays, with its heading.
    expect(screen.getByRole("heading", { level: 1, name: "Workflows" })).toBeTruthy();
  });

  it("says when there are no workflows", async () => {
    await openWorkflows([]);

    expect(within(getList()).getByText("No workflows yet")).toBeTruthy();
    expect(within(getFilters()).getByRole("button", { name: "All 0" })).toBeTruthy();
  });
});

describe("the workflow list's filters and search", () => {
  it("count the workflows each filter keeps, and keep only those when pressed", async () => {
    await openWorkflows();

    expect(
      within(getFilters())
        .getAllByRole("button")
        .map((button) => [button.textContent, button.getAttribute("aria-pressed")]),
    ).toEqual([
      ["All 5", "true"],
      ["Needs you 1", "false"],
      ["Failing 1", "false"],
      ["Running 1", "false"],
      ["Off 1", "false"],
    ]);

    await userEvent.click(within(getFilters()).getByRole("button", { name: "Off 1" }));

    expect(
      within(getFilters()).getByRole("button", { name: "Off 1" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(getFilters()).getByRole("button", { name: "All 5" }).getAttribute("aria-pressed"),
    ).toBe("false");
    expect(readList()).toEqual(["Everything else 1", "Old cleanup"]);
  });

  it("keep the workflows whose name or Starts on holds every word typed, without changing the counts", async () => {
    await openWorkflows();

    await userEvent.type(getSearch(), "DAILY ship");

    expect(readList()).toEqual(["Needs you 1", "Ship release"]);
    expect(within(getFilters()).getByRole("button", { name: "All 5" })).toBeTruthy();

    await userEvent.clear(getSearch());
    await userEvent.type(getSearch(), "nothing like this");

    expect(within(getList()).getByText("No workflows match")).toBeTruthy();
  });

  it("put the focus in the search with ⌘F, its text selected", async () => {
    await openWorkflows();
    await userEvent.type(getSearch(), "sync");
    act(() => getSearch().blur());

    fireEvent.keyDown(window, { key: "f", metaKey: true });

    const search = getSearch() as HTMLInputElement;
    expect(document.activeElement).toBe(search);
    expect([search.selectionStart, search.selectionEnd]).toEqual([0, 4]);
  });
});

describe("the workflow list's live updates", () => {
  /** Returns the query strings of the GET requests in `calls` to `path`, sorted. */
  const listReads = (calls: readonly Call[], path: string): string[] =>
    calls
      .filter((call) => call.method === "GET" && call.path === path)
      .map((call) => call.search)
      .sort();

  /** Waits until the page holds both topics and their first pushes' reads have answered. */
  const waitForTopics = async (
    live: Awaited<ReturnType<typeof openWorkflows>>["live"],
    queryClient: Awaited<ReturnType<typeof openWorkflows>>["context"]["queryClient"],
  ) => {
    await waitFor(() =>
      expect(live.readTopics()).toEqual(expect.arrayContaining(["workflow", "run"])),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
  };

  it("read every strip and the live runs again on a run push, and the workflows and triggers on a workflow push", async () => {
    const { calls, live, context } = await openWorkflows();
    await waitForTopics(live, context.queryClient);

    const before = calls.length;
    act(() => live.pushInvalidation("run", [SHIP_LIVE.id]));
    await waitFor(() => expect(listReads(calls.slice(before), "/api/v1/runs")).toHaveLength(7));
    expect(listReads(calls.slice(before), "/api/v1/runs")).toEqual(
      [
        ...WORKFLOWS.map((workflow) => `?workflowId=${workflow.id}&limit=20`),
        "?status=pending&limit=500",
        "?status=running&limit=500",
      ].sort(),
    );

    const beforeWorkflow = calls.length;
    act(() => live.pushInvalidation("workflow", [SHIP.id]));
    await waitFor(() =>
      expect(listReads(calls.slice(beforeWorkflow), "/api/v1/triggers")).toHaveLength(1),
    );
    expect(listReads(calls.slice(beforeWorkflow), "/api/v1/workflows")).toHaveLength(1);
  });

  it("drop both topics while the window is hidden, and hold them again when it shows", async () => {
    const { live, context } = await openWorkflows();
    await waitForTopics(live, context.queryClient);

    setVisibility("hidden");

    // The live connection leaves a topic once its unsubscribe frame is sent,
    // a moment after the page stops holding it.
    await waitFor(() => expect(live.readTopics()).not.toContain("workflow"));
    expect(live.readTopics()).not.toContain("run");

    setVisibility("visible");

    await waitFor(() =>
      expect(live.readTopics()).toEqual(expect.arrayContaining(["workflow", "run"])),
    );
  });
});
