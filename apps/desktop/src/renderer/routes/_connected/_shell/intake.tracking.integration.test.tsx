/**
 * Tests Tracking in Intake: the rows folded under the list and opened over
 * it, the keys that walk and tick them off, opening a row's run, and the
 * To do count that takes in the rows that wait on the user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginDetail, Run, RunSummary, Signal, Task } from "@hercule/contract";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  stubIntersectionObserver,
  type Answer,
  type Call,
  type Handler,
} from "../../../app/testing";

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

beforeEach(() => {
  stubElementSize(1168, 800);
  // Every row is in view as soon as it is watched, until a test scrolls it away.
  stubIntersectionObserver();
  // jsdom lays nothing out, so it has no `scrollIntoView`.
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  localStorage.clear();
});

const GITHUB: PluginDetail = {
  id: "github",
  displayName: "GitHub",
  mark: { paths: ["M8 0a8 8 0 1 0 0 16A8 8 0 0 0 8 0z"] },
  hostApi: 2,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
  intake: { eventKinds: [], signalKinds: [] },
};

const buildSignal = (id: string, title: string): Signal => ({
  id,
  kind: "github/review-requested",
  origin: { type: "api", actor: "user", eventIds: [], reason: "Seen twice" },
  title,
  priority: "normal",
  blocks: [],
  actions: [],
  match: {},
  status: "open",
  createdAt: "2026-10-10T09:18:00.000Z",
});

const FIRST_SIGNAL = buildSignal("01a06d02-7a00-7000-8000-000000000001", "Retry Stripe webhooks");
const SECOND_SIGNAL = buildSignal("01a06d02-7a00-7000-8000-000000000002", "Cart total rounding");

const WORKFLOW_ID = "01a06d02-7d00-7000-8000-000000000001";

/** Returns the id of the run of `task`: the Task's id with another group, so each Task has one run. */
const getRunId = (task: Task): string => task.id.replace("-7b00-", "-7c00-");

const HANDOFF_AT = "2026-10-20T08:00:00.000Z";
const at = (minutes: number): string =>
  new Date(Date.parse(HANDOFF_AT) + minutes * 60_000).toISOString();

/** Builds a Task handed off `minutes` after 08:00, in progress. */
const buildTask = (id: string, title: string, minutes: number): Task => ({
  id,
  title,
  description: "",
  status: "in-progress",
  priority: "normal",
  labels: [],
  provenance: [
    {
      signalId: id.replace("-7b00-", "-7a00-"),
      runId: id.replace("-7b00-", "-7c00-"),
      at: at(minutes),
      actor: "user",
    },
  ],
  createdAt: at(minutes),
  updatedAt: at(minutes),
  statusChangedAt: at(minutes),
});

const FINISHED_TASK = buildTask(
  "01a06d02-7b00-7000-8000-000000000001",
  "Rate-limit the public API",
  1,
);
const FAILED_TASK = buildTask(
  "01a06d02-7b00-7000-8000-000000000002",
  "Nightly backup job timing out",
  2,
);
const WORKING_TASK = buildTask(
  "01a06d02-7b00-7000-8000-000000000003",
  "Lowercase SKUs in search",
  3,
);
const STOPPED_TASK = buildTask(
  "01a06d02-7b00-7000-8000-000000000004",
  "Move invoices to the new renderer",
  4,
);

const SUMMARY = {
  workflowId: WORKFLOW_ID,
  workflowName: "Implement",
  origin: { kind: "manual", actor: "user" },
} as const;

/** Builds the run of `task`, which the Tracking rows read their state from. */
const buildRunSummary = (
  task: Task,
  status: RunSummary["status"],
  workflowName = "Implement",
): RunSummary => {
  // Each run ends a minute after the one of the Task before it, so the rows entered
  // their states one after the other.
  const endedAt = at(20 + Number(task.id.at(-1)));
  const fields = {
    ...SUMMARY,
    workflowName,
    id: getRunId(task),
    taskId: task.id,
    createdAt: at(10),
  };
  switch (status) {
    case "pending":
      return { ...fields, status };
    case "running":
      return {
        ...fields,
        status,
        startedAt: at(11),
        activeStepIds: ["code"],
        awaitedSignalIds: [],
      };
    case "completed":
      return { ...fields, status, startedAt: at(11), finishedAt: endedAt };
    case "failed":
      return {
        ...fields,
        status,
        failureReason: "step-failed",
        failedStepId: "code",
        startedAt: at(11),
        finishedAt: endedAt,
      };
    case "cancelled":
      return { ...fields, status, finishedAt: endedAt };
  }
};

/** The failed run as `run.read` returns it, with the error of the step that failed. */
const FAILED_RUN = {
  id: getRunId(FAILED_TASK),
  taskId: FAILED_TASK.id,
  workflowId: WORKFLOW_ID,
  plan: {
    name: "Implement",
    triggers: [{ id: "manual", kind: "start", on: { kind: "manual" } }],
    steps: [{ id: "code", kind: "action", action: "task.create" }],
    edges: [],
  },
  inputs: {},
  origin: { kind: "manual", actor: "user" },
  subscriptions: [],
  edgeTraversals: [],
  createdAt: at(10),
  status: "failed",
  failureReason: "step-failed",
  failedStepId: "code",
  startedAt: at(11),
  finishedAt: at(20),
  steps: [
    {
      stepId: "code",
      iteration: 1,
      status: "failed",
      startedAt: at(11),
      finishedAt: at(20),
      error: { code: "denied", message: "permission denied on ops-db" },
    },
  ],
} as Run;

