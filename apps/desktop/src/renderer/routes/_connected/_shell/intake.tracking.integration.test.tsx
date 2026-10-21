/**
 * Tests Tracking in Intake: the rows folded under the list and opened over
 * it, the keys that walk and take them off, the pane a selected row opens, its
 * answers, and the To do count that takes in the rows that wait on the user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PluginDetail,
  Run,
  RunSummary,
  Session,
  Signal,
  Task,
  TrackingDetail,
  TrackingRun,
  TrackingTask,
  YourWorkTask,
} from "@hercule/contract";
import type { TrackingRead } from "@hercule/client-core";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  holdAnswer,
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

/** Why each failed run failed, as the controller says it in `failureCause`. */
const FAILURE_CAUSES: Readonly<Record<string, string>> = {
  [getRunId(FAILED_TASK)]: "permission denied on ops-db",
};

/** Returns the run facts `task.queryTracking` holds for `run`, with the cause of a failed one. */
const buildTrackingRun = (run: RunSummary): TrackingRun => ({
  id: run.id,
  workflowId: run.workflowId,
  workflowName: run.workflowName,
  status: run.status,
  createdAt: run.createdAt,
  ...("startedAt" in run && run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
  ...("finishedAt" in run ? { finishedAt: run.finishedAt } : {}),
  awaitedSignalIds: "awaitedSignalIds" in run ? run.awaitedSignalIds : [],
  ...(run.status === "failed" ? { failureCause: FAILURE_CAUSES[run.id] ?? "step failed" } : {}),
});

/** Returns what `task.queryTracking` holds for `task`, whose one run is `run`. */
const buildTrackingTask = (task: Task, run: RunSummary): TrackingTask => ({
  taskId: task.id,
  title: task.title,
  handoffs: task.provenance.flatMap((entry) =>
    entry.signalId === undefined || entry.runId === undefined
      ? []
      : [{ signalId: entry.signalId, runId: entry.runId, at: entry.at }],
  ),
  latestRun: buildTrackingRun(run),
  ...(run.status === "pending" || run.status === "running"
    ? { latestLiveRun: buildTrackingRun(run) }
    : {}),
  liveRunIds: run.status === "pending" || run.status === "running" ? [run.id] : [],
});

/** The four rows Tracking shows by default: one in each state. */
const ROWS = [
  [FINISHED_TASK, "completed"],
  [FAILED_TASK, "failed"],
  [WORKING_TASK, "running"],
  [STOPPED_TASK, "cancelled"],
] as const;

/** Returns the id of the signal `task` was handed off: the one its first provenance entry names. */
const getHandoffSignalId = (task: Task): string => task.id.replace("-7b00-", "-7a00-");

/** Returns the id of the session of the run of `task`, which holds its thread. */
const getSessionId = (task: Task): string => task.id.replace("-7b00-", "-7400-");

/** Builds the signal `task` was handed off: Marta's request for a review, which the pane quotes. */
const buildHandoffSignal = (task: Task): Signal => ({
  ...buildSignal(getHandoffSignalId(task), "Review the rate limiter"),
  asker: "Marta",
  place: "acme/webshop#1296",
  blocks: [{ type: "text", markdown: "Could you review the `RateLimiter` before Friday?" }],
});

/**
 * Builds what `task.readTracking` returns for `task`, whose one run is `run`:
 * the handoff, the run with its session, and the `output` and
 * `endingActionStepName` the test gives.
 */
const buildTrackingDetail = (
  task: Task,
  run: RunSummary,
  extra: Partial<
    Pick<TrackingDetail, "firstHandoff" | "output" | "endingActionStepName" | "runs">
  > = {},
): TrackingDetail => ({
  firstHandoff: { ...buildTrackingTask(task, run).handoffs[0]!, workflowName: run.workflowName },
  runs: [{ ...buildTrackingRun(run), sessionId: getSessionId(task) }],
  ...extra,
});

/**
 * Returns handlers that play the controller's Tracking: `task.queryTracking`
 * lists the rows, minus the Tasks the user marked done, `task.readTracking`
 * reads one Task's trip, `signal.read` reads the signal each Task was handed
 * off, and `task.update` marks a Task done. `readRows` gives the rows at the
 * time of each read, so a test can change a run's status between two reads;
 * `buildRun` builds the run of a row; `buildExtra` gives the output of a
 * Task's trip.
 */
const storeTracking = (
  rows: ReadonlyArray<readonly [Task, RunSummary["status"]]> = ROWS,
  {
    readRows = () => rows,
    buildRun = buildRunSummary,
    buildExtra = () => ({}),
  }: {
    readRows?: () => ReadonlyArray<readonly [Task, RunSummary["status"]]>;
    buildRun?: (task: Task, status: RunSummary["status"]) => RunSummary;
    buildExtra?: (
      task: Task,
      run: RunSummary,
    ) => Partial<Pick<TrackingDetail, "firstHandoff" | "output" | "endingActionStepName" | "runs">>;
  } = {},
) => {
  const done = new Set<string>();
  const handlers: Record<string, Handler> = {
    "GET /api/v1/tasks/tracking": () => ({
      body: {
        rows: readRows()
          .filter(([task]) => !done.has(task.id))
          .map(([task, status]) => buildTrackingTask(task, buildRun(task, status))),
      },
    }),
  };
  for (const [task] of rows) {
    handlers[`PATCH /api/v1/tasks/${task.id}`] = () => {
      done.add(task.id);
      return { body: { ...task, status: "done" } };
    };
    handlers[`GET /api/v1/tasks/${task.id}/tracking`] = () => {
      const status = readRows().find(([each]) => each.id === task.id)?.[1] ?? "completed";
      const run = buildRun(task, status);
      return { body: buildTrackingDetail(task, run, buildExtra(task, run)) };
    };
    handlers[`GET /api/v1/signals/${getHandoffSignalId(task)}`] = () => ({
      body: buildHandoffSignal(task),
    });
  }
  return handlers;
};

/**
 * Returns the handler that plays the controller's Your work: of `work`, the
 * Tasks that name a signal still in `signals`, which a test may change between
 * two reads.
 */
const storeYourWork = (signals: ReadonlyArray<Signal>, work: ReadonlyArray<YourWorkTask>) => ({
  "GET /api/v1/signals/your-work": (): Answer => ({
    body: {
      tasks: work.filter((task) =>
        task.signalIds.some((id) => signals.some((signal) => signal.id === id)),
      ),
    },
  }),
});

/**
 * Opens the app at `path` with `signals` on To do, the `plugins` that raise
 * them, the live `agentSessions` of runs, and the handlers `extra` adds.
 */
const openIntake = async (
  path = "/intake",
  {
    signals = [FIRST_SIGNAL, SECOND_SIGNAL],
    plugins = [GITHUB],
    agentSessions = [] as ReadonlyArray<Session>,
    extra = storeTracking(),
  } = {},
) => {
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, signals, plugins, agentSessions }),
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
// Not the sheet that is still dropping while Tracking closes: it is inert.
const getTray = () => document.querySelector<HTMLElement>(".asks-list > .tr-tray:not([inert])")!;
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
/** Returns the reads of Tracking, which are the only reads of Tasks or runs the app makes. */
const findTrackingReads = (calls: ReadonlyArray<Call>) =>
  calls.filter((call) => call.method === "GET" && call.path === "/api/v1/tasks/tracking");
const findMarkDone = (calls: ReadonlyArray<Call>) =>
  calls.filter((call) => call.method === "PATCH" && call.path.startsWith("/api/v1/tasks/"));
/** Returns the pane of the selected row of Tracking, which is drawn while it shows and while it slides out. */
const getPane = () => document.querySelector<HTMLElement>(".asks-detail");
const isPaneShown = () => {
  const pane = getPane();
  return pane !== null && !pane.hasAttribute("inert");
};
const findToast = () =>
  waitFor(() => {
    const toast = document.querySelector<HTMLElement>(".asks-toast:not(.asks-bulk)");
    expect(toast).not.toBeNull();
    return toast!;
  });

/**
 * Stands in for a Web Animation, which jsdom lacks: it never ends by itself,
 * and a test ends it with `finish`. It records what the code asks of it.
 */
class FakeAnimation {
  playbackRate = 1;
  cancelled = false;
  reversed = 0;
  readonly finished: Promise<void>;
  private end: { resolve: () => void; reject: (reason: unknown) => void } | null = null;

  readonly target: Element;

  constructor(target: Element) {
    this.target = target;
    this.finished = new Promise((resolve, reject) => {
      this.end = { resolve, reject };
    });
    // A test that never ends the animation leaves this promise pending, and a cancelled one rejects.
    this.finished.catch(() => {});
  }

  reverse(): void {
    this.playbackRate = -this.playbackRate;
    this.reversed += 1;
  }

  cancel(): void {
    this.cancelled = true;
    this.end?.reject(new DOMException("Cancelled", "AbortError"));
  }

  finish(): void {
    this.end?.resolve();
  }
}

