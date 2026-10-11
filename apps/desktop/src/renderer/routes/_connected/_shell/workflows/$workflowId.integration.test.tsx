/**
 * Tests the open workflow: its lead and chips, a step's card, the workflow's
 * and the triggers' switches with a failed save, the tabs and their keys,
 * the Runs tab's list and timeline with the day stepper, the Triggers,
 * Inputs and Source tabs, and a workflow that does not exist.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  RunSummary,
  Trigger,
  TriggerOn,
  Workflow,
  WorkflowAction,
  WorkflowSummary,
} from "@hercule/contract";
import { MAX_TIMELINE_DAYS_BACK } from "@hercule/client-core/run-timeline";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  holdAnswer,
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
  localStorage.clear();
});

const AT = "2026-09-01T00:00:00.000Z";
const SHIP_ID = "01a06d02-7800-7000-8000-000000000001";

/** Ship release: a nightly schedule or a new issue starts it; an agent reviews, then a pull request opens. */
const SOURCE = `name: Ship release
description: Reviews the main branch and opens the release pull request.
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
  - id: on_issue
    kind: start
    on:
      kind: github.issue.opened
steps:
  - id: review
    kind: agent
    agent: 01a06d02-7b00-7000-8000-000000000001
    prompt: Review the main branch.
  - id: open_pr
    kind: action
    action: github/pr.create
`;

const SHIP: Workflow = {
  id: SHIP_ID,
  enabled: true,
  source: SOURCE,
  createdAt: AT,
  updatedAt: AT,
};

/** Tag release: a second workflow, with Ship release's steps under another name. */
const TAG: Workflow = {
  ...SHIP,
  id: "01a06d02-7800-7000-8000-000000000002",
  source: SOURCE.replace("name: Ship release", "name: Tag release"),
};

const SHIP_SUMMARY: WorkflowSummary = {
  id: SHIP_ID,
  name: "Ship release",
  enabled: true,
  updatedAt: AT,
};

const ACTIONS: readonly WorkflowAction[] = [
  {
    id: "github/pr.create",
    displayName: "Open a GitHub pull request",
    description: "Opens a pull request.",
    runsIn: "controller",
    inputSchema: { type: "object" },
  },
];