/** The four rows Tracking shows by default: one in each state. */
const ROWS = [
  [FINISHED_TASK, "completed"],
  [FAILED_TASK, "failed"],
  [WORKING_TASK, "running"],
  [STOPPED_TASK, "cancelled"],
] as const;

/**
 * Returns handlers that play the controller's Tasks and runs on one stored
 * list: `task.query` lists the Tasks still in progress, `run.query` the runs of
 * the Tasks it names, and `task.update` marks a Task done.
 */
const storeTracking = (rows: ReadonlyArray<readonly [Task, RunSummary["status"]]> = ROWS) => {
  let tasks = rows.map(([task]) => task);
  const runs = rows.map(([task, status]) => buildRunSummary(task, status));
  const handlers: Record<string, Handler> = {
    "GET /api/v1/tasks": () => ({
      body: { items: tasks.filter((t) => t.status === "in-progress") },
    }),
    "GET /api/v1/runs": (call) => {
      const taskIds = new URLSearchParams(call.search).getAll("taskIds");
      return { body: { items: runs.filter((run) => taskIds.includes(run.taskId ?? "")) } };
    },
    [`GET /api/v1/runs/${FAILED_RUN.id}`]: { body: FAILED_RUN },
  };
  for (const [task] of rows) {
    handlers[`PATCH /api/v1/tasks/${task.id}`] = () => {
      tasks = tasks.map((each) => (each.id === task.id ? { ...each, status: "done" } : each));
      return { body: tasks.find((each) => each.id === task.id) };
    };
  }
  return handlers;
};

/** Opens the app at `path` with `signals` on To do, and the handlers `extra` adds. */
const openIntake = async (
  path = "/intake",
  { signals = [FIRST_SIGNAL, SECOND_SIGNAL], extra = storeTracking() } = {},
) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, signals, plugins: [GITHUB] }),
    "GET /api/v1/signals": (call) => ({
      body: {
        items: new URLSearchParams(call.search).get("view") === "later" ? [] : signals,
      },
    }),
    ...extra,
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path },
  );
  await screen.findByRole("heading", { level: 1, name: "Intake" });
  return { calls, ...app };
};

/** Returns the Signals list, the region the signal rows and folded Tracking sit in. */
const getList = () => screen.getByRole("region", { name: "Signals" });
// Not the copy of the sheet that drops while Tracking closes, which sits in the motion layer.
const getTray = () => document.querySelector<HTMLElement>(".asks-list > .tr-tray")!;
const isOpen = () => getTray().classList.contains("is-open");
const getRowButtons = () => [...getTray().querySelectorAll<HTMLElement>("[data-task-id]")];
const getRowButton = (task: Task) =>
  getTray().querySelector<HTMLElement>(`[data-task-id="${task.id}"]`)!;
const readRowIds = () => getRowButtons().map((row) => row.dataset.taskId);
const readSelected = () =>
  getRowButtons()
    .filter((row) => row.getAttribute("aria-current") === "true")
    .map((row) => row.dataset.taskId);
const getSignalRow = (signal: Signal) =>
  document.querySelector<HTMLElement>(`[data-signal-id="${signal.id}"]`)!;
const readTabs = () =>
  within(screen.getByRole("navigation", { name: "Sources" }))
    .getAllByRole("button")
    .map((tab) => tab.textContent);
const readViewSwitcher = () =>
  within(screen.getByRole("group", { name: "View" }))
    .getAllByRole("button")
    .map((button) => button.textContent);
const findTrackingTasksCalls = (calls: ReadonlyArray<Call>) =>
  calls.filter((call) => call.method === "GET" && call.path === "/api/v1/tasks");
const findTrackedRunsCalls = (calls: ReadonlyArray<Call>) =>
  calls.filter(
    (call) =>
      call.method === "GET" &&
      call.path === "/api/v1/runs" &&
      new URLSearchParams(call.search).has("taskIds"),
  );
const findMarkDone = (calls: ReadonlyArray<Call>) =>
  calls.filter((call) => call.method === "PATCH" && call.path.startsWith("/api/v1/tasks/"));
const findToast = () =>
  waitFor(() => {
    const toast = document.querySelector<HTMLElement>(".asks-toast:not(.asks-bulk)");
    expect(toast).not.toBeNull();
    return toast!;
  });