/** Ends `animation`, and lets what waits on it run. */
const finishAnimation = (animation: FakeAnimation) =>
  act(async () => {
    await Promise.resolve();
    animation.finish();
  });

/** The animations the code under test started, in order. */
const animations: FakeAnimation[] = [];

/** Returns the animation that moves the sheet itself, the last one started on it. */
const findSheetAnimation = (): FakeAnimation | undefined =>
  animations.findLast((animation) => animation.target.matches(".tr-tray.is-open"));

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

  it("says why the failed row failed from the read itself, and reads no run for it", async () => {
    const { calls } = await openIntake("/intake?tracking=true");
    expect(getRowButton(FAILED_TASK).textContent).toContain(
      "Implement failed · permission denied on ops-db",
    );
    expect(calls.filter((call) => call.path.startsWith("/api/v1/runs"))).toHaveLength(0);
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

  it("draws a bounded number of rows for 200 Tracked Tasks, and the selected row wherever it is", async () => {
    const tasks = Array.from({ length: 200 }, (_, index) =>
      buildTask(
        `01a06d02-7b00-7000-8000-${String(index + 100).padStart(12, "0")}`,
        `Task ${String(index)}`,
        index,
      ),
    );
    await openIntake("/intake?tracking=true", {
      extra: storeTracking(tasks.map((task) => [task, "completed"] as const)),
    });
    expect(getRowButtons().length).toBeGreaterThan(0);
    expect(getRowButtons().length).toBeLessThan(60);
    expect(getTray().querySelectorAll("*").length).toBeLessThan(2000);

    // K from nothing selects the last row, which is far out of view and is drawn.
    await userEvent.keyboard("k");
    expect(readSelected()).toHaveLength(1);
    expect(getRowButtons().length).toBeLessThan(60);
    expect(document.activeElement).toBe(
      getRowButtons().find((row) => row.getAttribute("aria-current") === "true"),
    );
  });

  it("keeps the focus on a focused row that moves out of the virtual range, so the keys still reach Intake", async () => {
    // 200 Tasks: the newest handoff is Working and shows first. The rest are Stopped and older.
    const tasks = Array.from({ length: 200 }, (_, index) =>
      buildTask(
        `01a06d02-7b00-7000-8000-${String(index + 100).padStart(12, "0")}`,
        `Task ${String(index)}`,
        200 - index,
      ),
    );
    const moving = tasks[0]!;
    let status: RunSummary["status"] = "running";
    const readRows = () =>
      tasks.map((task) => [task, task === moving ? status : "cancelled"] as const);
    const { live } = await openIntake("/intake?tracking=true", {
      extra: storeTracking(readRows(), { readRows }),
    });
    await live.waitForFirstPushes();

    // Tab to the row, with no J or K: it is focused and not selected.
    getRowButton(moving).focus();
    expect(readSelected()).toEqual([]);
    // Another client cancels its run, which moves the row to the end of Stopped, far out of view.
    status = "cancelled";
    act(() => live.pushInvalidation("task"));
    await waitFor(() => {
      expect(getTray().querySelectorAll("[data-state='working']")).toHaveLength(0);
    });

    expect(document.activeElement).not.toBe(document.body);
    expect(getTray().contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("k");
    expect(readSelected()).toHaveLength(1);
    // The pane, the selection, then Tracking.
    await userEvent.keyboard("{Escape}{Escape}{Escape}");
    await waitFor(() => {
      expect(isOpen()).toBe(false);
    });
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

  it("steps back with Esc: the pane, the selection, then Tracking", async () => {
    const { router } = await openIntake();
    getSignalRow(FIRST_SIGNAL).focus();
    await userEvent.keyboard("t");
    await userEvent.keyboard("j");
    expect(readSelected()).toHaveLength(1);
    await waitFor(() => {
      expect(isPaneShown()).toBe(true);
    });

    await userEvent.keyboard("{Escape}");
    expect(isPaneShown()).toBe(false);
    expect(readSelected()).toHaveLength(1);
    expect(isOpen()).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(readSelected()).toEqual([]);
    expect(router.latestLocation.search).not.toHaveProperty("task");
    expect(isOpen()).toBe(true);

    await userEvent.keyboard("{Escape}");
    expect(isOpen()).toBe(false);
    expect(router.latestLocation.search).not.toHaveProperty("tracking");
  });

  it("finds Tracking open on the same row on coming back from the row's run", async () => {
    const { router } = await openIntake("/intake?tracking=true");
    await userEvent.click(getRowButton(FINISHED_TASK));
    await userEvent.click(await screen.findByRole("button", { name: "Open the run" }));
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
    expect(readSelected()).toEqual([FINISHED_TASK.id]);
    expect(isPaneShown()).toBe(true);
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
  /** Opens opened Tracking with a Failed and a Working row, and returns how to fail the Working one. */
  const openWithMovableRow = async () => {
    let status: RunSummary["status"] = "running";
    const rows = () => [[FAILED_TASK, "failed"] as const, [WORKING_TASK, status] as const];
    const opened = await openIntake("/intake?tracking=true", {
      extra: storeTracking(rows(), { readRows: rows }),
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

  it("keeps its element and the focus, so the keys still reach Intake", async () => {
    const { failWorkingRow } = await openWithMovableRow();
    await userEvent.keyboard("jj");
    expect(readSelected()).toEqual([WORKING_TASK.id]);
    const before = getRowButton(WORKING_TASK);
    expect(document.activeElement).toBe(before);

    await failWorkingRow();

    // One flat list keeps the row's element, which moves under the Failed heading.
    const after = getRowButton(WORKING_TASK);
    // The cause comes with the read, so the row says it as soon as it fails.
    expect(after.textContent).toContain("Implement failed · step failed");
    expect(after).toBe(before);
    expect(document.activeElement).toBe(after);
    await userEvent.keyboard("k");
    expect(readSelected()).toEqual([FAILED_TASK.id]);
  });
});

describe("a selected row that leaves Tracking", () => {
  it("moves the selection and the focus on when another client takes the open row off while the pointer holds the rows", async () => {
    let rows: ReadonlyArray<readonly [Task, RunSummary["status"]]> = ROWS;
    const { live } = await openIntake("/intake?tracking=true", {
      extra: storeTracking(ROWS, { readRows: () => rows }),
    });
    await live.waitForFirstPushes();
    // The pointer is on the list column: the sheet keeps the rows it shows.
    await userEvent.hover(getList());
    await userEvent.keyboard("jj");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(getPane()!).getByRole("button", { name: "Mark done" }),
      );
    });

    rows = ROWS.filter(([task]) => task.id !== FINISHED_TASK.id);
    act(() => live.pushInvalidation("task"));

    // The pane follows the last read, so it moves to the next row at once. The sheet keeps the
    // row it draws until the pointer leaves.
    await waitFor(() => {
      expect(readSelected()).toEqual([WORKING_TASK.id]);
    });
    expect(readRowIds()).toContain(FINISHED_TASK.id);
    expect(within(getPane()!).getByRole("heading", { level: 2 }).textContent).toBe(
      WORKING_TASK.title,
    );
    expect(document.activeElement).not.toBe(document.body);

    // The keys reach Intake, and K walks past the row that is held but gone from the last read.
    await userEvent.keyboard("k");
    expect(readSelected()).toEqual([FAILED_TASK.id]);
    await userEvent.keyboard("{Escape}");
    expect(isPaneShown()).toBe(false);
    await userEvent.keyboard("{Escape}");
    expect(readSelected()).toEqual([]);
  });

  it("clears the selection when the last row leaves, and keeps the keys working", async () => {
    let rows: ReadonlyArray<readonly [Task, RunSummary["status"]]> = [[FAILED_TASK, "failed"]];
    const { live } = await openIntake("/intake?tracking=true", {
      extra: storeTracking(rows, { readRows: () => rows }),
    });
    await live.waitForFirstPushes();
    await userEvent.keyboard("j");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(document.activeElement).toBe(getPane()!.querySelector("article"));
    });

    rows = [];
    act(() => live.pushInvalidation("task"));
    await waitFor(() => {
      expect(readRowIds()).toEqual([]);
    });
    expect(getPane()).toBeNull();
    expect(document.activeElement).not.toBe(document.body);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(isOpen()).toBe(false);
    });
  });

  it("selects the next row when the push that takes the row off comes before the request's answer", async () => {
    const taken = new Set<string>();
    const held = holdAnswer();
    const { calls, live } = await openIntake("/intake?tracking=true", {
      extra: {
        ...storeTracking(ROWS, { readRows: () => ROWS.filter(([task]) => !taken.has(task.id)) }),
        [`PATCH /api/v1/tasks/${FINISHED_TASK.id}`]: () => {
          // The controller commits, announces it, and only then answers.
          taken.add(FINISHED_TASK.id);
          return held.handler();
        },
      },
    });
    await live.waitForFirstPushes();
    await userEvent.click(getRowButton(FINISHED_TASK));
    await userEvent.click(within(getPane()!).getByRole("button", { name: "Mark done" }));
    await waitFor(() => {
      expect(findMarkDone(calls)).toHaveLength(1);
    });

    act(() => live.pushInvalidation("task"));
    await waitFor(() => {
      expect(readRowIds()).toEqual([FAILED_TASK.id, WORKING_TASK.id, STOPPED_TASK.id]);
    });
    await waitFor(() => {
      expect(readSelected()).toEqual([WORKING_TASK.id]);
    });

    held.answer({ body: { ...FINISHED_TASK, status: "done" } });
    expect((await findToast()).textContent).toBe("Marked done: Rate-limit the public API");
    expect(readSelected()).toEqual([WORKING_TASK.id]);
    expect(document.activeElement).not.toBe(document.body);
  });
});

describe("a focused control that leaves its row", () => {
  it.each([false, true])(
    "moves the focus to the row's button when a re-run takes away its Mark done (opened: %s)",
    async (opened) => {
      let status: RunSummary["status"] = "completed";
      const readRows = () => [[FINISHED_TASK, status] as const];
      const { live } = await openIntake(opened ? "/intake?tracking=true" : "/intake", {
        extra: storeTracking(readRows(), { readRows }),
      });
      await live.waitForFirstPushes();
      const item = getRowButton(FINISHED_TASK).closest<HTMLElement>(".tr-run-item")!;
      const control = within(item).getByRole("button", { name: "Mark done" });
      act(() => {
        control.focus();
      });

      // The run starts again: the row is Working, which has no Mark done, and it keeps its element.
      status = "running";
      act(() => live.pushInvalidation("task"));
      await waitFor(() => {
        expect(
          getRowButton(FINISHED_TASK).closest(".tr-run-item")!.getAttribute("data-state"),
        ).toBe("working");
      });

      expect(control.isConnected).toBe(false);
      await waitFor(() => {
        expect(document.activeElement).toBe(getRowButton(FINISHED_TASK));
      });
      // The keys still reach Intake: Esc closes opened Tracking, and T opens folded Tracking.
      await userEvent.keyboard(opened ? "{Escape}" : "t");
      await waitFor(() => {
        expect(getTray().classList.contains("is-open")).toBe(!opened);
      });
    },
  );
});

describe("a focused row that another client takes off Tracking", () => {
  it.each([false, true])(
    "hands the focus to the list or the sheet, so the keys still reach Intake (opened: %s)",
    async (opened) => {
      let rows: ReadonlyArray<readonly [Task, RunSummary["status"]]> = ROWS;
      const { live } = await openIntake(opened ? "/intake?tracking=true" : "/intake", {
        extra: storeTracking(ROWS, { readRows: () => rows }),
      });
      await live.waitForFirstPushes();
      const focused = getRowButtons()[0]!;
      const taskId = focused.dataset.taskId!;
      act(() => {
        focused.focus();
      });

      rows = ROWS.filter(([task]) => task.id !== taskId);
      act(() => live.pushInvalidation("task"));
      await waitFor(() => {
        expect(getTray().querySelector(`[data-task-id="${taskId}"]`)).toBeNull();
      });

      await waitFor(() => {
        expect(document.activeElement).not.toBe(document.body);
      });
      await userEvent.keyboard(opened ? "{Escape}" : "t");
      await waitFor(() => {
        expect(getTray().classList.contains("is-open")).toBe(!opened);
      });
    },
  );
});

describe("handing a signal off while the pointer is on the list", () => {
  /** A signal that offers a Hand to answer binding `signal.handOff`. */
  const HANDOFF_SIGNAL: Signal = {
    ...FIRST_SIGNAL,
    actions: [
      {
        id: `hand-to-${WORKFLOW_ID}`,
        label: "Hand to Implement",
        operation: {
          op: "signal.handOff",
          input: { signalId: FIRST_SIGNAL.id, workflowId: WORKFLOW_ID },
        },
        describeLine: [{ kind: "text", text: "Starts Implement" }],
      },
    ],
  };

  it("shows the new row once a read that started after the handoff arrives, though the read lists ten later handoffs and not this one", async () => {
    // The Task has later handoffs from other signals only, as when ten of them pushed this one out.
    const LATE = Array.from({ length: 10 }, (_, index) => ({
      signalId: `01a06d02-7a00-7000-8000-${String(index + 900).padStart(12, "0")}`,
      runId: `01a06d02-7c00-7000-8000-${String(index + 900).padStart(12, "0")}`,
      at: at(30 + index),
    }));
    const NEW_TASK: Task = {
      ...buildTask("01a06d02-7b00-7000-8000-000000000009", "Retry failed webhooks", 40),
      provenance: LATE.map((entry) => ({ ...entry, actor: "user" as const })),
    };
    let handedOff = false;
    const readRows = () => (handedOff ? [...ROWS, [NEW_TASK, "running"] as const] : ROWS);
    const { live } = await openIntake(`/intake?signal=${FIRST_SIGNAL.id}`, {
      signals: [HANDOFF_SIGNAL, SECOND_SIGNAL],
      extra: {
        ...storeTracking(ROWS, { readRows }),
        [`GET /api/v1/signals/${FIRST_SIGNAL.id}`]: { body: HANDOFF_SIGNAL },
        [`POST /api/v1/signals/${FIRST_SIGNAL.id}/act`]: () => {
          handedOff = true;
          return {
            body: {
              ...HANDOFF_SIGNAL,
              status: "resolved",
              actions: [],
              resolution: {
                kind: "decided",
                actionId: `hand-to-${WORKFLOW_ID}`,
                outcome: "Handed to Implement",
                actor: "user",
                origin: "web",
                at: at(41),
              },
            },
          };
        },
      },
    });
    await live.waitForFirstPushes();
    // The pointer is on the list column: changes the user did not make wait.
    await userEvent.hover(getList());

    const pane = await screen.findByRole("region", { name: "The open signal" });
    await userEvent.click(await within(pane).findByRole("button", { name: "Hand to Implement" }));
    // The controller's push reads Tracking again, a read that starts after the handoff committed.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    act(() => live.pushInvalidation("task"));

    // Folded Tracking counts the rows it shows: the handoff's own read brings the fifth, though the
    // pointer is on the list and the read lists ten later handoffs and not this one.
    await waitFor(() => {
      expect(within(getTray()).getByRole("heading").textContent).toContain("Tracking5");
    });
  });
  it("shows the new row when the push's read finishes before the action's answer and no later push comes", async () => {
    const task: Task = {
      ...buildTask("01a06d02-7b00-7000-8000-000000000009", "Retry failed webhooks", 40),
      provenance: [],
    };
    let committed = false;
    let answerAction!: (answer: Answer) => void;
    const readRows = () => (committed ? [...ROWS, [task, "running"] as const] : ROWS);
    const { live, context } = await openIntake(`/intake?signal=${FIRST_SIGNAL.id}`, {
      signals: [HANDOFF_SIGNAL, SECOND_SIGNAL],
      extra: {
        ...storeTracking(ROWS, { readRows }),
        [`GET /api/v1/signals/${FIRST_SIGNAL.id}`]: { body: HANDOFF_SIGNAL },
        [`POST /api/v1/signals/${FIRST_SIGNAL.id}/act`]: () => {
          committed = true;
          return new Promise<Answer>((resolve) => {
            answerAction = resolve;
          });
        },
      },
    });
    await live.waitForFirstPushes();
    const pane = await screen.findByRole("region", { name: "The open signal" });
    const button = await within(pane).findByRole("button", { name: "Hand to Implement" });
    // The pointer stays on the list while the keyboard hands the signal off.
    act(() => {
      button.focus();
    });
    await userEvent.hover(getList());
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(committed).toBe(true);
    });

    // The commit's push reads Tracking before the action's answer arrives: five rows are cached, four shown.
    act(() => live.pushInvalidation("task"));
    await waitFor(() => {
      expect(context.queryClient.getQueryData<TrackingRead>(["tracking"])?.tasks).toHaveLength(5);
    });
    expect(within(getTray()).getByRole("heading").textContent).toContain("Tracking4");

    // The answer arrives, and no push follows. The hook reads again, and that read, which
    // changes no row, is the one that shows the handoff.
    await act(async () => {
      answerAction({
        body: {
          ...HANDOFF_SIGNAL,
          status: "resolved",
          actions: [],
          resolution: {
            kind: "decided",
            actionId: `hand-to-${WORKFLOW_ID}`,
            outcome: "Handed to Implement",
            actor: "user",
            origin: "web",
            at: at(41),
          },
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(within(getTray()).getByRole("heading").textContent).toContain("Tracking5");
    });
  });
});

describe("selecting a row", () => {
  it("shows the pane of a row on a click, with the row in the address", async () => {
    const { router } = await openIntake("/intake?tracking=true");
    await userEvent.click(getRowButton(FINISHED_TASK));

    expect(readSelected()).toEqual([FINISHED_TASK.id]);
    expect(router.latestLocation.search).toMatchObject({ tracking: true, task: FINISHED_TASK.id });
    const pane = getPane()!;
    expect(isPaneShown()).toBe(true);
    expect(within(pane).getByRole("heading", { level: 2 }).textContent).toBe(FINISHED_TASK.title);
    expect(within(pane).getByText("Finished")).toBeTruthy();
    expect(pane.textContent).toContain("Implement");
    expect(pane.textContent).toMatch(/Finished at .*\d\d:\d\d after 10m/);
    expect(screen.getByRole("button", { name: "Tracking pane" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("opens Tracking on the row when a row of folded Tracking is clicked", async () => {
    const { router } = await openIntake();
    await userEvent.click(getRowButton(STOPPED_TASK));

    expect(isOpen()).toBe(true);
    expect(router.latestLocation.pathname).toBe("/intake");
    expect(router.latestLocation.search).toMatchObject({ tracking: true, task: STOPPED_TASK.id });
    await waitFor(() => {
      expect(readSelected()).toEqual([STOPPED_TASK.id]);
    });
    expect(isPaneShown()).toBe(true);
  });

  it("takes the pane's toggle: it hides the pane and shows it again", async () => {
    await openIntake("/intake?tracking=true");
    await userEvent.click(getRowButton(FAILED_TASK));
    const toggle = screen.getByRole("button", { name: "Tracking pane" });
    await userEvent.click(toggle);
    expect(isPaneShown()).toBe(false);
    expect(readSelected()).toEqual([FAILED_TASK.id]);
    await userEvent.click(toggle);
    expect(isPaneShown()).toBe(true);
  });

  it("moves the focus to the suggested answer on ↩, and presses it on the second ↩", async () => {
    const { calls } = await openIntake("/intake?tracking=true");
    getRowButton(FINISHED_TASK).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(document.activeElement).toBe(
        within(getPane()!).getByRole("button", { name: "Mark done" }),
      );
    });
    expect(findMarkDone(calls)).toEqual([]);

    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(findMarkDone(calls).map((call) => [call.path, call.body])).toEqual([
        [`/api/v1/tasks/${FINISHED_TASK.id}`, { status: "done" }],
      ]);
    });
  });

  it("moves the focus to the pane on ↩ when no answer is suggested", async () => {
    await openIntake("/intake?tracking=true");
    getRowButton(FAILED_TASK).focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => {
      expect(document.activeElement).toBe(getPane()!.querySelector("article"));
    });
    expect(readSelected()).toEqual([FAILED_TASK.id]);
  });

  it("opens the selected row's run page from Open the run and from O", async () => {
    const { router } = await openIntake("/intake?tracking=true");
    await userEvent.click(getRowButton(STOPPED_TASK));
    await userEvent.click(within(getPane()!).getByRole("button", { name: "Open the run" }));
    await waitFor(() => {
      expect(router.latestLocation.pathname).toBe(`/runs/${getRunId(STOPPED_TASK)}`);
    });

    await router.navigate({ to: "/intake", search: { tracking: true, task: FAILED_TASK.id } });
    await screen.findByRole("heading", { level: 1, name: "Intake" });
    getRowButton(FAILED_TASK).focus();
    await userEvent.keyboard("o");
    await waitFor(() => {
      expect(router.latestLocation.pathname).toBe(`/runs/${getRunId(FAILED_TASK)}`);
    });
  });
});

/** The pull request whose checks failed, as the thread of the signal and the provenance of the Task name it. */
const PULL_REQUEST_REF = "github:pull:payments-api#1302";

/** Builds the open signal of the failed checks on the pull request. It is raised by GitHub. */
const CHECKS_SIGNAL: Signal = {
  ...buildSignal("01a06d02-7a00-7000-8000-000000000009", "Refund partial captures"),
  kind: "github/checks-failed",
  place: "payments-api #1302",
  origin: {
    type: "event",
    eventId: 9,
    connectionId: "01a06d02-7e00-7000-8000-000000000001",
    threadRef: PULL_REQUEST_REF,
  },
};

const LINEAR: PluginDetail = {
  ...GITHUB,
  id: "linear",
  displayName: "Linear",
  mark: { paths: ["M2 2h12v12H2z"] },
};

/** An open signal raised by Linear, so that GitHub's checks signal is not on Linear's tab. */
const LINEAR_SIGNAL: Signal = {
  ...buildSignal("01a06d02-7a00-7000-8000-00000000000a", "PAY-212 assigned to you"),
  kind: "linear/assigned",
};

/** Builds the live session of the run of `task` that asks to run `git push`. */
const buildRequestingSession = (task: Task): Session => ({
  ...SIDEBAR_FIXTURE.threads[0]!,
  id: "01a06d02-7400-7000-8000-0000000000aa",
  title: "Implement · code",
  status: "busy",
  runId: getRunId(task),
  stepId: "code",
  openRequests: [
    {
      requestId: "r-push",
      itemId: "tool-push",
      decisions: ["allow", "deny"],
      kind: "command_approval",
      detail: { command: "git push -u origin chore/stripe-sdk-14" },
    },
  ],
  lastActivityAt: at(30),
});

/** The Finished Task that the checks failing on its pull request make Needs you. */
const CHECKED_TASK = FINISHED_TASK;

/** Builds the Task of Your work that `task` is, about the signals `signalIds`, as `signal.queryYourWork` returns it. */
const buildWorkOf = (
  task: Task,
  signalIds: ReadonlyArray<string>,
  status: YourWorkTask["status"] = "in-progress",
): YourWorkTask => ({
  id: task.id,
  title: task.title,
  status,
  updatedAt: task.updatedAt,
  signalIds,
});

/**
 * Opens the app at `path` on the failed checks of the pull request: the open
 * signal `signals` lists, and `work`, the Tasks of Your work the controller
 * names for the signals on To do. Tracking holds `rows`, the Finished
 * `CHECKED_TASK` and the Working one unless the test says otherwise, and
 * `agentSessions` are the live sessions of runs.
 */
const openWithChecks = (
  path: string,
  {
    signals = [CHECKS_SIGNAL, SECOND_SIGNAL],
    plugins = [GITHUB],
    work = [buildWorkOf(CHECKED_TASK, [CHECKS_SIGNAL.id])] as ReadonlyArray<YourWorkTask>,
    rows = [
      [CHECKED_TASK, "completed"],
      [WORKING_TASK, "running"],
    ] as ReadonlyArray<readonly [Task, RunSummary["status"]]>,
    agentSessions = [] as ReadonlyArray<Session>,
  } = {},
) =>
  openIntake(path, {
    signals,
    plugins,
    agentSessions,
    extra: {
      ...storeTracking(rows),
      ...storeYourWork(signals, work),
      [`GET /api/v1/signals/${CHECKS_SIGNAL.id}`]: {
        body: signals.find((signal) => signal.id === CHECKS_SIGNAL.id) ?? CHECKS_SIGNAL,
      },
    },
  });

describe("a row that needs you", () => {
  it("leads Tracking, says what waits, counts in To do, offers Mark done while no run is live, and goes back when the signal is resolved", async () => {
    const signals = [CHECKS_SIGNAL];
    const { live } = await openWithChecks("/intake?tracking=true", { signals });
    await live.waitForFirstPushes();
    expect(readRowIds()).toEqual([CHECKED_TASK.id, WORKING_TASK.id]);
    expect(getRowButton(CHECKED_TASK).textContent).toContain("Checks failed on payments-api #1302");
    expect(getTray().querySelector("h3")?.textContent).toBe("Needs you1");
    // Its agent finished, so the row can be marked done even though the signal waits.
    expect(
      within(getRowButton(CHECKED_TASK).closest<HTMLElement>(".tr-run-item")!).queryByRole(
        "button",
        { name: "Mark done" },
      ),
    ).not.toBeNull();
    // The signal itself and the row it makes Needs you.
    expect(screen.getByRole("tab", { name: "Hercule, 2 to do" })).toBeTruthy();

    signals.length = 0;
    act(() => live.pushInvalidation("signal"));
    await waitFor(() => {
      expect(getRowButton(CHECKED_TASK).textContent).not.toContain("Checks failed");
    });
    expect(getRowButton(CHECKED_TASK).textContent).toContain("finished");
    // The row still waits on the user as a Finished one, so only the signal drops out of the count.
    expect(screen.getByRole("tab", { name: "Hercule, 1 to do" })).toBeTruthy();
  });

  it("marks the row done on E when no run of its Task is live", async () => {
    const { calls } = await openWithChecks("/intake?tracking=true");
    await userEvent.keyboard("j");
    expect(readSelected()).toEqual([CHECKED_TASK.id]);
    await userEvent.keyboard("e");
    await waitFor(() => {
      expect(findMarkDone(calls).map((call) => [call.path, call.body])).toEqual([
        [`/api/v1/tasks/${CHECKED_TASK.id}`, { status: "done" }],
      ]);
    });
  });

  describe("on a session whose Request waits", () => {
    const agentSessions = [buildRequestingSession(WORKING_TASK)];

    it("says what the Request asks, counts in To do, and offers only Stop the run in its pane", async () => {
      await openWithChecks("/intake?tracking=true", {
        signals: [],
        rows: [[WORKING_TASK, "running"]],
        agentSessions,
      });
      expect(getRowButton(WORKING_TASK).textContent).toContain(
        "Run git push -u origin chore/stripe-sdk-14?",
      );
      expect(screen.getByRole("tab", { name: "Hercule, 1 to do" })).toBeTruthy();
      await userEvent.click(getRowButton(WORKING_TASK));
      expect(
        [...getPane()!.querySelectorAll<HTMLElement>("[data-answer]")].map(
          (button) => button.dataset.answer,
        ),
      ).toEqual(["stop-run"]);
    });

    it("does nothing on E, because the run of the Request is live", async () => {
      const { calls } = await openWithChecks("/intake?tracking=true", {
        signals: [],
        rows: [[WORKING_TASK, "running"]],
        agentSessions,
      });
      await userEvent.keyboard("j");
      expect(readSelected()).toEqual([WORKING_TASK.id]);
      await userEvent.keyboard("e");
      await userEvent.keyboard("{Escape}{Escape}");
      getRowButton(WORKING_TASK).focus();
      await userEvent.keyboard("e");
      expect(findMarkDone(calls)).toEqual([]);
    });

    it("turns the row Working again once the Request is answered", async () => {
      const answering = [...agentSessions];
      const { live } = await openWithChecks("/intake?tracking=true", {
        signals: [],
        rows: [[WORKING_TASK, "running"]],
        agentSessions: answering,
      });
      await live.waitForFirstPushes();
      expect(getRowButton(WORKING_TASK).textContent).toContain("Run git push");

      answering[0] = { ...answering[0]!, openRequests: [] };
      act(() => live.pushInvalidation("session", [answering[0]!.id]));
      await waitFor(() => {
        expect(getRowButton(WORKING_TASK).textContent).not.toContain("Run git push");
      });
      expect(getRowButton(WORKING_TASK).textContent).toContain("working");
      expect(screen.queryByRole("tab", { name: /^Hercule, \d+ to do$/ })).toBeNull();
    });
  });

  it("opens the signal in To do with Tracking closed, from a tab the signal is not on", async () => {
    const { router } = await openWithChecks("/intake", {
      signals: [CHECKS_SIGNAL, LINEAR_SIGNAL],
      plugins: [GITHUB, LINEAR],
    });
    await userEvent.click(screen.getByRole("button", { name: /^Linear/ }));
    // The checks signal is raised by GitHub, so it is not listed on Linear's tab.
    expect(getSignalRow(CHECKS_SIGNAL)).toBeNull();
    await userEvent.click(getRowButton(CHECKED_TASK));
    await userEvent.click(within(getPane()!).getByRole("button", { name: "Open the signal" }));

    await waitFor(() => {
      expect(router.latestLocation.search).toMatchObject({ signal: CHECKS_SIGNAL.id });
    });
    expect(router.latestLocation.search).not.toHaveProperty("tracking", true);
    expect(router.latestLocation.search).not.toHaveProperty("task");
    expect(isOpen()).toBe(false);
    expect(screen.getByRole("button", { name: /^All/ }).getAttribute("aria-pressed")).toBe("true");
    expect(getSignalRow(CHECKS_SIGNAL).getAttribute("aria-current")).toBe("true");
  });

  it("opens the thread of the session whose Request waits", async () => {
    const { router } = await openWithChecks("/intake?tracking=true", {
      signals: [],
      rows: [[WORKING_TASK, "running"]],
      agentSessions: [buildRequestingSession(WORKING_TASK)],
    });
    await userEvent.click(getRowButton(WORKING_TASK));
    const question = await within(getPane()!).findByText(
      "Run git push -u origin chore/stripe-sdk-14?",
    );
    expect(question.closest(".tr-ask")).not.toBeNull();
    await userEvent.click(within(getPane()!).getByRole("button", { name: "Open the thread" }));

    await waitFor(() => {
      expect(router.latestLocation.pathname).toBe("/threads/01a06d02-7400-7000-8000-0000000000aa");
    });
  });
});

/** Waits for the first block of Your work in the open signal's pane, and returns it. */
const findYourWorkBlock = () =>
  waitFor(() => {
    const found = document.querySelector<HTMLElement>(".ad-blocks--work .b-work");
    expect(found).not.toBeNull();
    return found!;
  });

describe("Your work on a signal", () => {
  /** An open Task on the same pull request that no agent was handed. */
  const UNTRACKED_TASK = buildWorkOf(
    buildTask("01a06d02-7b00-7000-8000-0000000000f1", "Document the refund flow", 40),
    [CHECKS_SIGNAL.id],
    "open",
  );

  it("leads a signal's row with the agent's face, and moves the source's mark to its second line", async () => {
    await openWithChecks("/intake");
    const withWork = getSignalRow(CHECKS_SIGNAL);
    expect(withWork.querySelector(".ask-mark--face .cr")).not.toBeNull();
    expect(withWork.querySelector(".ask-sub .ask-src svg")).not.toBeNull();
    const without = getSignalRow(SECOND_SIGNAL);
    expect(without.querySelector(".cr")).toBeNull();
    expect(without.querySelector(".ask-src")).toBeNull();
  });

  it("shows a Now row's Task in place of who asks", async () => {
    await openWithChecks("/intake", {
      signals: [{ ...CHECKS_SIGNAL, priority: "urgent" }, SECOND_SIGNAL],
    });
    expect(getSignalRow(CHECKS_SIGNAL).querySelector(".ask-sub")?.textContent).toBe(
      `Your work: ${CHECKED_TASK.title} · checks failed · payments-api #1302`,
    );
  });

  it("draws a tracked Task in the pane with its state, and Show in Tracking opens Tracking on its row", async () => {
    const { router } = await openWithChecks("/intake");
    await userEvent.click(getSignalRow(CHECKS_SIGNAL));
    const block = await findYourWorkBlock();
    expect(block.textContent).toContain("Your work");
    expect(block.textContent).toContain(CHECKED_TASK.title);
    expect(block.textContent).toContain("In Tracking · needs you");
    expect(block.querySelector(".b-work-text b + span b")?.textContent).toBe("needs you");
    await userEvent.click(within(block).getByRole("button", { name: "Show in Tracking" }));
    await waitFor(() => {
      expect(isOpen()).toBe(true);
    });
    expect(router.latestLocation.search).not.toHaveProperty("signal");
    expect(readSelected()).toEqual([CHECKED_TASK.id]);
  });

  it("draws an open Task nobody was handed with its status and no way into Tracking", async () => {
    await openWithChecks("/intake", { work: [UNTRACKED_TASK] });
    await userEvent.click(getSignalRow(CHECKS_SIGNAL));
    const block = await findYourWorkBlock();
    expect(block.textContent).toBe("Your workDocument the refund flowOpen");
    expect(within(block).queryByRole("button")).toBeNull();
    // Nobody was handed the Task, so the signal's row keeps its source's mark.
    expect(getSignalRow(CHECKS_SIGNAL).querySelector(".cr")).toBeNull();
  });

  const findYourWorkReads = (calls: ReadonlyArray<Call>) =>
    calls.filter((call) => call.method === "GET" && call.path === "/api/v1/signals/your-work");

  it("reads Your work in one request whatever the number of signals, and again on a signal or task push, never on a run push", async () => {
    const signals = [0, 1, 2].map((index): Signal => ({
      ...CHECKS_SIGNAL,
      id: `01a06d02-7a00-7000-8000-0000000000b${String(index)}`,
      title: `Checks on pull request ${String(index)}`,
    }));
    const tasks = signals.map((_, index) =>
      buildTask(`01a06d02-7b00-7000-8000-0000000000b${String(index)}`, `Task ${String(index)}`, 3),
    );
    const work = tasks.map((task, index) => buildWorkOf(task, [signals[index]!.id]));
    const { calls, live } = await openIntake("/intake?tracking=true", {
      signals,
      extra: {
        ...storeTracking(tasks.map((task) => [task, "running"] as const)),
        ...storeYourWork(signals, work),
      },
    });
    await live.waitForFirstPushes();
    await waitFor(() => {
      expect(readRowIds()).toHaveLength(3);
    });

    // The shell's load reads it once, and the first push of each of the two topics reads it again at most.
    const loaded = findYourWorkReads(calls).length;
    expect(loaded).toBeGreaterThanOrEqual(1);
    expect(loaded).toBeLessThanOrEqual(3);

    act(() => live.pushInvalidation("signal", [signals[0]!.id]));
    await waitFor(() => {
      expect(findYourWorkReads(calls)).toHaveLength(loaded + 1);
    });
    act(() => live.pushInvalidation("task", [tasks[0]!.id]));
    await waitFor(() => {
      expect(findYourWorkReads(calls)).toHaveLength(loaded + 2);
    });

    // A run push cannot change which Tasks belong to a signal.
    act(() => live.pushInvalidation("run", [getRunId(tasks[0]!)]));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(findYourWorkReads(calls)).toHaveLength(loaded + 2);
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

  it("sends two take-offs side by side, one per Task, and takes both rows off", async () => {
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

  it("does not take a row off that is Working in the last read, though it is still drawn Finished", async () => {
    let status: RunSummary["status"] = "completed";
    const { calls, live } = await openIntake("/intake?tracking=true", {
      extra: storeTracking([[FINISHED_TASK, "completed"]], {
        readRows: () => [[FINISHED_TASK, status]],
      }),
    });
    await live.waitForFirstPushes();
    const reads = findTrackingReads(calls).length;
    // While the pointer is on the list column, a change the user did not make waits.
    await userEvent.hover(getList());
    status = "running";
    act(() => live.pushInvalidation("run", [getRunId(FINISHED_TASK)]));
    await waitFor(() => {
      expect(findTrackingReads(calls).length).toBeGreaterThan(reads);
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

  /** A signal that offers Done, which E on a signal would mark done. */
  const SIGNAL_WITH_DONE: Signal = {
    ...FIRST_SIGNAL,
    actions: [
      {
        id: "done",
        label: "Done",
        operation: null,
        describeLine: [{ kind: "text", text: "Marks it done" }],
      },
    ],
  };

  it("marks the row of a folded Mark done control done with E, and moves no signal", async () => {
    const { calls } = await openIntake(`/intake?signal=${FIRST_SIGNAL.id}`, {
      signals: [SIGNAL_WITH_DONE, SECOND_SIGNAL],
      extra: {
        ...storeTracking(),
        "POST /api/v1/signals/mark-done": { body: { done: [FIRST_SIGNAL.id], skipped: [] } },
      },
    });
    const control = within(
      getRowButton(STOPPED_TASK).closest<HTMLElement>(".tr-run-item")!,
    ).getByRole("button", { name: "Mark done" });
    control.focus();
    await userEvent.keyboard("e");
    await waitFor(() => {
      expect(findMarkDone(calls).map((call) => call.path)).toEqual([
        `/api/v1/tasks/${STOPPED_TASK.id}`,
      ]);
    });
    expect(calls.some((call) => call.path === "/api/v1/signals/mark-done")).toBe(false);
  });

  it("moves no signal with X, H or U while the focus is on a row of folded Tracking", async () => {
    const { calls } = await openIntake(`/intake?signal=${FIRST_SIGNAL.id}`, {
      signals: [SIGNAL_WITH_DONE, SECOND_SIGNAL],
    });
    const control = within(
      getRowButton(STOPPED_TASK).closest<HTMLElement>(".tr-run-item")!,
    ).getByRole("button", { name: "Mark done" });
    control.focus();
    await userEvent.keyboard("xhu");
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(
      calls
        .filter((call) => call.method !== "GET" && call.path.startsWith("/api/v1/signals"))
        .map((call) => `${call.method} ${call.path}`),
    ).toEqual([]);
    expect(document.querySelector(".asks-bulk")).toBeNull();
  });

  it("marks the row with the focus done in opened Tracking, not the selected row", async () => {
    const { calls } = await openIntake("/intake?tracking=true");
    await userEvent.keyboard("j");
    expect(readSelected()).toEqual([FAILED_TASK.id]);
    const control = within(
      getRowButton(STOPPED_TASK).closest<HTMLElement>(".tr-run-item")!,
    ).getByRole("button", { name: "Mark done" });
    control.focus();
    await userEvent.keyboard("e");
    await waitFor(() => {
      expect(findMarkDone(calls).map((call) => call.path)).toEqual([
        `/api/v1/tasks/${STOPPED_TASK.id}`,
      ]);
    });
  });

  describe("with motion", () => {
    // With motion on, the list draws the row that leaves for one more render
    // before it goes, which jsdom shows only when the durations are not 0.
    beforeEach(() => {
      document.documentElement.style.setProperty("--dur-1", "120ms");
      document.documentElement.style.setProperty("--dur-2", "200ms");
      document.documentElement.style.setProperty("--dur-3", "320ms");
      animations.length = 0;
      Object.defineProperty(Element.prototype, "animate", {
        value: function (this: Element) {
          const animation = new FakeAnimation(this);
          animations.push(animation);
          return animation;
        },
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

    /** Opens Tracking with T, from the focus on a signal's row, and returns the sheet. */
    const openWithT = async (): Promise<HTMLElement> => {
      await userEvent.keyboard("t");
      return document.querySelector<HTMLElement>(".asks-list > .tr-tray.is-open:not([inert])")!;
    };

    it("drops the sheet itself, inert, while the list and folded Tracking are in use, and removes it when the drop ends", async () => {
      await openIntake();
      getSignalRow(FIRST_SIGNAL).focus();
      const sheet = await openWithT();
      await userEvent.keyboard("t");

      expect(sheet.isConnected).toBe(true);
      expect(sheet.hasAttribute("inert")).toBe(true);
      expect(document.querySelector(".asks-frame")!.hasAttribute("inert")).toBe(false);
      expect(getTray().classList.contains("is-open")).toBe(false);
      const drop = findSheetAnimation()!;
      await finishAnimation(drop);
      await waitFor(() => {
        expect(sheet.isConnected).toBe(false);
      });
      // Nothing is kept: the drop is cancelled, and no copy of the sheet is anywhere.
      expect(drop.cancelled).toBe(true);
      expect(document.querySelectorAll(".tr-tray.is-open")).toHaveLength(0);
      expect(document.querySelector(".tr-fly")!.children).toHaveLength(0);
    });

    it("turns the drop around when T opens Tracking again, and keeps the one sheet", async () => {
      await openIntake();
      getSignalRow(FIRST_SIGNAL).focus();
      const sheet = await openWithT();
      await userEvent.keyboard("t");
      const drop = findSheetAnimation()!;
      await userEvent.keyboard("t");

      expect(drop.reversed).toBe(1);
      expect(sheet.hasAttribute("inert")).toBe(false);
      await finishAnimation(drop);
      await waitFor(() => {
        expect(drop.cancelled).toBe(true);
      });
      expect(sheet.isConnected).toBe(true);
      expect(document.querySelectorAll(".tr-tray.is-open")).toHaveLength(1);
      expect(getTray()).toBe(sheet);
    });

    it("ends in the state of the last of rapid T presses, with no sheet left over", async () => {
      await openIntake();
      getSignalRow(FIRST_SIGNAL).focus();
      await userEvent.keyboard("tttt");
      for (const animation of [...animations]) {
        await finishAnimation(animation);
      }
      await waitFor(() => {
        expect(document.querySelectorAll(".tr-tray.is-open")).toHaveLength(0);
      });
      expect(isOpen()).toBe(false);
      expect(getList().contains(document.activeElement)).toBe(true);

      await userEvent.keyboard("ttt");
      for (const animation of [...animations]) {
        await finishAnimation(animation);
      }
      await waitFor(() => {
        expect(document.querySelectorAll(".tr-tray.is-open")).toHaveLength(1);
      });
      expect(getTray().hasAttribute("inert")).toBe(false);
      expect(isOpen()).toBe(true);
    });

    it("gives the focus back to the sheet when T opens Tracking again during the drop: J and Enter work", async () => {
      const { router } = await openIntake();
      getSignalRow(FIRST_SIGNAL).focus();
      await userEvent.keyboard("ttt");
      expect(getTray().contains(document.activeElement)).toBe(true);

      await userEvent.keyboard("j");
      const selected = getRowButtons().find((row) => row.getAttribute("aria-current") === "true");
      expect(selected).toBeDefined();
      expect(document.activeElement).toBe(selected);
      await userEvent.keyboard("{Enter}");
      // Enter on the focused row selects it and takes the focus into its pane.
      await waitFor(() => {
        expect(getPane()!.contains(document.activeElement)).toBe(true);
      });
      expect(router.latestLocation.search).toMatchObject({ task: selected!.dataset.taskId });
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

  it("shows a failed take-off in the toast's place, and the row stays", async () => {
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

describe("the pane's answers", () => {
  /** The run `run.cancel` returns for the Working row's run, as the controller returns it once cancelled. */
  const CANCELLED_RUN: Run = {
    id: getRunId(WORKING_TASK),
    workflowId: WORKFLOW_ID,
    plan: { name: "Implement", inputs: [], triggers: [], steps: [], edges: [] },
    inputs: {},
    origin: { kind: "manual", actor: "user" },
    runnerId: "01a06d02-7f00-7000-8000-000000000001",
    workspaceId: "01a06d02-7f00-7000-8000-000000000002",
    subscriptions: [],
    createdAt: at(10),
    status: "cancelled",
    finishedAt: at(25),
    steps: [],
    edgeTraversals: [],
  };
  const stopPath = `/api/v1/runs/${getRunId(WORKING_TASK)}/cancel`;
  const findStops = (calls: ReadonlyArray<Call>) =>
    calls.filter((call) => call.method === "POST" && call.path === stopPath);

  it("marks the row done from Mark done, shows the toast, and selects the next row", async () => {
    const { calls } = await openIntake("/intake?tracking=true");
    await userEvent.click(getRowButton(FINISHED_TASK));
    await userEvent.click(within(getPane()!).getByRole("button", { name: "Mark done" }));

    await waitFor(() => {
      expect(findMarkDone(calls).map((call) => [call.path, call.body])).toEqual([
        [`/api/v1/tasks/${FINISHED_TASK.id}`, { status: "done" }],
      ]);
    });
    expect((await findToast()).textContent).toBe("Marked done: Rate-limit the public API");
    await waitFor(() => {
      expect(readSelected()).toEqual([WORKING_TASK.id]);
    });
    expect(within(getPane()!).getByRole("heading", { level: 2 }).textContent).toBe(
      WORKING_TASK.title,
    );
    // The keys still reach Intake: the focus did not fall to the page's body.
    expect(document.activeElement).not.toBe(document.body);
  });

  it("cancels the row from Cancel, and says so", async () => {
    const { calls } = await openIntake("/intake?tracking=true");
    await userEvent.click(getRowButton(FAILED_TASK));
    await userEvent.click(within(getPane()!).getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(findMarkDone(calls).map((call) => [call.path, call.body])).toEqual([
        [`/api/v1/tasks/${FAILED_TASK.id}`, { status: "cancelled" }],
      ]);
    });
    expect((await findToast()).textContent).toBe("Cancelled: Nightly backup job timing out");
    await waitFor(() => {
      expect(getRowButton(FAILED_TASK)).toBeNull();
    });
  });

  it("stops the run from Stop the run, keeping its workspace, with no confirmation and no toast", async () => {
    const { calls } = await openIntake("/intake?tracking=true", {
      extra: { ...storeTracking(), [`POST ${stopPath}`]: { body: CANCELLED_RUN } },
    });
    await userEvent.click(getRowButton(WORKING_TASK));
    expect(getPane()!.querySelector(".ans-desc")?.textContent).toBe(
      "Stops Implement. The row stays in Tracking, as Stopped",
    );
    await userEvent.click(within(getPane()!).getByRole("button", { name: "Stop the run" }));

    await waitFor(() => {
      expect(findStops(calls).map((call) => call.body)).toEqual([{ keepWorkspace: true }]);
    });
    expect(document.querySelector(".asks-toast")).toBeNull();
    expect(document.querySelector("dialog[open]")).toBeNull();
  });

  it("shows a refused stop under its button, and leaves the row as it was", async () => {
    await openIntake("/intake?tracking=true", {
      extra: {
        ...storeTracking(),
        [`POST ${stopPath}`]: {
          status: 409,
          body: buildErrorBody("invalid_state", "The run has already ended."),
        },
      },
    });
    await userEvent.click(getRowButton(WORKING_TASK));
    await userEvent.click(within(getPane()!).getByRole("button", { name: "Stop the run" }));

    const failure = await within(getPane()!).findByRole("alert");
    expect(failure.textContent).toBe("The run has already ended.");
    expect(failure.previousElementSibling?.getAttribute("data-answer")).toBe("stop-run");
    expect(document.querySelector(".asks-toast")).toBeNull();
  });
});

describe("the pane's trip", () => {
  /** What a Review PR run put out: a verdict, a count of findings and a flag, as its output schema titles them. */
  const REVIEW_OUTPUT: TrackingDetail["output"] = {
    kind: "fields",
    stepName: "Review",
    sessionId: getSessionId(FINISHED_TASK),
    fields: [
      { label: "Verdict", value: "Approve with comments" },
      { label: "Findings", value: { items: 3 } },
      { label: "Ready to merge", value: true },
    ],
  };

  it("shows a Finished review: the request under You asked, the run, and the output as fields", async () => {
    const { router } = await openIntake("/intake?tracking=true", {
      extra: storeTracking(ROWS, {
        buildRun: (task, status) => buildRunSummary(task, status, "Review PR"),
        buildExtra: (task) =>
          task.id === FINISHED_TASK.id
            ? { output: REVIEW_OUTPUT, endingActionStepName: "Post the review" }
            : {},
      }),
    });
    await userEvent.click(getRowButton(FINISHED_TASK));

    const pane = getPane()!;
    const asked = await waitFor(() => {
      const found = pane.querySelector<HTMLElement>(".tr-msg--you");
      expect(found?.querySelector(".tr-orig-q")).not.toBeNull();
      return found!;
    });
    expect(within(asked).getByText("You asked")).toBeTruthy();
    expect(asked.querySelector(".tr-orig-h")?.textContent).toBe(
      "Marta· review requested · acme/webshop#1296",
    );
    expect(asked.querySelector(".tr-orig-q")?.textContent).toBe(
      "Could you review the RateLimiter before Friday?",
    );

    const did = pane.querySelector<HTMLElement>(".tr-msg--did")!;
    expect(did.querySelector(".tr-name")?.textContent).toMatch(
      /^Review PR finished (\d+ \w+ )?\d\d:\d\d$/,
    );
    expect(did.querySelector(".tr-out-from")?.textContent).toBe("From the step Review");
    expect(
      [...did.querySelectorAll(".tr-out > div")].map((field) => [
        field.querySelector("dt")?.textContent,
        field.querySelector("dd")?.textContent,
      ]),
    ).toEqual([
      ["Verdict", "Approve with comments"],
      ["Findings", "3 items"],
      ["Ready to merge", "yes"],
    ]);
    // One run that has ended: the name line already says when and how it ended.
    expect(did.querySelector(".tr-steps")).toBeNull();
    expect(did.querySelector(".tr-out-action")?.textContent).toBe("Post the review");

    await userEvent.click(
      within(did).getByRole("button", { name: "See the whole output in the run" }),
    );
    await waitFor(() => {
      expect(router.latestLocation.pathname).toBe(`/runs/${getRunId(FINISHED_TASK)}`);
    });
  });

  it("names the workflow the first handoff went to, not the newest run's", async () => {
    await openIntake("/intake?tracking=true", {
      extra: storeTracking(ROWS, {
        buildExtra: (task, run) => ({
          firstHandoff: { ...buildTrackingTask(task, run).handoffs[0]!, workflowName: "Triage" },
        }),
      }),
    });
    await userEvent.click(getRowButton(FINISHED_TASK));

    await waitFor(() => {
      expect(getPane()!.querySelector(".tr-msg--you small")?.textContent).toMatch(
        /handed to Triage$/,
      );
    });
  });

  it("leads a Failed row with why it failed, and marks it done", async () => {
    const { calls } = await openIntake("/intake?tracking=true");
    await userEvent.click(getRowButton(FAILED_TASK));

    const reason = await waitFor(() => {
      const found = getPane()!.querySelector<HTMLElement>(".tr-msg--did .tr-fail");
      expect(found).not.toBeNull();
      return found!;
    });
    expect(reason.textContent).toBe("permission denied on ops-db");
    // The reason is the first thing the agent says.
    expect(reason.previousElementSibling?.classList.contains("tr-name")).toBe(true);
    expect(getPane()!.querySelector(".tr-steps")).toBeNull();

    await userEvent.click(within(getPane()!).getByRole("button", { name: "Mark done" }));
    await waitFor(() => {
      expect(findMarkDone(calls).map((call) => [call.path, call.body])).toEqual([
        [`/api/v1/tasks/${FAILED_TASK.id}`, { status: "done" }],
      ]);
    });
  });

  it("follows the run live: its end draws the output in the open pane", async () => {
    let status: RunSummary["status"] = "running";
    const rows = () => [[WORKING_TASK, status] as const];
    const { live } = await openIntake("/intake?tracking=true", {
      extra: storeTracking(rows(), {
        readRows: rows,
        buildExtra: (task, run) =>
          run.status === "completed"
            ? {
                output: {
                  kind: "text",
                  stepName: "Code",
                  sessionId: getSessionId(task),
                  text: "Lowercased the SKUs in the search index.",
                },
              }
            : {},
      }),
    });
    await live.waitForFirstPushes();
    await userEvent.click(getRowButton(WORKING_TASK));
    await waitFor(() => {
      expect(getPane()!.querySelector(".tr-steps li")?.textContent).toContain("Implement working");
    });
    // A Working row has done nothing yet.
    expect(getPane()!.querySelector(".tr-out-from")).toBeNull();

    status = "completed";
    act(() => live.pushInvalidation("run", [getRunId(WORKING_TASK)]));

    await waitFor(() => {
      expect(getPane()!.querySelector(".tr-out-from")?.textContent).toBe("From the step Code");
    });
    expect(getPane()!.querySelector(".tr-did")?.textContent).toBe(
      "Lowercased the SKUs in the search index.",
    );
    expect(getPane()!.querySelector(".ad-kind")?.textContent).toContain("Finished");
    // The run has ended and is the Task's only one, so the list of runs goes.
    expect(getPane()!.querySelector(".tr-steps")).toBeNull();
  });

  const EARLIER_RUN_ID = "01a06d02-7c00-7000-8000-0000000000f1";
  const EARLIER_SESSION_ID = "01a06d02-7400-7000-8000-0000000000f1";

  it("lists both runs of a Task that was run again, each with its links", async () => {
    const { router } = await openIntake("/intake?tracking=true", {
      extra: storeTracking(ROWS, {
        buildExtra: (task, run) =>
          task.id === FAILED_TASK.id
            ? {
                runs: [
                  {
                    ...buildTrackingRun(run),
                    id: EARLIER_RUN_ID,
                    failureCause: "step failed",
                    sessionId: EARLIER_SESSION_ID,
                  },
                  { ...buildTrackingRun(run), sessionId: getSessionId(task) },
                ],
              }
            : {},
      }),
    });
    await userEvent.click(getRowButton(FAILED_TASK));

    const lines = await waitFor(() => {
      const found = [...getPane()!.querySelectorAll(".tr-steps li")];
      expect(found).toHaveLength(2);
      return found;
    });
    expect(lines.map((line) => line.querySelector(".tr-step-line")?.textContent)).toEqual([
      "Implement failed: step failed",
      "Implement failed: permission denied on ops-db",
    ]);
    expect(lines.map((line) => line.querySelector(".tr-step-thread")?.textContent)).toEqual([
      "Thread",
      "Thread",
    ]);

    await userEvent.click(
      within(lines[0] as HTMLElement).getByRole("button", { name: "Implement" }),
    );
    await waitFor(() => {
      expect(router.latestLocation.pathname).toBe(`/runs/${EARLIER_RUN_ID}`);
    });
  });

  it("shows the error of a read that fails after the trip was drawn, in place of the old trip", async () => {
    let answering = true;
    const { live } = await openIntake("/intake?tracking=true", {
      extra: {
        ...storeTracking(),
        [`GET /api/v1/tasks/${FINISHED_TASK.id}/tracking`]: () =>
          answering
            ? {
                body: buildTrackingDetail(
                  FINISHED_TASK,
                  buildRunSummary(FINISHED_TASK, "completed"),
                ),
              }
            : { status: 404, body: buildErrorBody("not_found", "The Task was not found.") },
      },
    });
    await live.waitForFirstPushes();
    await userEvent.click(getRowButton(FINISHED_TASK));
    await waitFor(() => {
      expect(getPane()!.querySelector(".tr-orig-q")).not.toBeNull();
    });

    answering = false;
    act(() => live.pushInvalidation("task", [FINISHED_TASK.id]));

    const failure = await within(getPane()!).findByRole("alert");
    expect(failure.textContent).toBe("The Task was not found.");
    expect(getPane()!.querySelector(".tr-trip")).toBeNull();
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
    const { live } = await openIntake("/intake", {
      extra: storeTracking([[WORKING_TASK, "running"]], {
        readRows: () => [[WORKING_TASK, status]],
      }),
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
  it("is one request, task.queryTracking, whatever the number of Tasks, with no read of Tasks or runs beside it", async () => {
    const many = Array.from({ length: 200 }, (_, index) =>
      buildTask(
        `01a06d02-7b00-7000-8000-${String(index + 100).padStart(12, "0")}`,
        `Task ${String(index)}`,
        index,
      ),
    );
    const { calls, live } = await openIntake("/intake", {
      extra: storeTracking(many.map((task) => [task, "completed"] as const)),
    });
    await live.waitForFirstPushes();
    expect(findTrackingReads(calls).length).toBeGreaterThan(0);
    expect(
      calls.filter(
        (call) =>
          call.method === "GET" && (call.path === "/api/v1/runs" || call.path === "/api/v1/tasks"),
      ),
    ).toHaveLength(0);
  });

  it("reads again on a task push", async () => {
    const { calls, live } = await openIntake();
    await live.waitForFirstPushes();
    const before = findTrackingReads(calls).length;
    act(() => live.pushInvalidation("task", [WORKING_TASK.id]));
    await waitFor(() => {
      expect(findTrackingReads(calls)).toHaveLength(before + 1);
    });
  });

  it("reads again once on a run push that names a row's newest run, and on one that names its newest live run", async () => {
    const { calls, live } = await openIntake();
    await live.waitForFirstPushes();
    const before = findTrackingReads(calls).length;
    act(() => live.pushInvalidation("run", [getRunId(WORKING_TASK)]));
    await waitFor(() => {
      expect(findTrackingReads(calls)).toHaveLength(before + 1);
    });
  });

  it("reads again on the creation of a run, which may be a re-run, and on a push that names no run", async () => {
    const { calls, live } = await openIntake();
    await live.waitForFirstPushes();
    const before = findTrackingReads(calls).length;
    act(() =>
      live.pushInvalidation("run", ["01a06d02-7c00-7000-8000-0000000000ff"], undefined, "created"),
    );
    await waitFor(() => {
      expect(findTrackingReads(calls)).toHaveLength(before + 1);
    });
    act(() => live.pushInvalidation("run"));
    await waitFor(() => {
      expect(findTrackingReads(calls)).toHaveLength(before + 2);
    });
  });

  it("does not read again on a change to a run no row holds", async () => {
    const { calls, live } = await openIntake();
    await live.waitForFirstPushes();
    const before = findTrackingReads(calls).length;
    act(() => live.pushInvalidation("run", ["01a06d02-7c00-7000-8000-0000000000fe"]));
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(findTrackingReads(calls)).toHaveLength(before);
  });

  it("reads no pane's Task while the pane is hidden, whatever rows J walks over", async () => {
    const { calls, live } = await openIntake("/intake?tracking=true");
    // The controller's first push on each topic reads everything again, and it is not what this test counts.
    await live.waitForFirstPushes();
    const countDetailReads = () =>
      calls.filter(
        (call) => call.method === "GET" && /^\/api\/v1\/tasks\/[^/]+\/tracking$/.test(call.path),
      ).length;
    await userEvent.click(getRowButton(FAILED_TASK));
    await waitFor(() => {
      expect(countDetailReads()).toBe(1);
    });

    await userEvent.keyboard("{Escape}");
    expect(isPaneShown()).toBe(false);
    await userEvent.keyboard("jjj");
    expect(readSelected()).toEqual([STOPPED_TASK.id]);
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(countDetailReads()).toBe(1);
  });

  it("reads a pane's Task and handoff signal once when it opens, and again only for a push that can change it", async () => {
    const { calls, live } = await openIntake("/intake?tracking=true");
    await live.waitForFirstPushes();
    const countReads = (path: string) =>
      calls.filter((call) => call.method === "GET" && call.path === path).length;
    const countDetailReads = (task: Task) => countReads(`/api/v1/tasks/${task.id}/tracking`);
    const countSignalReads = (task: Task) =>
      countReads(`/api/v1/signals/${getHandoffSignalId(task)}`);
    // The quote of the handoff is drawn once the pane has read its signal.
    const waitForQuote = () =>
      waitFor(() => {
        expect(getPane()!.querySelector(".tr-orig-q")).not.toBeNull();
      });
    const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

    await userEvent.click(getRowButton(FINISHED_TASK));
    await waitForQuote();
    await settle();
    expect([countDetailReads(FINISHED_TASK), countSignalReads(FINISHED_TASK)]).toEqual([1, 1]);

    await userEvent.keyboard("j");
    await waitFor(() => {
      expect(readSelected()).toEqual([WORKING_TASK.id]);
      expect(countSignalReads(WORKING_TASK)).toBe(1);
    });
    await waitForQuote();
    await settle();
    expect([countDetailReads(WORKING_TASK), countSignalReads(WORKING_TASK)]).toEqual([1, 1]);
    expect([countDetailReads(FINISHED_TASK), countSignalReads(FINISHED_TASK)]).toEqual([1, 1]);

    // A push that names the open row's newest run reads its detail again, and nothing else of it.
    act(() => live.pushInvalidation("run", [getRunId(WORKING_TASK)]));
    await waitFor(() => {
      expect(countDetailReads(WORKING_TASK)).toBe(2);
    });
    await settle();
    expect([countDetailReads(WORKING_TASK), countSignalReads(WORKING_TASK)]).toEqual([2, 1]);

    // A push that names another Task's run reads this pane's detail no more.
    act(() => live.pushInvalidation("run", [getRunId(FINISHED_TASK)]));
    await settle();
    expect(countDetailReads(WORKING_TASK)).toBe(2);
    expect(countDetailReads(FINISHED_TASK)).toBe(1);

    // A push for a run no row holds reads nothing.
    const callsBefore = calls.length;
    act(() => live.pushInvalidation("run", ["01a06d02-7c00-7000-8000-0000000000fe"]));
    await settle();
    expect(calls).toHaveLength(callsBefore);
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
    await openIntake("/intake", {
      extra: storeTracking([[FINISHED_TASK, "completed"]], {
        buildRun: (task, status) => ({
          ...buildRunSummary(task, status, "Sent"),
          workflowId: null,
        }),
      }),
    });
    expect(getRowButton(FINISHED_TASK).textContent).toContain("Sent finished");
  });
});
