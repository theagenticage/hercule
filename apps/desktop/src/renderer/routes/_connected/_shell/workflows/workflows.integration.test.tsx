/**
 * Tests the workflow list: its groups and rows, the filters and the search,
 * ⌘F, the empty list, its three widths, the header over an open workflow,
 * Esc, and how the `workflow` and `run` topics keep it current while the
 * window is visible.
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
  stubCssAnimations,
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

/**
 * The runs `run.query` answers with: `RUNS`, until a test replaces them to
 * stand for runs that changed while the page is open.
 */
let currentRuns: readonly RunSummary[] = RUNS;

afterEach(() => {
  currentRuns = RUNS;
});

/**
 * Answers `run.query`: each workflow's newest runs, at most `newestPerWorkflow`
 * of each, when the filter names it, else the runs with the status it names.
 */
const answerRunQuery = (call: Call) => {
  const params = new URLSearchParams(call.search);
  const newestPerWorkflow = params.get("newestPerWorkflow");
  if (newestPerWorkflow === null) {
    return { body: { items: currentRuns.filter((run) => run.status === params.get("status")) } };
  }
  const kept = new Map<string | null, number>();
  return {
    body: {
      items: currentRuns.filter((run) => {
        const count = (kept.get(run.workflowId) ?? 0) + 1;
        kept.set(run.workflowId, count);
        return count <= Number(newestPerWorkflow);
      }),
    },
  };
};

/**
 * Opens the app at `path`, the workflow list by default, with `workflows` and
 * the fixture's triggers and runs, and waits for the floating header to show.
 */
const openWorkflows = async (
  workflows: readonly WorkflowSummary[] = WORKFLOWS,
  path = "/workflows",
) => {
  const handlers: Readonly<Record<string, Handler>> = {
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, agentSessions: [WAITING] }),
    "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
    "GET /api/v1/workflows": { body: { items: workflows } },
    "GET /api/v1/triggers": { body: { items: TRIGGERS } },
    "GET /api/v1/runs": answerRunQuery,
    // What an open workflow reads besides the list: the workflow itself,
    // with one step, and the Agents and workflow actions that name steps.
    ...Object.fromEntries(
      workflows.map((workflow): [string, Handler] => [
        `GET /api/v1/workflows/${workflow.id}`,
        {
          body: {
            id: workflow.id,
            enabled: workflow.enabled,
            source: `name: ${workflow.name}\nsteps:\n  - id: review\n    kind: agent\n    agent: 01a06d02-7b00-7000-8000-000000000001\n    prompt: Review.\n`,
            createdAt: AT,
            updatedAt: AT,
          },
        },
      ]),
    ),
    "GET /api/v1/agents": { body: { items: [] } },
    "GET /api/v1/workflow-actions": { body: [] },
  };
  const calls = stubApi(handlers);
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path },
  );
  // The header's pill: the filters over the table, the back tab over an open workflow.
  await screen.findByRole("navigation", { name: /^(Filter workflows|Workflow list)$/ });
  return { calls, ...app };
};