describe("folded Tracking", () => {
  it("lies under the list with its count, how many wait on the user, and the two rows that changed last", async () => {
    await openIntake();
    const tray = getTray();
    expect(isOpen()).toBe(false);
    expect(within(tray).getByRole("heading").textContent).toContain("Tracking4");
    expect(within(tray).getByText("2 wait on you")).toBeTruthy();
    // The stopped row entered its state last, then the failed row. The finished
    // row and the working row, which entered theirs earlier, are not shown.
    expect(readRowIds()).toEqual([STOPPED_TASK.id, FAILED_TASK.id]);
    expect(tray.textContent).toContain("Show all");
  });

  it("says what the failed row failed on, from one read of its run", async () => {
    const { calls } = await openIntake("/intake?tracking=true");
    await waitFor(() => {
      expect(getRowButton(FAILED_TASK).textContent).toContain(
        "Implement failed · permission denied on ops-db",
      );
    });
    expect(calls.filter((call) => call.path === `/api/v1/runs/${FAILED_RUN.id}`)).toHaveLength(1);
  });

  it("reads the reason of a Failed row of opened Tracking only once the row has been in view", async () => {
    // A row is in view only when a test says so, as a scroll would.
    const watched = new Map<Element, IntersectionObserverCallback>();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        readonly callback: IntersectionObserverCallback;
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
        }
        observe(element: Element): void {
          watched.set(element, this.callback);
        }
        unobserve(element: Element): void {
          watched.delete(element);
        }
        disconnect(): void {
          watched.clear();
        }
      },
    );
    const { calls, live } = await openIntake("/intake?tracking=true");
    await live.waitForFirstPushes();
    const failedReads = () => calls.filter((call) => call.path === `/api/v1/runs/${FAILED_RUN.id}`);
    expect(getRowButton(FAILED_TASK).textContent).toContain("Implement failed");
    expect(getRowButton(FAILED_TASK).textContent).not.toContain("permission denied");
    expect(failedReads()).toHaveLength(0);

    const item = getRowButton(FAILED_TASK).closest(".tr-run-item")!;
    act(() => {
      watched.get(item)!(
        [{ target: item, isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    });
    await waitFor(() => {
      expect(getRowButton(FAILED_TASK).textContent).toContain(
        "Implement failed · permission denied on ops-db",
      );
    });
    expect(failedReads()).toHaveLength(1);
  });

  it("reads no run for rows that did not fail", async () => {
    const { calls } = await openIntake("/intake?tracking=true", {
      extra: storeTracking([
        [FINISHED_TASK, "completed"],
        [WORKING_TASK, "running"],
      ]),
    });
    expect(getRowButtons()).toHaveLength(2);
    expect(calls.filter((call) => /^\/api\/v1\/runs\/[^/]+$/.test(call.path))).toHaveLength(0);
  });

  it("says what Tracking is for when nothing is handed off", async () => {
    await openIntake("/intake", { extra: storeTracking([]) });
    expect(getTray().textContent).toContain(
      "Hand a signal to an agent, and follow it here until you mark it done.",
    );
    expect(getTray().textContent).not.toContain("Show all");
  });

  it("shows the same rows on every tab, and none on Later", async () => {
    await openIntake();
    const rowsOnAll = readRowIds();
    await userEvent.click(screen.getByRole("button", { name: /^GitHub/ }));
    expect(readRowIds()).toEqual(rowsOnAll);
    await userEvent.click(screen.getByRole("button", { name: /^Later/ }));
    expect(document.querySelector(".tr-tray")).toBeNull();
  });
});

