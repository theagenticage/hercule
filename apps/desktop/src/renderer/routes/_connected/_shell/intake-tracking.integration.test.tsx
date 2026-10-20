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
  type Call,
  type Handler,
} from "../../../app/testing";

// The Office draws a 3D scene, which jsdom cannot, so a stub stands in for it.
vi.mock("../../../office/office-screen", () => ({ OfficeScreen: () => <p>The Office</p> }));

beforeEach(() => {
  stubElementSize(1168, 800);
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
const getTray = () => document.querySelector<HTMLElement>(".tr-tray")!;
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
    expect(toast.textContent).toBe("Couldn't mark done: The database is busy.");
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
  it("reads the Tasks once and their runs once as the shell loads, and reads the runs once on a run push", async () => {
    const { calls, live } = await openIntake();
    await live.waitForFirstPushes();
    const tasksBefore = findTrackingTasksCalls(calls).length;
    const runsBefore = findTrackedRunsCalls(calls);
    expect(runsBefore.length).toBeGreaterThan(0);
    expect(new URLSearchParams(runsBefore[0]!.search).getAll("taskIds").toSorted()).toEqual(
      [FINISHED_TASK, FAILED_TASK, WORKING_TASK, STOPPED_TASK].map((task) => task.id).toSorted(),
    );
    expect(new URLSearchParams(findTrackingTasksCalls(calls)[0]!.search).get("handedOff")).toBe(
      "true",
    );

    act(() => live.pushInvalidation("run", [getRunId(WORKING_TASK)]));
    await waitFor(() => {
      expect(findTrackedRunsCalls(calls)).toHaveLength(runsBefore.length + 1);
    });
    expect(findTrackingTasksCalls(calls)).toHaveLength(tasksBefore);
  });

  it("makes no run request while no Task is tracked, also on a push", async () => {
    const { calls, live } = await openIntake("/intake", { extra: storeTracking([]) });
    await live.waitForFirstPushes();
    act(() => live.pushInvalidation("run"));
    act(() => live.pushInvalidation("task"));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(findTrackedRunsCalls(calls)).toHaveLength(0);
    expect(findTrackingTasksCalls(calls).length).toBeGreaterThan(0);
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