const getList = () => screen.getByRole("navigation", { name: "Workflows" });
const getFilters = () => screen.getByRole("navigation", { name: "Filter workflows" });
const getSearch = () => screen.getByRole("searchbox", { name: "Search workflows" });
const getHeader = () => screen.getByRole("navigation", { name: "Workflow list" });

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
    // Needs you's count is drawn in marigold, which only its class shows.
    const needsYou = within(getList()).getByRole("heading", { name: "Needs you 1" });
    expect(within(needsYou).getByText("1").classList.contains("count--you")).toBe(true);
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
    // run's mark and the waiting run's, oldest first. A mark is hidden from
    // assistive technology, so the strip is found from the named dot, which
    // sits in its run's slot.
    const cancelled = within(ship).getByRole("img", { name: "Cancelled" });
    const strip = cancelled.closest(".strip");
    expect(strip?.children).toHaveLength(3);
    expect(strip?.firstElementChild?.firstElementChild).toBe(cancelled);
    // The status waiting on the user is drawn in marigold, and a workflow
    // that is off is drawn faint; only their classes show those colours.
    expect(
      within(ship).getByText("review asks: Run git push?").classList.contains("status-text--you"),
    ).toBe(true);
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
    // The list stays, as the column, with the open workflow's row selected.
    const selected = within(getList()).getByRole("link", { name: "Nightly sync" });
    expect(selected.getAttribute("aria-current")).toBe("page");
    // The selected row is drawn with the selection's fill, which only its class shows.
    expect(selected.classList.contains("is-on")).toBe(true);
  });

  it("keeps the focus on the open workflow's row while the list changes width", async () => {
    const { router } = await openWorkflows();
    act(() => within(getList()).getByRole("link", { name: "Nightly sync" }).focus());

    await userEvent.keyboard("{Enter}");

    await waitFor(() => expect(router.state.location.pathname).toBe(`/workflows/${SYNC.id}`));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(getList()).getByRole("link", { name: "Nightly sync" }),
      ),
    );

    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows"));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(getList()).getByRole("link", { name: "Nightly sync" }),
      ),
    );
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

describe("the workflow list's widths", () => {
  it("draws the table while no workflow is open, with the filters, the search and the column heads", async () => {
    await openWorkflows();

    expect(screen.getByRole("heading", { level: 1, name: "Workflows" })).toBeTruthy();
    expect(getFilters()).toBeTruthy();
    expect(within(getList()).getByText("Starts on")).toBeTruthy();
    // The search sits in the header, not in the list.
    expect(within(getList()).queryByRole("searchbox")).toBeNull();
    expect(getSearch()).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Workflow list" })).toBeNull();
    expect(getList().classList.contains("workflow-list--table")).toBe(true);
  });

  it("draws the list as a column beside an open workflow, with the search at its top", async () => {
    await openWorkflows(WORKFLOWS, `/workflows/${SYNC.id}`);

    expect(getList().classList.contains("workflow-list--column")).toBe(true);
    expect(within(getList()).getByRole("searchbox", { name: "Search workflows" })).toBeTruthy();
    // No column heads and no filters: the header holds the back tab.
    expect(within(getList()).queryByText("Starts on")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Filter workflows" })).toBeNull();
    expect(screen.queryByRole("heading", { level: 1, name: "Workflows" })).toBeNull();
    // A row is the mark, the name over the status, and the time.
    const sync = within(getList()).getByRole("link", {
      name: "Nightly sync",
      description: "Failed at test",
    });
    expect([...sync.children].map((part) => part.textContent)).toEqual([
      "",
      "Nightly syncFailed at test",
      "08:15",
    ]);
    expect(sync.getAttribute("aria-current")).toBe("page");
    expect(sync.classList.contains("is-on")).toBe(true);
    expect(
      within(getList()).getByRole("link", { name: "Ship release" }).getAttribute("aria-current"),
    ).toBeNull();
    // The same groups and rows as the table.
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
  });

  it("hides the list while the open workflow fills the pane", async () => {
    await openWorkflows(WORKFLOWS, `/workflows/${SYNC.id}?full=true`);

    expect(screen.queryByRole("navigation", { name: "Workflows" })).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(within(getHeader()).getByRole("button", { name: "Show the list" })).toBeTruthy();
  });

  it("hides the list and shows it again from the header's button, keeping the other search params", async () => {
    const { router } = await openWorkflows(
      WORKFLOWS,
      `/workflows/${SYNC.id}?runsView=timeline&daysBack=2`,
    );
    const pane = document.querySelector(".open-pane");
    expect(pane).not.toBeNull();

    await userEvent.click(within(getHeader()).getByRole("button", { name: "Hide the list" }));

    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        runsView: "timeline",
        daysBack: 2,
        full: true,
      }),
    );
    expect(screen.queryByRole("navigation", { name: "Workflows" })).toBeNull();

    await userEvent.click(within(getHeader()).getByRole("button", { name: "Show the list" }));

    await waitFor(() =>
      expect(router.state.location.search).toEqual({ runsView: "timeline", daysBack: 2 }),
    );
    expect(router.state.location.pathname).toBe(`/workflows/${SYNC.id}`);
    expect(
      within(getList()).getByRole("link", { name: "Nightly sync" }).getAttribute("aria-current"),
    ).toBe("page");
    // The open workflow's pane stays mounted, so its settling does not play again.
    expect(document.querySelector(".open-pane")).toBe(pane);
  });

  // Below 800px of pane the open workflow fills the pane and the header's
  // list button is hidden. That is a container query on `.workflows-page`
  // (workflow-list.css), which jsdom does not evaluate, so no test here
  // covers it.
});