describe("opened Tracking", () => {
  it("opens with T and closes with T, over the whole list, in the address", async () => {
    const { router } = await openIntake();
    getSignalRow(FIRST_SIGNAL).focus();
    await userEvent.keyboard("t");
    expect(isOpen()).toBe(true);
    expect(router.latestLocation.search).toMatchObject({ tracking: true });
    expect(readRowIds()).toHaveLength(4);
    // The rows are grouped by state, Failed first, then Finished, Working and Stopped.
    expect(readRowIds()).toEqual([
      FAILED_TASK.id,
      FINISHED_TASK.id,
      WORKING_TASK.id,
      STOPPED_TASK.id,
    ]);
    expect([...getTray().querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual([
      "Failed1",
      "Finished1",
      "Working1",
      "Stopped1",
    ]);
    // The sheet takes the focus, so the keys keep working.
    expect(getTray().contains(document.activeElement)).toBe(true);

    await userEvent.keyboard("t");
    expect(isOpen()).toBe(false);
    expect(router.latestLocation.search).not.toHaveProperty("tracking");
    expect(getList().contains(document.activeElement)).toBe(true);
  });

  it("opens with a click on the head, and closes with the way back at its top and at its foot", async () => {
    await openIntake();
    await userEvent.click(within(getTray()).getByRole("button", { name: /Tracking/ }));
    expect(isOpen()).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Intake" }));
    expect(isOpen()).toBe(false);
    await userEvent.click(within(getTray()).getByRole("button", { name: /Tracking/ }));
    await userEvent.click(screen.getByRole("button", { name: /Back to Intake/ }));
    expect(isOpen()).toBe(false);
  });

  it("opens from the address, and sums up the signals at its foot", async () => {
    await openIntake("/intake?tracking=true");
    expect(isOpen()).toBe(true);
    expect(getTray().textContent).toContain("Signals2");
    expect(getTray().textContent).toContain("Back to Intake");
  });

  it("opens only on To do, and T does nothing on Later", async () => {
    const { router } = await openIntake("/intake?view=later");
    expect(document.querySelector(".tr-tray")).toBeNull();
    screen.getByRole("region", { name: "Signals" }).focus();
    await userEvent.keyboard("t");
    expect(router.latestLocation.search).not.toHaveProperty("tracking");
    expect(document.querySelector(".tr-tray")).toBeNull();
  });

  it("clears the selected signal when it opens", async () => {
    const { router } = await openIntake(`/intake?signal=${FIRST_SIGNAL.id}`);
    getSignalRow(FIRST_SIGNAL).focus();
    await userEvent.keyboard("t");
    expect(router.latestLocation.search).not.toHaveProperty("signal");
  });

  it("walks only its rows with J and K, and the arrows", async () => {
    const { router } = await openIntake();
    getSignalRow(FIRST_SIGNAL).focus();
    await userEvent.keyboard("t");
    await userEvent.keyboard("j");
    expect(readSelected()).toEqual([FAILED_TASK.id]);
    await waitFor(() => {
      expect(document.activeElement).toBe(getRowButton(FAILED_TASK));
    });
    await userEvent.keyboard("{ArrowDown}");
    expect(readSelected()).toEqual([FINISHED_TASK.id]);
    await userEvent.keyboard("k");
    expect(readSelected()).toEqual([FAILED_TASK.id]);
    await userEvent.keyboard("{ArrowUp}");
    expect(readSelected()).toEqual([FAILED_TASK.id]);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    expect(readSelected()).toEqual([STOPPED_TASK.id]);
    expect(router.latestLocation.search).not.toHaveProperty("signal");
  });

  it("steps back with Esc: the selection, then Tracking", async () => {
    const { router } = await openIntake();
    getSignalRow(FIRST_SIGNAL).focus();
    await userEvent.keyboard("t");
    await userEvent.keyboard("j");
    expect(readSelected()).toHaveLength(1);

    await userEvent.keyboard("{Escape}");
    expect(readSelected()).toEqual([]);
    expect(isOpen()).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(isOpen()).toBe(false);
    expect(router.latestLocation.search).not.toHaveProperty("tracking");
  });

  it("finds Tracking open again on coming back from a row's run", async () => {
    const { router } = await openIntake("/intake?tracking=true");
    await userEvent.click(getRowButton(FINISHED_TASK));
    await waitFor(() => {
      expect(router.latestLocation.pathname).toBe(`/runs/${getRunId(FINISHED_TASK)}`);
    });
    act(() => {
      router.history.back();
    });
    await waitFor(() => {
      expect(router.latestLocation.pathname).toBe("/intake");
    });
    await screen.findByRole("heading", { level: 1, name: "Intake" });
    expect(isOpen()).toBe(true);
  });
});

describe("opened Tracking over the list", () => {
  it("makes the covered view switcher and signal list inert, and the sheet not", async () => {
    await openIntake();
    expect(document.querySelector(".asks-head")!.hasAttribute("inert")).toBe(false);
    expect(document.querySelector(".asks-frame")!.hasAttribute("inert")).toBe(false);
    getSignalRow(FIRST_SIGNAL).focus();
    await userEvent.keyboard("t");
    expect(document.querySelector(".asks-head")!.hasAttribute("inert")).toBe(true);
    expect(document.querySelector(".asks-frame")!.hasAttribute("inert")).toBe(true);
    expect(getTray().hasAttribute("inert")).toBe(false);
    await userEvent.keyboard("t");
    expect(document.querySelector(".asks-head")!.hasAttribute("inert")).toBe(false);
    expect(document.querySelector(".asks-frame")!.hasAttribute("inert")).toBe(false);
  });
});

describe("a row that moves to another state's heading", () => {
  /** The failed run of the Working Task, as `run.read` returns it, with its own reason. */
  const MOVED_RUN = {
    ...FAILED_RUN,
    id: getRunId(WORKING_TASK),
    taskId: WORKING_TASK.id,
    steps: [
      {
        ...FAILED_RUN.steps[0]!,
        error: { code: "full", message: "disk full on ops-db" },
      },
    ],
  } as Run;

  /** Opens opened Tracking with a Failed and a Working row, and returns how to fail the Working one. */
  const openWithMovableRow = async () => {
    let status: RunSummary["status"] = "running";
    const opened = await openIntake("/intake?tracking=true", {
      extra: {
        ...storeTracking([[FAILED_TASK, "failed"]]),
        "GET /api/v1/tasks": () => ({ body: { items: [FAILED_TASK, WORKING_TASK] } }),
        "GET /api/v1/runs": () => ({
          body: {
            items: [buildRunSummary(FAILED_TASK, "failed"), buildRunSummary(WORKING_TASK, status)],
          },
        }),
        [`GET /api/v1/runs/${MOVED_RUN.id}`]: { body: MOVED_RUN },
      },
    });
    await opened.live.waitForFirstPushes();
    return {
      ...opened,
      failWorkingRow: async () => {
        status = "failed";
        act(() => opened.live.pushInvalidation("run", [getRunId(WORKING_TASK)]));
        await waitFor(() => {
          expect(
            getRowButton(WORKING_TASK).closest(".tr-run-item")!.getAttribute("data-state"),
          ).toBe("failed");
        });
      },
    };
  };

  it("keeps the focus on the row, so the keys still reach Intake", async () => {
    const { failWorkingRow } = await openWithMovableRow();
    await userEvent.keyboard("jj");
    expect(readSelected()).toEqual([WORKING_TASK.id]);
    const before = getRowButton(WORKING_TASK);
    expect(document.activeElement).toBe(before);

    await failWorkingRow();

    // The row is drawn again under the Failed heading, as another element.
    const after = getRowButton(WORKING_TASK);
    expect(after).not.toBe(before);
    expect(document.activeElement).toBe(after);
    await userEvent.keyboard("k");
    expect(readSelected()).toEqual([FAILED_TASK.id]);
  });

  it("reads its reason once the new element comes into view, not before", async () => {
    // A row is in view only when a test says so, as a scroll would.
    const watched = new Map<Element, IntersectionObserverCallback>();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        readonly callback: IntersectionObserverCallback;
        constructor(callback: IntersectionObserverCallback) {
          this.callback = callback;
        }
        observe(element: Element): void {
          watched.set(element, this.callback);
        }
        unobserve(element: Element): void {
          watched.delete(element);
        }
        disconnect(): void {
          watched.clear();
        }
      },
    );
    const { calls, failWorkingRow } = await openWithMovableRow();
    const reasonReads = () => calls.filter((call) => call.path === `/api/v1/runs/${MOVED_RUN.id}`);
    const showRow = (task: Task) => {
      const item = getRowButton(task).closest(".tr-run-item")!;
      expect(watched.has(item)).toBe(true);
      act(() => {
        watched.get(item)!(
          [{ target: item, isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver,
        );
      });
    };
    const oldItem = getRowButton(WORKING_TASK).closest(".tr-run-item")!;

    await failWorkingRow();
    const newItem = getRowButton(WORKING_TASK).closest(".tr-run-item")!;
    expect(newItem).not.toBe(oldItem);
    expect(watched.has(oldItem)).toBe(false);
    expect(reasonReads()).toHaveLength(0);

    showRow(WORKING_TASK);
    await waitFor(() => {
      expect(getRowButton(WORKING_TASK).textContent).toContain(
        "Implement failed · disk full on ops-db",
      );
    });
    expect(reasonReads()).toHaveLength(1);
  });
});

describe("opening a row", () => {
  it("opens its run's page, folded or opened, by click and by ↩", async () => {
    const { router } = await openIntake();
    const [row] = getRowButtons();
    await userEvent.click(row!);
    await waitFor(() => {
      expect(router.latestLocation.pathname).toBe(
        `/runs/${row!.dataset.taskId!.replace("-7b00-", "-7c00-")}`,
      );
    });

    await router.navigate({ to: "/intake", search: { tracking: true } });
    await screen.findByRole("heading", { level: 1, name: "Intake" });
    getRowButton(STOPPED_TASK).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(router.latestLocation.pathname).toBe(`/runs/${getRunId(STOPPED_TASK)}`);
    });
  });
});