/** Returns start trigger `triggerId` of Ship release, firing on `on`. */
const buildTrigger = (triggerId: string, on: TriggerOn, over: Partial<Trigger> = {}): Trigger => ({
  workflowId: SHIP_ID,
  workflowName: "Ship release",
  triggerId,
  kind: "start",
  on,
  status: "active",
  health: { state: "ok" },
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const NIGHTLY = buildTrigger(
  "nightly",
  { schedule: "0 1 * * *" },
  { nextFireAt: "2026-10-12T01:00:00.000Z" },
);
const ON_ISSUE = buildTrigger(
  "on_issue",
  { kind: "github.issue.opened" },
  { health: { state: "error", message: "No such key: labels", at: AT } },
);

/** Returns the fields every run of Ship release shares, created at `createdAt`. */
const buildRunFields = (id: string, createdAt: string) => ({
  id,
  workflowId: SHIP_ID,
  workflowName: "Ship release",
  origin: { kind: "manual" as const, actor: "user" },
  createdAt,
});

const LIVE: RunSummary = {
  ...buildRunFields("01a06d02-7900-7000-8000-000000000001", "2026-10-11T09:30:00.000Z"),
  status: "running",
  startedAt: "2026-10-11T09:30:00.000Z",
  activeStepIds: ["review"],
  awaitedSignalIds: [],
};
const DONE: RunSummary = {
  ...buildRunFields("01a06d02-7900-7000-8000-000000000002", "2026-10-10T09:30:00.000Z"),
  status: "completed",
  startedAt: "2026-10-10T09:30:00.000Z",
  finishedAt: "2026-10-10T09:40:00.000Z",
};

/** Answers `run.query` with the runs, newest first; a day's read gets the runs that touch it. */
const answerRunQuery = (runs: readonly RunSummary[]) => (call: Call) => {
  const params = new URLSearchParams(call.search);
  const activeSince = params.get("activeSince");
  const until = params.get("until");
  if (activeSince === null || until === null) return { body: { items: runs } };
  return {
    body: {
      items: runs.filter(
        (run) =>
          run.createdAt < until &&
          ("finishedAt" in run && run.finishedAt !== undefined
            ? run.finishedAt >= activeSince
            : true),
      ),
    },
  };
};

/**
 * Opens the app on Ship release at `search`, with `overrides` over the
 * controller's answers, and waits for the page's heading to show.
 */
const openShip = async ({
  search = "",
  runs = [LIVE, DONE],
  overrides = {},
}: {
  readonly search?: string;
  readonly runs?: readonly RunSummary[];
  readonly overrides?: Readonly<Record<string, Handler>>;
} = {}) => {
  const calls = stubApi({
    ...buildSidebarHandlers(SIDEBAR_FIXTURE),
    "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
    "GET /api/v1/workflows": { body: { items: [SHIP_SUMMARY] } },
    [`GET /api/v1/workflows/${SHIP_ID}`]: { body: SHIP },
    "GET /api/v1/triggers": { body: { items: [NIGHTLY, ON_ISSUE] } },
    "GET /api/v1/runs": answerRunQuery(runs),
    "GET /api/v1/agents": { body: { items: [] } },
    "GET /api/v1/workflow-actions": { body: ACTIONS },
    ...overrides,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: `/workflows/${SHIP_ID}${search}` },
  );
  await screen.findByRole("heading", { level: 1, name: "Ship release" });
  return { calls, ...app };
};

/** Returns how many GET requests in `calls` went to `path`. */
const countReads = (calls: readonly Call[], path: string): number =>
  calls.filter((call) => call.method === "GET" && call.path === path).length;

const getPage = () => screen.getByRole("region", { name: "Ship release" });
const getTabs = () => within(getPage()).getByRole("tablist", { name: "Workflow" });
const getTab = (name: RegExp) => within(getTabs()).getByRole("tab", { name });
const getPanel = () => within(getPage()).getByRole("tabpanel");
const getWorkflowSwitch = () => within(getPage()).getByRole("switch", { name: "Enabled" });

/**
 * Returns the text of each cell of each row in the open tab, in order. It
 * waits for the rows, because the Runs list draws its rows once it has
 * measured the pane, a render after the page shows.
 */
const readRows = async (): Promise<string[][]> =>
  (await within(getPanel()).findAllByRole("listitem")).map((item) => {
    const row = item.classList.contains("table-row") ? item : item.querySelector(".table-row")!;
    return [...row.children].map((cell) => cell.textContent ?? "");
  });

describe("the open workflow's lead", () => {
  it("shows the name with its switch, what the switch does, the description and the chips", async () => {
    await openShip();

    // The page is a region named by its heading.
    expect(getPage().getAttribute("aria-labelledby")).toBe(
      within(getPage()).getByRole("heading", { level: 1 }).id,
    );
    expect(getWorkflowSwitch().getAttribute("aria-checked")).toBe("true");
    expect(
      within(getPage()).getByText(
        "When on, its triggers start runs. Runs already going are not touched.",
      ),
    ).toBeTruthy();
    expect(
      within(getPage()).getByText("Reviews the main branch and opens the release pull request."),
    ).toBeTruthy();
    const chips = within(getPage()).getByRole("list", { name: "About this workflow" });
    expect(
      within(chips)
        .getAllByRole("listitem")
        .map((chip) => chip.textContent),
    ).toEqual([
      "Daily at 01:00 · next Mon 01:00",
      "github.issue.opened · error",
      "1 agent · 1 action",
    ]);
    // A chip in error is drawn in the failure's colours, which only its class shows.
    expect(
      within(chips)
        .getByText(/github\.issue\.opened/)
        .closest("li")
        ?.classList.contains("chip--fail"),
    ).toBe(true);
  });

  it("opens a step's card from the graph", async () => {
    await openShip();
    const graph = within(getPage()).getByRole("group", { name: "The steps of Ship release" });
    const step = within(graph).getByRole("button", { name: /^open_pr, / });

    await userEvent.click(step);

    expect(step.getAttribute("aria-expanded")).toBe("true");
    // jsdom hides every popover, so the card is found with hidden elements.
    const card = screen.getByRole("dialog", { hidden: true });
    expect(card.getAttribute("aria-label")).toMatch(/^open_pr, /);
    expect(card.textContent).toContain("Open a GitHub pull request");
  });
});

describe("the open workflow's switches", () => {
  it("turn the workflow off with workflow.update, and show the off hint", async () => {
    // The page reads the workflow again after the save, so the controller
    // answers with what it saved.
    let saved = SHIP;
    const { calls } = await openShip({
      overrides: {
        [`GET /api/v1/workflows/${SHIP_ID}`]: () => ({ body: saved }),
        [`PATCH /api/v1/workflows/${SHIP_ID}`]: () => {
          saved = { ...SHIP, enabled: false };
          return { body: { workflow: saved, warnings: [] } };
        },
      },
    });

    await userEvent.click(getWorkflowSwitch());

    await waitFor(() => expect(getWorkflowSwitch().getAttribute("aria-checked")).toBe("false"));
    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.body).toEqual({ enabled: false });
    expect(
      within(getPage()).getByText(
        "Its triggers start no runs while it is off. Runs already going are not touched.",
      ),
    ).toBeTruthy();
  });

  it("put the workflow's switch back and say why when its save fails", async () => {
    await openShip({
      overrides: {
        [`PATCH /api/v1/workflows/${SHIP_ID}`]: {
          status: 500,
          body: buildErrorBody("internal", "the disk is full"),
        },
      },
    });

    await userEvent.click(getWorkflowSwitch());

    const alert = await within(getPage()).findByRole("alert");
    expect(alert.textContent).toBe("Could not save: the disk is full");
    expect(getWorkflowSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("pause a start trigger, and put its switch back and say why when the save fails", async () => {
    // The page reads the triggers again after a save, so the controller
    // answers with what it saved.
    let nightlyNow = NIGHTLY;
    const { calls } = await openShip({
      overrides: {
        "GET /api/v1/triggers": () => ({ body: { items: [nightlyNow, ON_ISSUE] } }),
        [`POST /api/v1/workflows/${SHIP_ID}/triggers/nightly/pause`]: () => {
          nightlyNow = { ...NIGHTLY, status: "paused" };
          return { body: nightlyNow };
        },
        [`POST /api/v1/workflows/${SHIP_ID}/triggers/on_issue/pause`]: {
          status: 500,
          body: buildErrorBody("internal", "the disk is full"),
        },
      },
    });
    await userEvent.click(getTab(/^Triggers/));
    const nightly = within(getPanel()).getByRole("switch", { name: "nightly starts runs" });

    await userEvent.click(nightly);

    await waitFor(() => expect(nightly.getAttribute("aria-checked")).toBe("false"));
    expect(calls.some((call) => call.path.endsWith("/triggers/nightly/pause"))).toBe(true);

    const onIssue = within(getPanel()).getByRole("switch", { name: "on_issue starts runs" });
    await userEvent.click(onIssue);

    const alert = await within(getPanel()).findByRole("alert");
    expect(alert.textContent).toBe("Could not save: the disk is full");
    expect(onIssue.getAttribute("aria-checked")).toBe("true");
  });

  it("keep a trigger's failure under that trigger while another trigger saves", async () => {
    let nightlyNow = NIGHTLY;
    await openShip({
      overrides: {
        "GET /api/v1/triggers": () => ({ body: { items: [nightlyNow, ON_ISSUE] } }),
        [`POST /api/v1/workflows/${SHIP_ID}/triggers/on_issue/pause`]: {
          status: 500,
          body: buildErrorBody("internal", "the disk is full"),
        },
        [`POST /api/v1/workflows/${SHIP_ID}/triggers/nightly/pause`]: () => {
          nightlyNow = { ...NIGHTLY, status: "paused" };
          return { body: nightlyNow };
        },
      },
    });
    await userEvent.click(getTab(/^Triggers/));
    await userEvent.click(within(getPanel()).getByRole("switch", { name: "on_issue starts runs" }));
    await within(getPanel()).findByRole("alert");

    await userEvent.click(within(getPanel()).getByRole("switch", { name: "nightly starts runs" }));

    await waitFor(() =>
      expect(
        within(getPanel())
          .getByRole("switch", { name: "nightly starts runs" })
          .getAttribute("aria-checked"),
      ).toBe("false"),
    );
    const [alert, ...others] = within(getPanel()).getAllByRole("alert");
    expect(others).toEqual([]);
    expect(
      within(getPanel())
        .getByRole("switch", { name: "on_issue starts runs" })
        .getAttribute("aria-describedby"),
    ).toBe(alert!.id);
  });

  it("clear a failure when a press queued behind the failed save saves", async () => {
    const first = holdAnswer();
    let patches = 0;
    await openShip({
      overrides: {
        [`PATCH /api/v1/workflows/${SHIP_ID}`]: () =>
          ++patches === 1 ? first.handler() : { body: { workflow: SHIP, warnings: [] } },
      },
    });

    // Off, then on again while the first save is on its way.
    await userEvent.click(getWorkflowSwitch());
    await userEvent.click(getWorkflowSwitch());
    first.answer({ status: 500, body: buildErrorBody("internal", "the disk is full") });

    await waitFor(() => expect(patches).toBe(2));
    await waitFor(() => expect(within(getPage()).queryByRole("alert")).toBeNull());
    expect(getWorkflowSwitch().getAttribute("aria-checked")).toBe("true");
  });

  it("end as the controller has the workflow when a newer change arrives while a save is on its way", async () => {
    const save = holdAnswer();
    const NEWER_SOURCE = SOURCE.replace(
      "description: Reviews the main branch and opens the release pull request.",
      "description: Opens the release pull request.",
    );
    let stored = SHIP;
    const { live, context } = await openShip({
      overrides: {
        [`GET /api/v1/workflows/${SHIP_ID}`]: () => ({ body: stored }),
        [`PATCH /api/v1/workflows/${SHIP_ID}`]: save.handler,
      },
    });
    await waitFor(() => expect(live.readTopics()).toContain("workflow"));

    await userEvent.click(getWorkflowSwitch());
    // Another writer changes the description after the switch was saved.
    stored = { ...SHIP, enabled: false, source: NEWER_SOURCE };
    act(() => live.pushInvalidation("workflow", [SHIP_ID]));
    await within(getPage()).findByText("Opens the release pull request.");
    // The save's answer holds the workflow as it was saved, before that change.
    save.answer({ body: { workflow: { ...SHIP, enabled: false }, warnings: [] } });

    // The save counts as running until the workflow is read again.
    await waitFor(() => expect(context.queryClient.isMutating()).toBe(0));
    expect(getWorkflowSwitch().getAttribute("aria-checked")).toBe("false");
    expect(within(getPage()).getByText("Opens the release pull request.")).toBeTruthy();
  });
});

describe("an open workflow that is deleted", () => {
  it("says the workflow was not found", async () => {
    let isDeleted = false;
    const { live } = await openShip({
      overrides: {
        [`GET /api/v1/workflows/${SHIP_ID}`]: () =>
          isDeleted
            ? { status: 404, body: buildErrorBody("not_found", `no workflow ${SHIP_ID}`) }
            : { body: SHIP },
      },
    });
    await waitFor(() => expect(live.readTopics()).toContain("workflow"));

    isDeleted = true;
    act(() => live.pushInvalidation("workflow", [SHIP_ID]));

    await screen.findByRole("heading", { level: 1, name: "This workflow was not found." });
  });
});

describe("opening another workflow from an open one", () => {
  it("reads the Agents and the workflow actions again, and a new search reads neither", async () => {
    const { calls, router } = await openShip({
      overrides: { [`GET /api/v1/workflows/${TAG.id}`]: { body: TAG } },
    });
    const agentReads = countReads(calls, "/api/v1/agents");
    const actionReads = countReads(calls, "/api/v1/workflow-actions");

    await act(() =>
      router.navigate({ to: "/workflows/$workflowId", params: { workflowId: TAG.id } }),
    );

    await screen.findByRole("heading", { level: 1, name: "Tag release" });
    await waitFor(() => expect(countReads(calls, "/api/v1/agents")).toBe(agentReads + 1));
    await waitFor(() =>
      expect(countReads(calls, "/api/v1/workflow-actions")).toBe(actionReads + 1),
    );

    await act(() =>
      router.navigate({
        to: "/workflows/$workflowId",
        params: { workflowId: TAG.id },
        search: { runsView: "timeline" },
      }),
    );

    await screen.findByRole("group", { name: "Runs, Today" });
    expect(countReads(calls, "/api/v1/agents")).toBe(agentReads + 1);
    expect(countReads(calls, "/api/v1/workflow-actions")).toBe(actionReads + 1);
  });
});

describe("the open workflow's tabs", () => {
  it("open on Runs, with the counts of the triggers and the inputs", async () => {
    await openShip();

    expect(
      within(getTabs())
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Runs", "Triggers2", "Inputs1", "Source"]);
    expect(getTab(/^Runs/).getAttribute("aria-selected")).toBe("true");
    expect(getPanel().getAttribute("aria-labelledby")).toBe(getTab(/^Runs/).id);
    // A panel with nothing in it that takes focus is in the tab order itself.
    expect(getPanel().tabIndex).toBe(0);
  });

  it("move with ←, →, Home and End, with only the open tab in the tab order", async () => {
    await openShip();
    act(() => getTab(/^Runs/).focus());

    fireEvent.keyDown(getTab(/^Runs/), { key: "ArrowRight" });
    expect(document.activeElement).toBe(getTab(/^Triggers/));
    expect(getTab(/^Triggers/).getAttribute("aria-selected")).toBe("true");
    expect(
      within(getTabs())
        .getAllByRole("tab")
        .map((tab) => tab.tabIndex),
    ).toEqual([-1, 0, -1, -1]);

    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(getTab(/^Source/));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(document.activeElement).toBe(getTab(/^Runs/));

    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(getTab(/^Source/));

    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(document.activeElement).toBe(getTab(/^Runs/));
  });

  it("show each start trigger's switch and state in Triggers, the inputs in Inputs, and the source in Source", async () => {
    await openShip();

    await userEvent.click(getTab(/^Triggers/));
    expect(await readRows()).toEqual([
      ["", "nightly", "Starts a run", "Daily at 01:00", "Next Mon 01:00", ""],
      ["", "on_issue", "Starts a run", "github.issue.opened", "No such key: labels", ""],
    ]);
    // Each row holds a switch, so the panel itself is not in the tab order.
    expect(getPanel().hasAttribute("tabindex")).toBe(false);

    await userEvent.click(getTab(/^Inputs/));
    expect(await readRows()).toEqual([["version", "string", "Required", ""]]);

    await userEvent.click(getTab(/^Source/));
    expect(getPanel().tagName).toBe("PRE");
    expect(getPanel().textContent).toBe(SOURCE);
  });

  it("drops Started by and Does from a narrow pane", async () => {
    await openShip();

    // Below 560px of pane, a container query on `.open-pane` hides these
    // cells (workflow-detail.css). jsdom evaluates no container query, so
    // the test checks the cells carry the classes the query hides.
    const [live] = await within(getPanel()).findAllByRole("listitem");
    expect(live!.querySelector(".col-by")?.textContent).toBe("You");

    await userEvent.click(getTab(/^Triggers/));
    expect(getPanel().querySelector(".col-does")?.textContent).toBe("Starts a run");
  });

  it("open on Runs again for the next workflow", async () => {
    const { router } = await openShip();
    await userEvent.click(getTab(/^Source/));

    await act(() => router.navigate({ to: "/workflows" }));
    await act(() =>
      router.navigate({ to: "/workflows/$workflowId", params: { workflowId: SHIP_ID } }),
    );

    await waitFor(() => expect(getTab(/^Runs/).getAttribute("aria-selected")).toBe("true"));
  });
});

describe("the Runs tab", () => {
  it("lists the runs, newest first, each with its status, who started it, how long it took and when", async () => {
    await openShip();

    expect(await readRows()).toEqual([
      ["", "At review", "You", "30m 0s", "09:30"],
      ["", "Completed", "You", "10m 0s", "Sat"],
    ]);
  });

  it("says when the workflow has no runs", async () => {
    await openShip({ runs: [] });

    expect(within(getPanel()).getByText("No runs yet")).toBeTruthy();
  });

  it("switches to the timeline and back, replacing the history entry and dropping the day", async () => {
    const { router } = await openShip({ search: "?full=true" });
    const length = router.history.length;
    const picker = within(getPage()).getByRole("group", { name: "Show the runs as" });

    await userEvent.click(within(picker).getByRole("button", { name: "Timeline" }));

    await waitFor(() =>
      expect(router.state.location.search).toEqual({ full: true, runsView: "timeline" }),
    );
    expect(router.history.length).toBe(length);
    const lanes = await within(getPanel()).findByRole("group", { name: "Runs, Today" });
    expect(
      within(lanes)
        .getAllByRole("img")
        .map((bar) => bar.getAttribute("aria-label")),
    ).toEqual([expect.stringMatching(/^At review/)]);

    await userEvent.click(within(getPage()).getByRole("button", { name: "Show the day before" }));
    await waitFor(() =>
      expect(router.state.location.search).toEqual({
        full: true,
        runsView: "timeline",
        daysBack: 1,
      }),
    );

    // ← in the switch picks the list, which goes back to today.
    fireEvent.keyDown(within(picker).getByRole("button", { name: "Timeline" }), {
      key: "ArrowLeft",
    });

    await waitFor(() => expect(router.state.location.searchStr).toBe("?full=true"));
    expect(router.history.length).toBe(length);
    expect(document.activeElement).toBe(within(picker).getByRole("button", { name: "List" }));
  });

  it("steps through the days on the timeline, replacing the history entry", async () => {
    const { router } = await openShip({ search: "?runsView=timeline" });
    const length = router.history.length;
    const after = within(getPage()).getByRole("button", { name: "Show the day after" });
    expect(after.getAttribute("aria-disabled")).toBe("true");
    expect(within(getPage()).queryByRole("button", { name: "Today" })).toBeNull();

    await userEvent.click(within(getPage()).getByRole("button", { name: "Show the day before" }));

    await within(getPanel()).findByRole("group", { name: "Runs, Yesterday" });
    expect(router.state.location.search).toEqual({ runsView: "timeline", daysBack: 1 });
    expect(router.history.length).toBe(length);
    expect(after.getAttribute("aria-disabled")).toBeNull();

    await userEvent.click(within(getPage()).getByRole("button", { name: "Show the day before" }));
    await within(getPanel()).findByRole("group", { name: "Runs, 9 Oct" });
    expect(within(getPanel()).getByText("No runs this day")).toBeTruthy();

    await userEvent.click(within(getPage()).getByRole("button", { name: "Today" }));

    await within(getPanel()).findByRole("group", { name: "Runs, Today" });
    expect(router.state.location.search).toEqual({ runsView: "timeline" });
    expect(router.history.length).toBe(length);
  });

  it("steps back no further than the oldest day the timeline shows", async () => {
    const { router } = await openShip({
      search: `?runsView=timeline&daysBack=${MAX_TIMELINE_DAYS_BACK}`,
    });
    const before = within(getPage()).getByRole("button", { name: "Show the day before" });
    expect(before.getAttribute("aria-disabled")).toBe("true");

    await userEvent.click(before);

    expect(router.state.location.search).toEqual({
      runsView: "timeline",
      daysBack: MAX_TIMELINE_DAYS_BACK,
    });
  });

  it("shows today for a day older than the timeline shows", async () => {
    const { router } = await openShip({
      search: `?runsView=timeline&daysBack=${MAX_TIMELINE_DAYS_BACK + 1}`,
    });

    expect(within(getPanel()).getByRole("group", { name: "Runs, Today" })).toBeTruthy();
    expect(
      within(getPage())
        .getByRole("button", { name: "Show the day after" })
        .getAttribute("aria-disabled"),
    ).toBe("true");

    // Stepping on writes a URL with the day dropped, not set to nothing.
    await userEvent.click(within(getPage()).getByRole("button", { name: "Show the day before" }));
    await within(getPanel()).findByRole("group", { name: "Runs, Yesterday" });
    expect(router.state.location.searchStr).toBe("?runsView=timeline&daysBack=1");
  });

  it("says when today has no runs", async () => {
    await openShip({ search: "?runsView=timeline", runs: [] });

    expect(within(getPanel()).getByText("No runs today")).toBeTruthy();
  });
});

describe("a workflow that does not exist", () => {
  it("says so, with a link to the workflows", async () => {
    const missing = "01a06d02-7800-7000-8000-00000000dead";
    stubApi({
      ...buildSidebarHandlers(SIDEBAR_FIXTURE),
      "GET /api/v1/workflows": { body: { items: [SHIP_SUMMARY] } },
      [`GET /api/v1/workflows/${missing}`]: {
        status: 404,
        body: buildErrorBody("not_found", `no workflow ${missing}`),
      },
      "GET /api/v1/triggers": { body: { items: [] } },
      "GET /api/v1/runs": { body: { items: [] } },
      "GET /api/v1/agents": { body: { items: [] } },
      "GET /api/v1/workflow-actions": { body: [] },
    });
    await renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), {
      path: `/workflows/${missing}`,
    });

    const headline = await screen.findByRole("heading", {
      level: 1,
      name: "This workflow was not found.",
    });
    // The sidebar links to Workflows too, so the link is found beside the headline.
    const link = within(headline.parentElement!).getByRole("link", { name: "Workflows" });
    expect(link.getAttribute("href")).toBe("/workflows");
  });
});