describe("the header over an open workflow", () => {
  it("leads back to the table from the page's name, with the count of All", async () => {
    const { router } = await openWorkflows(WORKFLOWS, `/workflows/${SYNC.id}`);
    const back = within(getHeader()).getByRole("link", { name: "Workflows 5" });
    expect(back.getAttribute("href")).toBe("/workflows");
    expect(back.getAttribute("aria-current")).toBeNull();

    await userEvent.click(back);

    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows"));
    expect(getList().classList.contains("workflow-list--table")).toBe(true);
  });

  it("shows the filter beside the back tab, and keeps the filter and the search while workflows open and close", async () => {
    const { router } = await openWorkflows();
    await userEvent.click(within(getFilters()).getByRole("button", { name: "Failing 1" }));
    await userEvent.type(getSearch(), "sync");

    await userEvent.click(within(getList()).getByRole("link", { name: "Nightly sync" }));

    await waitFor(() => expect(router.state.location.pathname).toBe(`/workflows/${SYNC.id}`));
    expect(within(getHeader()).getByRole("link", { name: "Workflows 5" })).toBeTruthy();
    expect(within(getHeader()).getByText("Failing").textContent).toBe("Failing 1");
    expect(within(getList()).getByRole<HTMLInputElement>("searchbox").value).toBe("sync");
    expect(readList()).toEqual(["Failing 1", "Nightly sync"]);

    await userEvent.click(within(getHeader()).getByRole("link", { name: "Workflows 5" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows"));
    expect(
      within(getFilters()).getByRole("button", { name: "Failing 1" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect((getSearch() as HTMLInputElement).value).toBe("sync");
  });

  it("shows no filter beside the back tab while the filter is All", async () => {
    await openWorkflows(WORKFLOWS, `/workflows/${SYNC.id}`);

    expect(within(getHeader()).getAllByRole("link")).toHaveLength(1);
    expect(getHeader().textContent).toBe("Workflows 5");
  });
});

describe("Esc on an open workflow", () => {
  it("closes the workflow, back to the table", async () => {
    const { router } = await openWorkflows(WORKFLOWS, `/workflows/${SYNC.id}?full=true`);

    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => expect(router.state.location.pathname).toBe("/workflows"));
    expect(router.state.location.search).toEqual({});
  });

  it("is left to a focused text field", async () => {
    const { router } = await openWorkflows(WORKFLOWS, `/workflows/${SYNC.id}`);
    const search = within(getList()).getByRole("searchbox");
    act(() => search.focus());

    fireEvent.keyDown(search, { key: "Escape" });

    expect(router.state.location.pathname).toBe(`/workflows/${SYNC.id}`);
  });

  it("is left to whatever handled it first", async () => {
    const { router } = await openWorkflows(WORKFLOWS, `/workflows/${SYNC.id}`);
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    event.preventDefault();

    act(() => {
      document.body.dispatchEvent(event);
    });

    expect(router.state.location.pathname).toBe(`/workflows/${SYNC.id}`);
  });

  it("is left to an open dialog, which the browser closes on Esc", async () => {
    const { router } = await openWorkflows(WORKFLOWS, `/workflows/${SYNC.id}`);
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.append(dialog);

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(router.state.location.pathname).toBe(`/workflows/${SYNC.id}`);
    dialog.remove();
  });

  it("does nothing on the table", async () => {
    const { router } = await openWorkflows();

    fireEvent.keyDown(document.body, { key: "Escape" });

    expect(router.state.location.pathname).toBe("/workflows");
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

  it("read the strips and the live runs again on a run push, and the workflows and triggers on a workflow push", async () => {
    const { calls, live, context } = await openWorkflows();
    await waitForTopics(live, context.queryClient);

    const before = calls.length;
    act(() => live.pushInvalidation("run", [SHIP_LIVE.id]));
    await waitFor(() => expect(listReads(calls.slice(before), "/api/v1/runs")).toHaveLength(3));
    expect(listReads(calls.slice(before), "/api/v1/runs")).toEqual([
      "?newestPerWorkflow=20&limit=500",
      "?status=pending&limit=500",
      "?status=running&limit=500",
    ]);

    const beforeWorkflow = calls.length;
    act(() => live.pushInvalidation("workflow", [SHIP.id]));
    await waitFor(() =>
      expect(listReads(calls.slice(beforeWorkflow), "/api/v1/triggers")).toHaveLength(1),
    );
    expect(listReads(calls.slice(beforeWorkflow), "/api/v1/workflows")).toHaveLength(1);
  });

  it("drop both topics while the window is hidden, and hold them again when it shows, with one run subscription", async () => {
    const { live, context } = await openWorkflows();
    await waitForTopics(live, context.queryClient);
    const countTopic = (topic: string) => live.readTopics().filter((each) => each === topic).length;
    // The shell holds `run`, for Tracking's count, and the page holds none of its own.
    expect(countTopic("run")).toBe(1);
    expect(countTopic("workflow")).toBe(1);

    setVisibility("hidden");

    // The live connection leaves a topic once its unsubscribe frame is sent,
    // a moment after the page stops holding it.
    await waitFor(() => expect(live.readTopics()).not.toContain("workflow"));
    await waitFor(() => expect(live.readTopics()).not.toContain("run"));

    setVisibility("visible");

    await waitFor(() => expect(countTopic("workflow")).toBe(1));
    await waitFor(() => expect(countTopic("run")).toBe(1));
  });
});

describe("the workflow list's motion", () => {
  /** Sets whether an animation is playing in each row; one is, until a test says not. */
  let setPlaying: (isPlaying: boolean) => void;
  beforeEach(() => {
    setPlaying = stubCssAnimations();
    setPlaying(true);
  });

  /** Returns `workflow`'s row in the list. */
  const getRow = (workflow: WorkflowSummary) =>
    within(getList()).getByRole("link", { name: workflow.name });

  /** Replaces the runs with `runs`, sends a `run` push, and waits until the list reads them. */
  const pushRuns = async (
    app: Awaited<ReturnType<typeof openWorkflows>>,
    runs: readonly RunSummary[],
  ) => {
    await waitFor(() =>
      expect(app.live.readTopics()).toEqual(expect.arrayContaining(["workflow", "run"])),
    );
    currentRuns = runs;
    const before = app.calls.length;
    act(() => app.live.pushInvalidation("run", []));
    // The strips' read is one of the reads the push starts; an open workflow
    // reads its own runs too.
    await waitFor(() =>
      expect(
        app.calls.slice(before).some((call) => call.search.includes("newestPerWorkflow")),
      ).toBe(true),
    );
    await waitFor(() => expect(app.context.queryClient.isFetching()).toBe(0));
  };

  it("draws every mark still when the list opens", async () => {
    await openWorkflows();

    expect(getList().querySelectorAll(".is-new, .is-advanced")).toHaveLength(0);
  });

  /** The runs after Triage issues' live run failed. */
  const TRIAGE_FAILED_RUNS = RUNS.map((run): RunSummary =>
    run.id === TRIAGE_LIVE.id
      ? {
          ...buildRunFields(TRIAGE_LIVE.id, TRIAGE, TRIAGE_LIVE.createdAt),
          status: "failed",
          failureReason: "step-failed",
          failedStepId: "fix",
          startedAt: TRIAGE_LIVE.startedAt,
          finishedAt: "2026-10-11T09:55:00.000Z",
        }
      : run,
  );

  it("pops in the lead mark and the strip's mark of a workflow whose run changed", async () => {
    const app = await openWorkflows();

    await pushRuns(app, TRIAGE_FAILED_RUNS);

    await waitFor(() => expect(getRow(TRIAGE).querySelector(".table-mark.is-new")).not.toBeNull());
    const strip = getRow(TRIAGE).querySelector(".strip")!;
    expect(strip.querySelector(".strip-run.is-new > .mark--failed")).not.toBeNull();
    expect(strip.classList.contains("is-advanced")).toBe(false);
    // The workflows whose runs did not change stay still.
    expect(getRow(REPORT).querySelectorAll(".is-new")).toHaveLength(0);
  });

  it("drops a row's motion once no animation is left playing in it", async () => {
    const app = await openWorkflows();
    await pushRuns(app, TRIAGE_FAILED_RUNS);
    await waitFor(() => expect(getRow(TRIAGE).querySelector(".table-mark.is-new")).not.toBeNull());

    fireEvent.animationEnd(getRow(TRIAGE).querySelector(".table-mark > .mark")!);
    expect(getRow(TRIAGE).querySelectorAll(".is-new")).toHaveLength(2);

    setPlaying(false);
    fireEvent.animationEnd(getRow(TRIAGE).querySelector(".table-mark > .mark")!);
    // A row the list then moves has no class left to play again.
    expect(getRow(TRIAGE).querySelectorAll(".is-new, .is-advanced")).toHaveLength(0);
  });

  it("drops a change that starts no animation, as a strip hidden in a narrow pane does", async () => {
    const app = await openWorkflows();
    setPlaying(false);

    await pushRuns(app, TRIAGE_FAILED_RUNS);

    // The row was drawn with the change, found nothing playing, and dropped
    // it, so a pane that widens later plays nothing stale.
    await waitFor(() => expect(getRow(TRIAGE).querySelector(".mark--failed")).not.toBeNull());
    expect(getRow(TRIAGE).querySelectorAll(".is-new, .is-advanced")).toHaveLength(0);
  });

  it("pops in the lead mark of a workflow whose run changed in the column", async () => {
    const app = await openWorkflows(WORKFLOWS, `/workflows/${SYNC.id}`);

    await pushRuns(app, TRIAGE_FAILED_RUNS);

    await waitFor(() =>
      expect(getRow(TRIAGE).querySelector(".column-mark.is-new > .mark--failed")).not.toBeNull(),
    );
    expect(getRow(REPORT).querySelectorAll(".is-new")).toHaveLength(0);
  });

  it("steps the older marks left when a run joins a strip, and pops the new one in", async () => {
    const app = await openWorkflows();
    const started: RunSummary = {
      ...buildRunFields("01a06d02-7900-7000-8000-000000000008", REPORT, "2026-10-11T09:58:00.000Z"),
      status: "running",
      startedAt: "2026-10-11T09:58:00.000Z",
      activeStepIds: ["write"],
      awaitedSignalIds: [],
    };

    await pushRuns(app, [started, ...RUNS]);

    await waitFor(() =>
      expect(getRow(REPORT).querySelector(".strip")?.classList.contains("is-advanced")).toBe(true),
    );
    // One run joined, so the older marks step one slot.
    expect(
      getRow(REPORT).querySelector<HTMLElement>(".strip")?.style.getPropertyValue("--joined-runs"),
    ).toBe("1");
    const slots = [...getRow(REPORT).querySelectorAll(".strip-run")];
    expect(slots.map((slot) => slot.classList.contains("is-new"))).toEqual([false, true]);
  });
});