describe("marking a row done", () => {
  it("marks the selected Finished row done with E, and the row leaves", async () => {
    const { calls } = await openIntake("/intake?tracking=true");
    await userEvent.keyboard("jj");
    expect(readSelected()).toEqual([FINISHED_TASK.id]);

    await userEvent.keyboard("e");

    await waitFor(() => {
      expect(findMarkDone(calls).map((call) => [call.path, call.body])).toEqual([
        [`/api/v1/tasks/${FINISHED_TASK.id}`, { status: "done" }],
      ]);
    });
    await waitFor(() => {
      expect(readRowIds()).toEqual([FAILED_TASK.id, WORKING_TASK.id, STOPPED_TASK.id]);
    });
    expect((await findToast()).textContent).toBe("Marked done: Rate-limit the public API");
    // The selection goes to the next row, and the keys still work.
    expect(readSelected()).toEqual([WORKING_TASK.id]);
    expect(getTray().contains(document.activeElement)).toBe(true);
    expect(screen.getByRole("tab", { name: "Hercule, 3 to do" })).toBeTruthy();
  });

  it("marks a Failed row and a Stopped row done, and does nothing on a Working row", async () => {
    const { calls } = await openIntake("/intake?tracking=true");
    await userEvent.keyboard("jjj");
    expect(readSelected()).toEqual([WORKING_TASK.id]);
    await userEvent.keyboard("e");
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(findMarkDone(calls)).toHaveLength(0);
    expect(document.querySelector(".asks-toast")).toBeNull();
    expect(readRowIds()).toHaveLength(4);
    expect(
      within(getRowButton(WORKING_TASK).closest(".tr-run-item")!).queryByRole("button", {
        name: "Mark done",
      }),
    ).toBeNull();

    await userEvent.keyboard("j");
    await userEvent.keyboard("e");
    await waitFor(() => {
      expect(findMarkDone(calls).map((call) => call.path)).toEqual([
        `/api/v1/tasks/${STOPPED_TASK.id}`,
      ]);
    });
    await waitFor(() => {
      expect(readRowIds()).toEqual([FAILED_TASK.id, FINISHED_TASK.id, WORKING_TASK.id]);
    });
  });

  it("sends two tick-offs side by side, one per Task, and takes both rows off", async () => {
    const releases: Array<() => void> = [];
    const handlers = storeTracking();
    const hold = (task: Task): Handler => {
      const answer = handlers[`PATCH /api/v1/tasks/${task.id}`] as (call: Call) => Answer;
      return (call) =>
        new Promise((resolve) => {
          releases.push(() => resolve(answer(call)));
        });
    };
    const { calls } = await openIntake("/intake?tracking=true", {
      extra: {
        ...handlers,
        [`PATCH /api/v1/tasks/${FINISHED_TASK.id}`]: hold(FINISHED_TASK),
        [`PATCH /api/v1/tasks/${STOPPED_TASK.id}`]: hold(STOPPED_TASK),
      },
    });
    const markDone = (task: Task) =>
      userEvent.click(
        within(getRowButton(task).closest<HTMLElement>(".tr-run-item")!).getByRole("button", {
          name: "Mark done",
        }),
        { pointerEventsCheck: 0 },
      );
    await markDone(FINISHED_TASK);
    await markDone(STOPPED_TASK);
    // The second is sent while the first is still pending, not dropped.
    await waitFor(() => {
      expect(findMarkDone(calls)).toHaveLength(2);
    });
    act(() => {
      for (const release of releases) release();
    });
    await waitFor(() => {
      expect(readRowIds()).toEqual([FAILED_TASK.id, WORKING_TASK.id]);
    });
  });

  it("does not tick a row off that is Working in the last read, though it is still drawn Finished", async () => {
    let status: RunSummary["status"] = "completed";
    const { calls, live } = await openIntake("/intake?tracking=true", {
      extra: {
        ...storeTracking([[FINISHED_TASK, "completed"]]),
        "GET /api/v1/runs": () => ({
          body: { items: [buildRunSummary(FINISHED_TASK, status)] },
        }),
      },
    });
    await live.waitForFirstPushes();
    // While the pointer is on the list column, a change the user did not make waits.
    await userEvent.hover(getList());
    status = "running";
    act(() => live.pushInvalidation("run", [getRunId(FINISHED_TASK)]));
    await waitFor(() => {
      expect(calls.filter((call) => call.path === "/api/v1/runs").length).toBeGreaterThan(1);
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(getRowButton(FINISHED_TASK).closest(".tr-run-item")!.getAttribute("data-state")).toBe(
      "finished",
    );

    await userEvent.keyboard("j");
    await userEvent.keyboard("e");
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(findMarkDone(calls)).toHaveLength(0);
  });

  it("marks a row done with its Mark done control", async () => {
    const { calls } = await openIntake("/intake?tracking=true");
    const item = getRowButton(FAILED_TASK).closest<HTMLElement>(".tr-run-item")!;
    await userEvent.click(within(item).getByRole("button", { name: "Mark done" }), {
      pointerEventsCheck: 0,
    });
    await waitFor(() => {
      expect(findMarkDone(calls).map((call) => call.path)).toEqual([
        `/api/v1/tasks/${FAILED_TASK.id}`,
      ]);
    });
    await waitFor(() => {
      expect(getRowButton(FAILED_TASK)).toBeNull();
    });
  });

  it("marks a row of folded Tracking done with E while the focus is on it", async () => {
    const { calls } = await openIntake();
    const [row] = getRowButtons();
    row!.focus();
    await userEvent.keyboard("e");
    await waitFor(() => {
      expect(findMarkDone(calls)).toHaveLength(1);
    });
    expect(findMarkDone(calls)[0]!.path).toBe(`/api/v1/tasks/${row!.dataset.taskId}`);
  });

  describe("with motion", () => {
    // With motion on, the list draws the row that leaves for one more render
    // before it goes, which jsdom shows only when the durations are not 0.
    beforeEach(() => {
      document.documentElement.style.setProperty("--dur-1", "120ms");
      document.documentElement.style.setProperty("--dur-2", "200ms");
      document.documentElement.style.setProperty("--dur-3", "320ms");
      Object.defineProperty(Element.prototype, "animate", {
        value: () => ({ finished: new Promise(() => {}), cancel: () => {} }),
        configurable: true,
      });
    });
    afterEach(() => {
      document.documentElement.removeAttribute("style");
      Reflect.deleteProperty(Element.prototype, "animate");
    });

    const LAST_ROW = [[FAILED_TASK, "failed"]] as const;

    it("keeps the keys working when E marks the last row of opened Tracking done: Esc closes Tracking", async () => {
      await openIntake("/intake?tracking=true", { extra: storeTracking(LAST_ROW) });
      await userEvent.keyboard("j");
      expect(readSelected()).toEqual([FAILED_TASK.id]);
      await userEvent.keyboard("e");
      await waitFor(() => {
        expect(readRowIds()).toEqual([]);
      });
      await userEvent.keyboard("{Escape}");
      await waitFor(() => {
        expect(isOpen()).toBe(false);
      });
    });

    it("keeps the keys working when Mark done is pressed on the last row of opened Tracking", async () => {
      await openIntake("/intake?tracking=true", { extra: storeTracking(LAST_ROW) });
      const item = getRowButton(FAILED_TASK).closest<HTMLElement>(".tr-run-item")!;
      await userEvent.click(within(item).getByRole("button", { name: "Mark done" }), {
        pointerEventsCheck: 0,
      });
      await waitFor(() => {
        expect(readRowIds()).toEqual([]);
      });
      await userEvent.keyboard("{Escape}");
      await waitFor(() => {
        expect(isOpen()).toBe(false);
      });
    });

    it("keeps the focus in the list when the last row of folded Tracking is marked done", async () => {
      await openIntake("/intake", { extra: storeTracking(LAST_ROW) });
      getRowButtons()[0]!.focus();
      await userEvent.keyboard("e");
      await waitFor(() => {
        expect(readRowIds()).toEqual([]);
      });
      expect(getList().contains(document.activeElement)).toBe(true);
    });
  });

  it("shows a failed tick-off in the toast's place, and the row stays", async () => {
    await openIntake("/intake?tracking=true", {
      extra: {
        ...storeTracking(),
        [`PATCH /api/v1/tasks/${FAILED_TASK.id}`]: {
          status: 500,
          body: buildErrorBody("internal", "The database is busy."),
        },
      },
    });
    await userEvent.keyboard("j");
    await userEvent.keyboard("e");
    const toast = await findToast();
    expect(toast.getAttribute("role")).toBe("alert");
    expect(toast.classList.contains("asks-toast--fail")).toBe(true);
    expect(toast.textContent).toBe(
      "Couldn't mark Nightly backup job timing out done: The database is busy.",
    );
    expect(getRowButton(FAILED_TASK)).not.toBeNull();
  });
});

describe("the To do count", () => {
  it("counts the Finished and Failed rows with the signals, on the Hercule segment, Intake's row, All and the view switcher", async () => {
    await openIntake();
    expect(screen.getByRole("tab", { name: "Hercule, 4 to do" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Intake, 4 to do" })).toBeTruthy();
    expect(readTabs()).toEqual(["All4", "GitHub2"]);
    expect(readViewSwitcher()[0]).toBe("To do4");
  });

  it("leaves Working and Stopped rows out of the count", async () => {
    await openIntake("/intake", {
      extra: storeTracking([
        [WORKING_TASK, "running"],
        [STOPPED_TASK, "cancelled"],
      ]),
    });
    expect(screen.getByRole("tab", { name: "Hercule, 2 to do" })).toBeTruthy();
    expect(readTabs()).toEqual(["All2", "GitHub2"]);
  });

  it("counts a waiting row on every screen, not only Intake's", async () => {
    const { router } = await openIntake();
    await router.navigate({ to: "/office" });
    await screen.findByText("The Office");
    expect(screen.getByRole("tab", { name: "Hercule, 4 to do" })).toBeTruthy();
  });

  it("is read again when a Task joins Tracking or a run changes state", async () => {
    let status: RunSummary["status"] = "running";
    const handlers = storeTracking([[WORKING_TASK, "running"]]);
    const { live } = await openIntake("/intake", {
      extra: {
        ...handlers,
        "GET /api/v1/runs": () => ({
          body: { items: [buildRunSummary(WORKING_TASK, status)] },
        }),
      },
    });
    await live.waitForFirstPushes();
    expect(screen.getByRole("tab", { name: "Hercule, 2 to do" })).toBeTruthy();

    status = "completed";
    act(() => live.pushInvalidation("run", [getRunId(WORKING_TASK)]));

    await screen.findByRole("tab", { name: "Hercule, 3 to do" });
    expect(readTabs()[0]).toBe("All3");
  });
});

describe("Tracking's reads", () => {
  /** Waits for the shell's reads and the pushes' first reads, then returns how many Tracking reads there are. */
  const countReads = (calls: ReadonlyArray<Call>) => ({
    tasks: findTrackingTasksCalls(calls).length,
    runs: findTrackedRunsCalls(calls).length,
  });

  it("reads the Tasks, then all their runs in one request, when the shell loads", async () => {
    const { calls, live } = await openIntake();
    await live.waitForFirstPushes();
    const reads = calls.filter(
      (call) =>
        call.method === "GET" && (call.path === "/api/v1/tasks" || call.path === "/api/v1/runs"),
    );
    // The first read is the Tasks, and then their runs. The first pushes of the
    // `task` and `run` topics read the snapshot again after it.
    expect(reads[0]!.path).toBe("/api/v1/tasks");
    expect(new URLSearchParams(reads[0]!.search).get("handedOff")).toBe("true");
    expect(reads[1]!.path).toBe("/api/v1/runs");
    for (const runRead of findTrackedRunsCalls(calls)) {
      expect(new URLSearchParams(runRead.search).getAll("taskIds").toSorted()).toEqual(
        [FINISHED_TASK, FAILED_TASK, WORKING_TASK, STOPPED_TASK].map((task) => task.id).toSorted(),
      );
    }
  });

  it("reads the runs in chunks of at most 100 Tasks, and the Tasks to their last page", async () => {
    const many = Array.from({ length: 150 }, (_, index) =>
      buildTask(
        `01a06d02-7b00-7000-8000-${String(index + 100).padStart(12, "0")}`,
        `Task ${String(index)}`,
        index,
      ),
    );
    const { calls } = await openIntake("/intake", {
      extra: {
        "GET /api/v1/tasks": (call) =>
          new URLSearchParams(call.search).has("cursor")
            ? { body: { items: many.slice(100) } }
            : { body: { items: many.slice(0, 100), nextCursor: "page-2" } },
        "GET /api/v1/runs": () => ({ body: { items: [] } }),
      },
    });
    expect(findTrackingTasksCalls(calls)).toHaveLength(2);
    expect(
      findTrackedRunsCalls(calls)
        .map((call) => new URLSearchParams(call.search).getAll("taskIds").length)
        .toSorted((a, b) => a - b),
    ).toEqual([50, 100]);
  });

  it("makes no run request while no Task is tracked, also on a push", async () => {
    const { calls, live } = await openIntake("/intake", { extra: storeTracking([]) });
    await live.waitForFirstPushes();
    act(() => live.pushInvalidation("run"));
    act(() => live.pushInvalidation("task"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(findTrackedRunsCalls(calls)).toHaveLength(0);
    expect(findTrackingTasksCalls(calls).length).toBeGreaterThan(1);
  });

  it("reads again on a task push", async () => {
    const { calls, live } = await openIntake();
    await live.waitForFirstPushes();
    const before = countReads(calls);
    act(() => live.pushInvalidation("task", [WORKING_TASK.id]));
    await waitFor(() => {
      expect(countReads(calls)).toEqual({ tasks: before.tasks + 1, runs: before.runs + 1 });
    });
  });

  it("reads again once on a run push that names a tracked run, an older run of a Task too", async () => {
    const { calls, live } = await openIntake();
    await live.waitForFirstPushes();
    const before = countReads(calls);
    act(() => live.pushInvalidation("run", [getRunId(WORKING_TASK)]));
    await waitFor(() => {
      expect(countReads(calls)).toEqual({ tasks: before.tasks + 1, runs: before.runs + 1 });
    });
  });

  it("reads again on the creation of a run, which may be a re-run, and on a push that names no run", async () => {
    const { calls, live } = await openIntake();
    await live.waitForFirstPushes();
    const before = countReads(calls);
    act(() =>
      live.pushInvalidation("run", ["01a06d02-7c00-7000-8000-0000000000ff"], undefined, "created"),
    );
    await waitFor(() => {
      expect(countReads(calls).runs).toBe(before.runs + 1);
    });
    act(() => live.pushInvalidation("run"));
    await waitFor(() => {
      expect(countReads(calls).runs).toBe(before.runs + 2);
    });
  });

  it("does not read again on a change to a run of no tracked Task", async () => {
    const { calls, live } = await openIntake();
    await live.waitForFirstPushes();
    const before = countReads(calls);
    act(() => live.pushInvalidation("run", ["01a06d02-7c00-7000-8000-0000000000fe"]));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(countReads(calls)).toEqual(before);
  });
});

describe("To do with Tracking", () => {
  it("points to Tracking, instead of inbox zero, while rows wait on the user and no signal is open", async () => {
    await openIntake("/intake", { signals: [] });
    expect(screen.getByText("No signals. What waits on you is in Tracking.")).toBeTruthy();
    expect(document.querySelector(".asks-zero")).toBeNull();
  });

  it("is at inbox zero while the rows only work", async () => {
    await openIntake("/intake", {
      signals: [],
      extra: storeTracking([
        [WORKING_TASK, "running"],
        [STOPPED_TASK, "cancelled"],
      ]),
    });
    expect(document.querySelector(".asks-zero")).not.toBeNull();
    expect(screen.queryByText("No signals. What waits on you is in Tracking.")).toBeNull();
    // Folded Tracking stays at the foot of the zero.
    expect(isOpen()).toBe(false);
    expect(getRowButtons()).toHaveLength(2);
  });

  it("is at inbox zero again once the last waiting row is marked done", async () => {
    await openIntake("/intake?tracking=true", {
      signals: [],
      extra: storeTracking([[FINISHED_TASK, "completed"]]),
    });
    await userEvent.keyboard("j");
    await userEvent.keyboard("e");
    await waitFor(() => {
      expect(readRowIds()).toEqual([]);
    });
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(document.querySelector(".asks-zero")).not.toBeNull();
    });
  });
});

describe("a face for a run of a workflow sent with the request", () => {
  it("draws the row with the workflow's name when the run has no workflow id", async () => {
    const handlers = storeTracking([[FINISHED_TASK, "completed"]]);
    await openIntake("/intake", {
      extra: {
        ...handlers,
        "GET /api/v1/runs": () => ({
          body: {
            items: [{ ...buildRunSummary(FINISHED_TASK, "completed", "Sent"), workflowId: null }],
          },
        }),
      },
    });
    expect(getRowButton(FINISHED_TASK).textContent).toContain("Sent finished");
  });
});
