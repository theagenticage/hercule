/**
 * The desktop perf script's Tracking scenario: it measures the rows of spec 17
 * §What Intake costs that begin "Tracking". `perf.ts --tracking-only`
 * runs it:
 *
 * 1. Two idle launches of Intake, one with `TRACKED_COUNT` Tasks tracked
 *    (`seedTracking`) and one with nothing tracked (`releaseTracking`), which
 *    `perf.ts` measures with nothing attached. The pair shows what the rows add.
 * 2. One interaction launch (`measureTrackingInteractions`) of the same app,
 *    with a collector attached from before the page loads (`perf-collector.ts`).
 *    It runs every scenario in that one app, against the one controller: the
 *    reads of the shell's start, pushes with nothing tracked, `TRACKED_COUNT`
 *    handoffs, the same pushes with Tasks tracked, the hidden window and the
 *    motion.
 *
 * Your work is measured in the same launch. The fixture makes
 * `THREAD_SIGNALS` of the To do signals signals about a thread
 * (`makeSignalsAboutThreads`), and `seedYourWork` makes `YOUR_WORK_TASKS` open
 * Tasks that carry those threads' refs, so `signal.queryYourWork` has
 * something to return. `runSignalSeries` makes the signal pushes that read it
 * again.
 *
 * What the controller spends on the read is the controller benchmark's to
 * measure against the real statements, not this script's.
 *
 * Every wait is for an event: the state a change must reach, then the reads it
 * caused, then every animation. Only a case that expects no read keeps a fixed
 * window, because no event can prove that nothing comes.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type {
  RunStarted,
  Signal,
  TaskTracking,
  WorkflowSaveResult,
} from "../../../packages/contract/src/index";
import {
  assertExitedCleanly,
  connectInspector,
  evaluateInMain,
  formatTable,
  launchPlainApp,
  stopPlainApp,
  type Inspector,
} from "./packaged-app.ts";
import {
  startCollector,
  type Collector,
  type RecordedRequest,
  type Recording,
} from "./perf-collector.ts";
import { buildSignalThreadRef, type ThreadFixture } from "./perf-fixture.ts";
import {
  buildIntakeShown,
  droppedNoMotionFrame,
  formatMotion,
  INTAKE_SIGNALS,
  isStillAfter,
  measureListChange,
  POINTER_OFF_LIST,
  raiseSignal,
  SIGNALS_LIST,
  type MotionCost,
} from "./perf-intake.ts";
import { drivePage, waitForPageSocketUrl, type PageDriver } from "./perf-measures.ts";
import { readMainThreadMs } from "./perf-workflows.ts";
import { pollUntil } from "./poll.ts";

/**
 * Whether the run is the fast mode, `--tracking-fast`: the two idle launches
 * sample once the page is quiet. The report says so; the canonical idle stays
 * the reference.
 */
export const FAST_MODE = process.argv.includes("--tracking-fast");

/**
 * What the scenarios know about the page. Change a selector here when the
 * screen changes. Folded and opened Tracking are both a `.tr-tray` in the list
 * column. A sheet that is closing stays mounted and `inert` for its 180 ms
 * while the fold is drawn, so the live tray is the one that is not `inert`;
 * the opened sheet carries `is-open`.
 */
const LIVE_TRAY = ".asks-list > section.tr-tray:not([inert])";
const PAGE = {
  foldedCount: `${LIVE_TRAY}:not(.is-open) .tr-label .count`,
  openTray: `${LIVE_TRAY}.is-open`,
  row: `${LIVE_TRAY} .tr-run-item`,
  rowTitle: ".tr-run-title",
  rowButton: ".tr-run",
  signalRow: `${SIGNALS_LIST} .ask-row`,
  handToReviewButton: 'button[aria-label="Hand to Review PR"]',
} as const;

/** The routes of Tracking's reads, by operation. A GET to any other `/tasks` or `/runs` route counts as "other". */
const SNAPSHOT_ROUTE = "/api/v1/tasks/tracking";
/** Your work's read is `signal.queryYourWork`; To do is `signal.query` with the view `to-do`. */
const YOUR_WORK_ROUTE = "/api/v1/signals/your-work";
const TO_DO_ROUTE = "/api/v1/signals";
const RUN_READ_ROUTE = /^\/api\/v1\/runs\/[0-9a-f-]{36}$/;
const TASKS_OR_RUNS_ROUTE = /^\/api\/v1\/(tasks|runs)(\/|$)/;

/** How many Tasks `seedTracking` tracks, and how many changes each series makes. */
export const TRACKED_COUNT = 10;
const SERIES_CHANGES = 10;

/**
 * How many To do signals are about a thread, so Your work has Tasks for them
 * (`--tracking-thread-signals=N`, 60 unless given). Spec 17 budgets 200 signals
 * on To do, and 60 is a busy week of pull requests. 200 is the worst case.
 */
export const THREAD_SIGNALS = Number(
  process.argv
    .find((argument) => argument.startsWith("--tracking-thread-signals="))
    ?.split("=")[1] ?? 60,
);

/** How many open Tasks `seedYourWork` makes, and how many threads' refs each carries. */
const YOUR_WORK_TASKS = 10;
const REFS_PER_YOUR_WORK_TASK = 3;

/** A description of the length a Task an agent writes has: a few sentences of plain text. */
const YOUR_WORK_DESCRIPTION =
  "Checkout fails for cards that ask for 3-D Secure. The payment intent stays in requires_action " +
  "after the customer returns from the bank, so the order is never confirmed. Reproduce it with " +
  "the 4000 0027 6000 3184 test card, check the return URL the intent is created with, and make " +
  "the confirm step handle the returned intent. Add a test for the return and keep the existing " +
  "cards working. The failing run is linked in the pull request, and the logs are in the CI job.";

/**
 * How long nothing may begin, end or arrive before a change counts as read:
 * the controller's 50 ms window that gathers pushes, the page's wait before it
 * reads, and the read. A hidden page runs timers once a second, so it waits longer.
 */
const QUIET_READS_MS = 400;
const QUIET_READS_HIDDEN_MS = 1_800;

/** The motion tokens `--dur-1`, `--dur-2` and `--dur-3`, in milliseconds. */
const DUR_1_MS = 120;
const DUR_2_MS = 200;
const DUR_3_MS = 320;

/** The Task id the failing workflow's step updates; no Task has it. */
const MISSING_TASK_ID = "0199c0ff-7777-7000-8000-000000000001";

let lastProgressAt = Date.now();

/** Prints to stderr how long it has been since the last call, named `step`, so a slow step shows. */
export function logProgress(step: string): void {
  const now = Date.now();
  console.error(`[tracking] ${step}: ${((now - lastProgressAt) / 1_000).toFixed(1)} s`);
  lastProgressAt = now;
}

// ---------------------------------------------------------------------------
// Seeding: workflows, handoffs, and the barriers that wait for their runs.

/** The workflows the handoffs go to, by id. */
export interface TrackingWorkflows {
  /** Waits a day: its runs stay live until cancelled. */
  readonly implement: string;
  /**
   * Waits 4 s, then completes. A handoff measured for its motion needs the run
   * to stay Working until the recording ends, a second after the motion.
   */
  readonly review: string;
  /** Fails at once. */
  readonly investigate: string;
  /** Takes no signal and waits a second: a run that is not about a Task. */
  readonly pause: string;
}

/** Makes an enabled workflow of one step, taking a signal when `takesSignal`, and returns its id. */
async function createWorkflow(
  fixture: ThreadFixture,
  name: string,
  takesSignal: boolean,
  step: { readonly action: string; readonly params: Readonly<Record<string, string | number>> },
): Promise<string> {
  const inputs = takesSignal
    ? { inputs: [{ name: "signal", signal: { kinds: ["fyi"] }, required: true }] }
    : {};
  const { workflow } = await fixture.call<WorkflowSaveResult>("POST", "/workflows", {
    definition: { name, ...inputs, steps: [{ id: "work", kind: "action", ...step }] },
  });
  await fixture.call("PATCH", `/workflows/${workflow.id}`, { enabled: true });
  return workflow.id;
}

/** Makes the four workflows. Make them before raising the signals to hand off: a signal offers Hand to for the workflows that exist when it is raised. */
export async function createTrackingWorkflows(fixture: ThreadFixture): Promise<TrackingWorkflows> {
  const [implement, review, investigate, pause] = await Promise.all([
    createWorkflow(fixture, "Implement", true, { action: "wait", params: { seconds: 86_400 } }),
    createWorkflow(fixture, "Review PR", true, { action: "wait", params: { seconds: 4 } }),
    createWorkflow(fixture, "Investigate", true, {
      action: "task.update",
      params: { taskId: MISSING_TASK_ID, title: "Never" },
    }),
    createWorkflow(fixture, "A pause", false, { action: "wait", params: { seconds: 1 } }),
  ]);
  return { implement, review, investigate, pause };
}

/** The handoffs that track `TRACKED_COUNT` Tasks: 4 Finished, 2 Failed, 3 Working and 1 Stopped (the first Implement, cancelled after). */
const TRACKED_PLAN = [
  ...[1, 2, 3, 4].map((n) => ({ workflow: "review", title: `Review PR #${String(1_300 + n)}` })),
  ...[1, 2].map((n) => ({ workflow: "investigate", title: `Webhook fails ${String(n)}` })),
  ...[1, 2, 3, 4].map((n) => ({
    workflow: "implement",
    title: `Implement PAY-${String(200 + n)}`,
  })),
] as const;
const STOPPED_INDEX = TRACKED_PLAN.findIndex(({ workflow }) => workflow === "implement");

/** The statuses `TRACKED_PLAN` ends in, by the status of each Task's newest run. */
const TRACKED_STATUSES = { completed: 4, failed: 2, running: 3, cancelled: 1 };

/** Raises a signal titled `title`, hands it to the workflow `workflowId`, and returns the id of the run that started. */
async function handOffSignal(
  fixture: ThreadFixture,
  title: string,
  workflowId: string,
): Promise<string> {
  const { signalId } = await raiseSignal(fixture, title);
  const handed = await fixture.call<Signal>("POST", `/signals/${signalId}/hand-off`, {
    workflowId,
  });
  if (handed.resolution?.runId === undefined)
    throw new Error(`the handoff of "${title}" started no run`);
  return handed.resolution.runId;
}

/** Reads Tracking's rows from the controller, as `task.queryTracking` returns them. */
const readTracking = (fixture: ThreadFixture) =>
  fixture.call<TaskTracking>("GET", "/tasks/tracking");

/**
 * Waits until Tracking's rows have exactly these newest-run statuses, counted
 * by status. Fails after 30 s. It makes a seeded state real: a Working row has
 * a running run, a Finished row a completed one.
 */
async function awaitRunStatuses(
  fixture: ThreadFixture,
  expected: Readonly<Record<string, number>>,
) {
  await pollUntil(
    async () => {
      const counts: Record<string, number> = {};
      for (const { latestRun } of (await readTracking(fixture)).rows) {
        counts[latestRun.status] = (counts[latestRun.status] ?? 0) + 1;
      }
      const statuses = new Set([...Object.keys(counts), ...Object.keys(expected)]);
      return [...statuses].every((status) => (counts[status] ?? 0) === (expected[status] ?? 0))
        ? true
        : undefined;
    },
    {
      timeoutMs: 30_000,
      intervalMs: 100,
      timeoutMessage: `the tracked Tasks' runs did not reach ${JSON.stringify(expected)} within 30 s`,
    },
  );
}

/**
 * Hands the signals of `TRACKED_PLAN` off in parallel and returns once each
 * run has the status its row needs. The next `prepareLaunch` moves the runs
 * three hours back, so the rows show hours and no label changes during a launch.
 */
export async function seedTracking(
  fixture: ThreadFixture,
  workflows: TrackingWorkflows,
): Promise<void> {
  const runIds = await Promise.all(
    TRACKED_PLAN.map(({ workflow, title }) =>
      handOffSignal(fixture, title, workflows[workflow as keyof TrackingWorkflows]),
    ),
  );
  await awaitRunStatuses(fixture, { completed: 4, failed: 2, running: 4 });
  await fixture.call("POST", `/runs/${runIds[STOPPED_INDEX]!}/cancel`, {});
  await awaitRunStatuses(fixture, TRACKED_STATUSES);
}

/** Cancels the live runs of the tracked Tasks and marks each Task done, so nothing is tracked. Returns once Tracking reads no row. */
export async function releaseTracking(fixture: ThreadFixture): Promise<void> {
  const { rows } = await readTracking(fixture);
  await Promise.all(
    rows.map(async ({ taskId, latestLiveRun }) => {
      if (latestLiveRun !== undefined)
        await fixture.call("POST", `/runs/${latestLiveRun.id}/cancel`, {});
      await fixture.call("PATCH", `/tasks/${taskId}`, { status: "done" });
    }),
  );
  await pollUntil(
    async () => ((await readTracking(fixture)).rows.length === 0 ? true : undefined),
    {
      timeoutMs: 10_000,
      intervalMs: 100,
      timeoutMessage: "Tracking still read rows 10 s after every Task was marked done",
    },
  );
}

/**
 * Makes `YOUR_WORK_TASKS` open Tasks that are not tracked (no handoff), each
 * carrying the refs of `REFS_PER_YOUR_WORK_TASK` threads that `THREAD_SIGNALS`
 * signals are about, spread over those signals, and two refs no signal is
 * about, as a Task that an agent works on carries. They stay open when
 * `releaseTracking` marks the tracked Tasks done, so Your work reads them in
 * every launch.
 */
export async function seedYourWork(fixture: ThreadFixture): Promise<void> {
  await Promise.all(
    Array.from({ length: YOUR_WORK_TASKS }, async (_, index) => {
      const first = Math.floor((index * THREAD_SIGNALS) / YOUR_WORK_TASKS);
      const refs = [
        ...Array.from({ length: REFS_PER_YOUR_WORK_TASK }, (__, offset) =>
          buildSignalThreadRef(first + offset),
        ),
        `github:issue:acme/payments-api#${String(80 + index)}`,
        `linear:issue:PAY-${String(300 + index)}`,
      ];
      const created = await fixture.call<{ id: string }>("POST", "/tasks", {
        title: `Fix 3-D Secure checkout ${String(index + 1)}`,
        description: YOUR_WORK_DESCRIPTION,
        labels: ["payments", "bug"],
        provenance: refs.map((ref) => ({ ref })),
      });
      await fixture.call("PATCH", `/tasks/${created.id}`, { status: "in-progress" });
    }),
  );
}

// ---------------------------------------------------------------------------
// What the page did, from the collector, and the series that make it do things.

/** What the page sent and received in one stretch of time. */
interface Activity {
  /** Reads of `task.queryTracking`, of `run.read`, and of any other `/tasks` or `/runs` route. */
  readonly snapshots: number;
  readonly runReads: number;
  /** Reads of `signal.queryYourWork`, and of To do (`signal.query` with the view `to-do`). */
  readonly yourWorkReads: number;
  readonly toDoReads: number;
  readonly otherReads: number;
  /** Pushes on each topic, not counting the first message after subscribing, which are `firstMessages`. */
  readonly taskPushes: number;
  readonly runPushes: number;
  readonly signalPushes: number;
  readonly firstMessages: number;
  /** How many of the first messages are on the task and run topics, the two whose first message may re-read Tracking. */
  readonly firstTaskAndRunMessages: number;
  /** The `task.queryTracking` reads' median time and time to first byte, and the largest body, from the protocol's timings. */
  readonly snapshotTiming: string;
  /** The same for Your work's reads. */
  readonly yourWorkTiming: string;
}

const median = (numbers: readonly number[]): number =>
  numbers.toSorted((a, b) => a - b)[Math.floor(numbers.length / 2)] ?? 0;

/** Describes the median time, the median time to the first byte and the largest body of `reads`, or nothing when there are none. */
const describeTiming = (name: string, reads: readonly RecordedRequest[]): string =>
  reads.length === 0
    ? ""
    : `; ${name} median ${median(reads.map((r) => r.durationMs ?? 0)).toFixed(1)} ms ` +
      `(${median(reads.map((r) => r.firstByteMs ?? 0)).toFixed(1)} ms to the first byte), ` +
      `${String(Math.max(...reads.map((r) => r.bodyBytes)))} bytes`;

/** Counts the reads and pushes in `recording`. */
export function summarizeActivity({ requests, pushes }: Recording): Activity {
  const gets = requests.filter(
    ({ method, url }) => method === "GET" && TASKS_OR_RUNS_ROUTE.test(url.pathname),
  );
  const snapshots = gets.filter(({ url }) => url.pathname === SNAPSHOT_ROUTE);
  const runReads = gets.filter(({ url }) => RUN_READ_ROUTE.test(url.pathname));
  const yourWork = requests.filter(
    ({ method, url }) => method === "GET" && url.pathname === YOUR_WORK_ROUTE,
  );
  const toDoReads = requests.filter(
    ({ method, url }) =>
      method === "GET" && url.pathname === TO_DO_ROUTE && url.searchParams.get("view") === "to-do",
  );
  const changes = pushes.filter(({ initial }) => !initial);
  return {
    snapshots: snapshots.length,
    runReads: runReads.length,
    yourWorkReads: yourWork.length,
    toDoReads: toDoReads.length,
    otherReads: gets.length - snapshots.length - runReads.length,
    taskPushes: changes.filter(({ topic }) => topic === "task").length,
    runPushes: changes.filter(({ topic }) => topic === "run").length,
    signalPushes: changes.filter(({ topic }) => topic === "signal").length,
    firstMessages: pushes.length - changes.length,
    firstTaskAndRunMessages: pushes.filter(
      ({ initial, topic }) => initial && (topic === "task" || topic === "run"),
    ).length,
    snapshotTiming: describeTiming("task.queryTracking", snapshots),
    yourWorkTiming: describeTiming("signal.queryYourWork", yourWork),
  };
}

/** Formats an activity as one table cell. */
const formatActivity = (a: Activity): string =>
  `${String(a.taskPushes)} task and ${String(a.runPushes)} run pushes` +
  `${a.firstMessages === 0 ? "" : ` and ${String(a.firstMessages)} first messages`}; ` +
  `${String(a.snapshots)} task.queryTracking, ${String(a.yourWorkReads)} signal.queryYourWork, ` +
  `${String(a.toDoReads)} To do, ${String(a.runReads)} run.read, ${String(a.otherReads)} other reads` +
  `${a.snapshotTiming}${a.yourWorkTiming}`;

/** What a series of changes did to the page. */
interface SeriesCost extends Activity {
  readonly changes: number;
  /** The time the renderer's main thread spent running tasks over the series, polling included, in milliseconds. */
  readonly mainThreadMs: number;
}

/** What the scenarios share: the app's page, driven and recorded. */
interface Scenario {
  readonly fixture: ThreadFixture;
  readonly workflows: TrackingWorkflows;
  readonly page: Inspector;
  readonly driver: PageDriver;
  readonly collector: Collector;
  readonly inspectorUrl: string;
}

/** Waits until everything a change set off has finished: the reads it caused, then every animation, a late cascade included. */
async function settle({ collector, driver }: Scenario): Promise<void> {
  await collector.waitForQuietReads(QUIET_READS_MS);
  await driver.waitForAnimationsToEnd();
}

/**
 * Makes `count` changes one after another and returns what the page did over
 * them. Each change waits for its own push on `topic`, which fails the series
 * when none arrives, then for `reachesState` (an expression for the page,
 * given the change's index) and for the reads to finish. The changes are far
 * enough apart for the controller to send each as its own push.
 */
async function runSeries(
  { collector, driver, page }: Scenario,
  series: {
    readonly count: number;
    readonly topic: "task" | "run" | "signal";
    readonly change: (index: number) => Promise<void>;
    readonly reachesState?: (index: number) => string;
    /** Runs after the last change, before the series is read. */
    readonly finish?: () => Promise<void>;
  },
): Promise<SeriesCost> {
  const seriesFrom = collector.checkpoint();
  const threadFrom = await readMainThreadMs(page);
  for (let index = 0; index < series.count; index += 1) {
    const from = collector.checkpoint();
    await series.change(index);
    await collector.waitForPushes(from, series.topic, 1, `change ${String(index + 1)}`);
    if (series.reachesState !== undefined) {
      const message = `the page did not reach the state of change ${String(index + 1)}`;
      await driver.waitFor(series.reachesState(index), message);
    }
    await collector.waitForQuietReads(QUIET_READS_MS);
  }
  await series.finish?.();
  const mainThreadMs = (await readMainThreadMs(page)) - threadFrom;
  return { changes: series.count, mainThreadMs, ...summarizeActivity(collector.since(seriesFrom)) };
}

/**
 * Runs two series of pushes that change nothing Tracking shows: Tasks created,
 * and runs started that are not about a Task. Tracking should answer them with
 * few reads.
 */
async function runPushSeries(scenario: Scenario): Promise<{ tasks: SeriesCost; runs: SeriesCost }> {
  const { fixture, workflows, collector } = scenario;
  const tasks = await runSeries(scenario, {
    count: SERIES_CHANGES,
    topic: "task",
    change: async () => {
      await fixture.call("POST", "/tasks", { title: "A Task nobody hands off", description: "" });
    },
  });
  let lastRunId = "";
  const runs = await runSeries(scenario, {
    count: SERIES_CHANGES,
    topic: "run",
    change: async () => {
      lastRunId = (
        await fixture.call<RunStarted>("POST", "/runs/start", { workflowId: workflows.pause })
      ).runId;
    },
    // The runs complete a second after they start, and their later pushes must read nothing.
    finish: async () => {
      const isCompleted = async () =>
        (await fixture.call<{ status: string }>("GET", `/runs/${lastRunId}`)).status ===
        "completed";
      await pollUntil(async () => ((await isCompleted()) ? true : undefined), {
        timeoutMs: 10_000,
        intervalMs: 100,
        timeoutMessage: "the last run did not complete within 10 s",
      });
      await collector.waitForQuietReads(QUIET_READS_MS);
    },
  });
  return { tasks, runs };
}

/** What the signal series did: signals without a thread, and signals that leave To do and come back. */
interface SignalSeries {
  readonly withoutThread: SeriesCost;
  readonly leavingAndComing: SeriesCost;
}

/**
 * Runs two series of changes to To do. The first raises signals about no
 * thread, which can never be Your work. The second snoozes a signal about a
 * thread and brings it back, alternately, which changes Your work each time.
 * Both read To do and Your work again once for each push. Fails when To do
 * holds no signal about a thread, because `prepareLaunch` made none.
 */
async function runSignalSeries(scenario: Scenario): Promise<SignalSeries> {
  const { fixture } = scenario;
  const withoutThread = await runSeries(scenario, {
    count: SERIES_CHANGES,
    topic: "signal",
    change: async (index) => {
      await raiseSignal(fixture, `A signal about no thread ${String(index + 1)}`);
    },
  });
  const { items } = await fixture.call<{ items: Signal[] }>("GET", "/signals?view=to-do");
  const about = items.find(({ origin }) => origin.type === "event");
  if (about === undefined) throw new Error("To do holds no signal about a thread");
  const leavingAndComing = await runSeries(scenario, {
    count: SERIES_CHANGES,
    topic: "signal",
    change: async (index) => {
      if (index % 2 === 0) {
        const until = new Date(Date.now() + 3_600_000).toISOString();
        await fixture.call("POST", "/signals/snooze", { signalIds: [about.id], until });
      } else {
        await fixture.call("POST", "/signals/unsnooze", { signalIds: [about.id] });
      }
    },
  });
  return { withoutThread, leavingAndComing };
}

// ---------------------------------------------------------------------------
// The hidden window and the motion.

/** What the page held and did while its window was hidden, and when it showed again. */
interface HiddenWindowCost {
  readonly heldHidden: readonly string[];
  readonly heldShown: readonly string[];
  /** A Task created while hidden, a run started while hidden, and the window showing again. */
  readonly task: Activity;
  readonly run: Activity;
  readonly shown: Activity;
}

/** Hides the window, creates a Task and starts a run, shows the window again, and returns what the page held and did at each step. */
async function measureHiddenWindow(scenario: Scenario): Promise<HiddenWindowCost> {
  const { collector, driver, fixture, workflows, inspectorUrl } = scenario;
  const window = (call: string) =>
    evaluateInMain(inspectorUrl, `require("electron").BrowserWindow.getAllWindows()[0]?.${call}()`);

  await window("hide");
  await driver.waitFor(
    `document.visibilityState === "hidden"`,
    "the page was not hidden after the window hid",
  );
  await pollUntil(() => (collector.listHeldTopics().includes("run") ? undefined : true), {
    timeoutMs: 5_000,
    intervalMs: 50,
    timeoutMessage: "the page still held the run topic 5 s after the window hid",
  });
  const heldHidden = collector.listHeldTopics();

  const taskFrom = collector.checkpoint();
  await fixture.call("POST", "/tasks", { title: "A Task made while hidden", description: "" });
  await collector.waitForPushes(taskFrom, "task", 1, "a Task made while hidden");
  await collector.waitForQuietReads(QUIET_READS_HIDDEN_MS);
  const task = summarizeActivity(collector.since(taskFrom));

  const runFrom = collector.checkpoint();
  await fixture.call("POST", "/runs/start", { workflowId: workflows.pause });
  await sleep(QUIET_READS_HIDDEN_MS);
  const run = summarizeActivity(collector.since(runFrom));

  const shownFrom = collector.checkpoint();
  await window("showInactive");
  await driver.waitFor(
    `document.visibilityState === "visible"`,
    "the page was not visible after the window showed",
  );
  // The page subscribes to the run topic again, and the controller's first message says every run may have changed.
  await collector.waitForPushes(shownFrom, "run", 1, "the window showing again", true);
  await collector.waitForQuietReads(QUIET_READS_MS);
  return {
    heldHidden,
    heldShown: collector.listHeldTopics(),
    task,
    run,
    shown: summarizeActivity(collector.since(shownFrom)),
  };
}

/** The motion of Tracking, one cost for each change. */
interface TrackingMotion {
  readonly open: MotionCost;
  readonly close: MotionCost;
  readonly stateChange: MotionCost;
  readonly handoff: MotionCost;
  readonly tickOff: MotionCost;
}

/**
 * Measures the motion of Tracking, with the pointer off the list: opening and
 * closing it with `T`; a Working row's run cancelled, which makes it Stopped;
 * a signal handed to Review PR from the pane, whose row flies to folded
 * Tracking; and `E` on the Finished row that handoff made. Between changes it
 * waits for the state, the reads and the animations. Fails as `measureListChange` fails.
 */
async function measureMotion(scenario: Scenario, liveRunId: string): Promise<TrackingMotion> {
  const { fixture, driver, page } = scenario;
  const trayIsOpen = `document.querySelector(${JSON.stringify(PAGE.openTray)}) !== null`;
  const signalRows = JSON.stringify(PAGE.signalRow);
  const selectedSignal = `document.querySelector(${JSON.stringify(`${PAGE.signalRow}[aria-current="true"]`)})`;
  const signalTitled = (title: string) =>
    `[...document.querySelectorAll(${signalRows})].find((row) => row.querySelector(".ask-title")?.textContent === ${JSON.stringify(title)})`;
  const trackedRowTitled = (title: string) =>
    `[...document.querySelectorAll(${JSON.stringify(PAGE.row)})].find((row) => row.querySelector(${JSON.stringify(PAGE.rowTitle)})?.textContent === ${JSON.stringify(title)})`;
  // Folded Tracking shows the two rows that changed state last, so counting Stopped rows is not
  // enough: the Stopped row of the handoffs can leave the fold just as this one enters it. The
  // row of the cancelled run is found by its title instead.
  const cancelledRowStopped = `(${trackedRowTitled(TRACKED_PLAN[STOPPED_INDEX + 1]!.title)})?.getAttribute("data-state") === "stopped"`;
  const togglesTracking = (opens: boolean) => ({
    change: () => driver.pressKey("t"),
    lengthMs: opens ? 450 : 180,
    endsWhen: opens ? trayIsOpen : `!(${trayIsOpen})`,
    mustSee: opens ? trayIsOpen : `!(${trayIsOpen})`,
    ignoresTransitions: true,
  });

  await driver.movePointer(POINTER_OFF_LIST);
  // Clear To do down to two signals, so the signal raised next lands on screen.
  const { items } = await fixture.call<{ items: { id: string }[] }>("GET", "/signals?view=to-do");
  await fixture.call("POST", "/signals/mark-done", {
    signalIds: items.slice(2).map(({ id }) => id),
  });
  await driver.waitFor(
    `document.querySelectorAll(${signalRows}).length === 2`,
    "To do did not settle on two signals",
  );
  await settle(scenario);

  // A click selects a row and gives it the focus the keys need. Esc closes the
  // pane and a second Esc clears the selection, so neither the split's width
  // nor the selection moves while Tracking opens.
  await driver.click(`document.querySelector(${signalRows})`);
  await driver.waitFor(`${selectedSignal} !== null`, "a click on a signal did not select it");
  await driver.pressKey("Escape");
  await driver.waitForAnimationsToEnd();
  await driver.pressKey("Escape");
  await driver.waitFor(`${selectedSignal} === null`, "Esc did not clear the selection");
  await settle(scenario);

  const open = await measureListChange(page, togglesTracking(true));
  await settle(scenario);
  const close = await measureListChange(page, togglesTracking(false));
  await settle(scenario);

  // A change the user did not make waits while the pointer is on the list, and the click above left it there.
  await driver.movePointer(POINTER_OFF_LIST);
  const stateChange = await measureListChange(page, {
    change: async () => {
      await fixture.call("POST", `/runs/${liveRunId}/cancel`, {});
    },
    // The line fades over --dur-2, then the rows slide over --dur-3.
    lengthMs: DUR_2_MS + DUR_3_MS,
    endsWhen: cancelledRowStopped,
    mustSee: cancelledRowStopped,
    ignoresTransitions: true,
  });
  await settle(scenario);

  const title = "Handed off while measured";
  await raiseSignal(fixture, title);
  await driver.waitFor(
    `(${signalTitled(title)}) !== undefined`,
    "the signal to hand off did not land on screen",
  );
  await driver.click(signalTitled(title));
  await driver.waitFor(
    `(${signalTitled(title)})?.getAttribute("aria-current") === "true"`,
    "a click on the signal to hand off did not select it",
  );
  await settle(scenario);
  const handedOff = `(${trackedRowTitled(title)}) !== undefined`;
  const handoff = await measureListChange(page, {
    change: () =>
      driver.click(`document.querySelector(${JSON.stringify(PAGE.handToReviewButton)})`),
    // The copy flies over --dur-3, then the new row fades in over --dur-2.
    lengthMs: DUR_3_MS + DUR_2_MS,
    endsWhen: handedOff,
    mustSee: handedOff,
    ignoresTransitions: true,
  });
  await driver.waitFor(
    `(${trackedRowTitled(title)})?.getAttribute("data-state") === "finished"`,
    "the handed-off row did not finish",
  );
  await settle(scenario);

  await driver.evaluate(
    `(${trackedRowTitled(title)}).querySelector(${JSON.stringify(PAGE.rowButton)}).focus()`,
  );
  const gone = `(${trackedRowTitled(title)}) === undefined`;
  const tickOff = await measureListChange(page, {
    change: () => driver.pressKey("e"),
    // The row fades over --dur-1, then the gap closes over --dur-3.
    lengthMs: DUR_1_MS + DUR_3_MS,
    endsWhen: gone,
    mustSee: gone,
    ignoresTransitions: true,
  });
  await settle(scenario);
  return { open, close, stateChange, handoff, tickOff };
}

// ---------------------------------------------------------------------------
// The interaction launch.

/** What the interaction launch measured. */
export interface TrackingInteractions {
  readonly loadAtSpawn: number;
  /** The shell's reads from the reload until they finished. */
  readonly load: Activity;
  readonly nothingTracked: { readonly tasks: SeriesCost; readonly runs: SeriesCost };
  /** `TRACKED_COUNT` signals handed off, one at a time. */
  readonly handOffs: SeriesCost;
  readonly tracked: { readonly tasks: SeriesCost; readonly runs: SeriesCost };
  readonly signals: SignalSeries;
  readonly hidden: HiddenWindowCost;
  readonly motion: TrackingMotion;
}

/**
 * Starts the app on `userDataDir`, which opens Intake again, attaches a
 * collector, reloads the page so the collector sees the whole start, and runs
 * every scenario in that one app (see the top of this file). Nothing may be
 * tracked when it starts: call `releaseTracking` first. Fails when Intake does
 * not show, when a step does not reach its state within its time limit (the
 * message names the step), when a change's push never arrives, or when the app
 * does not quit cleanly. It leaves more Tasks tracked and the app on Intake,
 * so run it last.
 */
export async function measureTrackingInteractions(
  userDataDir: string,
  fixture: ThreadFixture,
  workflows: TrackingWorkflows,
): Promise<TrackingInteractions> {
  const loadAtSpawn = loadavg()[0]!;
  const app = await launchPlainApp(userDataDir);
  let measured: TrackingInteractions;
  try {
    const pageSocketUrl = await waitForPageSocketUrl(app.endpoint);
    const page = await connectInspector(pageSocketUrl);
    const collector = await startCollector(pageSocketUrl);
    try {
      const driver = drivePage(page);
      const scenario: Scenario = {
        fixture,
        workflows,
        page,
        driver,
        collector,
        inspectorUrl: app.inspectorUrl,
      };
      await page.send("Performance.enable");
      await page.send("Page.enable");
      // The page subscribed and made its first reads before the collector was
      // on, so it loads again with the collector watching.
      const loadFrom = collector.checkpoint();
      await page.send("Page.reload");
      await page.waitForEvent("Page.loadEventFired");
      await driver.waitFor(
        buildIntakeShown(INTAKE_SIGNALS),
        "Intake did not show after the reload",
        20_000,
      );
      await settle(scenario);
      const load = summarizeActivity(collector.since(loadFrom));
      await driver.movePointer(POINTER_OFF_LIST);
      logProgress("the app started and loaded again");

      const nothingTracked = await runPushSeries(scenario);
      logProgress("pushes, nothing tracked");
      const runIds: string[] = [];
      const handOffs = await runSeries(scenario, {
        count: TRACKED_COUNT,
        topic: "task",
        change: async (index) => {
          const { workflow, title } = TRACKED_PLAN[index]!;
          runIds.push(
            await handOffSignal(fixture, title, workflows[workflow as keyof TrackingWorkflows]),
          );
        },
        reachesState: (index) =>
          `document.querySelector(${JSON.stringify(PAGE.foldedCount)})?.textContent === "${String(index + 1)}"`,
      });
      await fixture.call("POST", `/runs/${runIds[STOPPED_INDEX]!}/cancel`, {});
      await awaitRunStatuses(fixture, TRACKED_STATUSES);
      await settle(scenario);
      logProgress("handoffs");
      const tracked = await runPushSeries(scenario);
      logProgress("pushes, tracked");

      const signals = await runSignalSeries(scenario);
      logProgress("signal pushes");

      const hidden = await measureHiddenWindow(scenario);
      logProgress("the hidden window");
      const motion = await measureMotion(scenario, runIds[STOPPED_INDEX + 1]!);
      logProgress("motion");
      measured = { loadAtSpawn, load, nothingTracked, handOffs, tracked, signals, hidden, motion };
    } finally {
      collector.close();
      page.close();
    }
  } finally {
    await stopPlainApp(app);
  }
  assertExitedCleanly(app.process);
  return measured;
}

// ---------------------------------------------------------------------------
// The report.

/** A row of the report: the row, its limit, what was measured, and whether it is within (null for no limit). */
type ReportRow = [string, string, string, boolean | null];

const formatSeries = (cost: SeriesCost): string =>
  `${formatActivity(cost)}; renderer main thread ${(cost.mainThreadMs / cost.changes).toFixed(1)} ms a change`;

const formatMotionCell = (cost: MotionCost): string =>
  `${formatMotion(cost)}; properties ${cost.properties.join(", ")}; animations: ${cost.kinds.join("; ")}`;

/**
 * Checks whether the reads of the shell's start are within the bound the spec sets:
 * one `task.queryTracking`, and at most one more for the first message of each
 * of the task and run topics (the other topics' first messages read nothing of
 * Tracking's), no `run.read` and no other read of `/tasks` or `/runs`.
 */
export const isLoadWithinBound = (load: Activity): boolean =>
  load.snapshots >= 1 &&
  load.snapshots <= 1 + load.firstTaskAndRunMessages &&
  load.runReads === 0 &&
  load.otherReads === 0;

/**
 * Checks whether Your work's reads at the shell's start are within the bound the spec
 * sets: one `signal.queryYourWork`, and at most one more for the first message
 * of each of the task and signal topics, the two whose first message reads it
 * again.
 */
export const isYourWorkLoadWithinBound = (load: Activity): boolean =>
  load.yourWorkReads >= 1 && load.yourWorkReads <= 3;

/** Whether a series read Tracking once for each push on the task topic, and read no run. */
const readsOncePerPush = (cost: SeriesCost): boolean =>
  cost.snapshots >= cost.changes && cost.snapshots <= cost.taskPushes && cost.runReads === 0;

/** Whether a series read Your work once for each push on the task topic. */
const readsYourWorkOncePerTaskPush = (cost: SeriesCost): boolean =>
  cost.yourWorkReads >= cost.changes && cost.yourWorkReads <= cost.taskPushes;

/** Whether a series read Your work once for each push on the signal topic. */
const readsYourWorkOncePerSignalPush = (cost: SeriesCost): boolean =>
  cost.yourWorkReads >= cost.changes && cost.yourWorkReads <= cost.signalPushes;

/** Whether a series read Tracking at most once for each run it started, and read no run. */
const readsAtMostOncePerCreation = (cost: SeriesCost): boolean =>
  cost.snapshots <= cost.changes && cost.runReads === 0;

/** Prints what the interaction launch measured, against the planned costs in spec 17. */
export function reportTrackingInteractions(result: TrackingInteractions): void {
  const { load, nothingTracked, handOffs, tracked, signals, hidden, motion } = result;
  const oncePerPush = "one task.queryTracking for each push, and none more";
  const oncePerCreation =
    "at most one task.queryTracking for each run's creation, nothing for its later pushes";
  const elsewhere = "one opacity animation, plus one transform per row that moves";
  const motionRows: [string, string, MotionCost, boolean][] = [
    [
      "Opening Tracking with T",
      "one animation for the sheet, at most 13 for the cascade, done within 450 ms; transform and opacity only; hover and focus transitions are not counted",
      motion.open,
      motion.open.animations <= 14 && droppedNoMotionFrame(motion.open),
    ],
    [
      "Closing Tracking with T",
      "one animation, 180 ms",
      motion.close,
      motion.close.animations === 1 && droppedNoMotionFrame(motion.close),
    ],
    ["A state change: a Working row stops", elsewhere, motion.stateChange, true],
    [
      "A handoff from the pane",
      "one animation for the lifted copy, plus one transform per row that moves on screen",
      motion.handoff,
      true,
    ],
    ["A tick-off with E on a Finished row", elsewhere, motion.tickOff, true],
  ];
  const rows: ReportRow[] = [
    [
      "Reads while the shell loads",
      "one task.queryTracking, and at most one more for the first message of each of the task and run topics; no run.read",
      formatActivity(load),
      isLoadWithinBound(load),
    ],
    [
      "Reads of Your work while the shell loads",
      "one signal.queryYourWork, and at most one more for the first message of each of the task and signal topics",
      formatActivity(load),
      isYourWorkLoadWithinBound(load),
    ],
    [
      "A Task created, nothing tracked",
      oncePerPush,
      formatSeries(nothingTracked.tasks),
      readsOncePerPush(nothingTracked.tasks) && readsYourWorkOncePerTaskPush(nothingTracked.tasks),
    ],
    [
      "A run that is not about a Task, nothing tracked",
      oncePerCreation,
      formatSeries(nothingTracked.runs),
      readsAtMostOncePerCreation(nothingTracked.runs) && nothingTracked.runs.yourWorkReads === 0,
    ],
    [
      `${String(TRACKED_COUNT)} handoffs`,
      "at least one task.queryTracking for each handoff and at most one for each push; no run.read",
      formatSeries(handOffs),
      handOffs.snapshots >= handOffs.changes &&
        handOffs.snapshots <= handOffs.taskPushes + handOffs.runPushes &&
        handOffs.runReads === 0 &&
        handOffs.yourWorkReads <= handOffs.taskPushes + handOffs.signalPushes,
    ],
    [
      `A Task created, ${String(TRACKED_COUNT)} tracked`,
      oncePerPush,
      formatSeries(tracked.tasks),
      readsOncePerPush(tracked.tasks) && readsYourWorkOncePerTaskPush(tracked.tasks),
    ],
    [
      `A run that is not about a Task, ${String(TRACKED_COUNT)} tracked`,
      oncePerCreation,
      formatSeries(tracked.runs),
      readsAtMostOncePerCreation(tracked.runs) && tracked.runs.yourWorkReads === 0,
    ],
    [
      "A signal about no thread raised",
      "To do and Your work read again once for each push",
      formatSeries(signals.withoutThread),
      signals.withoutThread.toDoReads >= signals.withoutThread.changes &&
        readsYourWorkOncePerSignalPush(signals.withoutThread),
    ],
    [
      "A signal about a thread snoozed and brought back",
      "To do and Your work read again once for each push",
      formatSeries(signals.leavingAndComing),
      signals.leavingAndComing.toDoReads >= signals.leavingAndComing.changes &&
        readsYourWorkOncePerSignalPush(signals.leavingAndComing),
    ],
    [
      "The window hidden",
      "the task topic held and the run topic dropped; a Task made reads once; a run started arrives not at all and reads nothing; showing the window reads again and holds the run topic",
      `hidden holds ${hidden.heldHidden.join(", ")}; a Task: ${formatActivity(hidden.task)}; a run: ${formatActivity(hidden.run)}; shown holds ${hidden.heldShown.join(", ")}: ${formatActivity(hidden.shown)}`,
      hidden.heldHidden.includes("task") &&
        !hidden.heldHidden.includes("run") &&
        hidden.task.snapshots >= 1 &&
        hidden.task.snapshots <= hidden.task.taskPushes &&
        hidden.task.yourWorkReads >= 1 &&
        hidden.run.yourWorkReads === 0 &&
        hidden.run.runPushes === 0 &&
        hidden.run.snapshots === 0 &&
        hidden.heldShown.includes("run") &&
        hidden.shown.snapshots >= 1,
    ],
    ...motionRows.map(([row, limit, cost, within]): ReportRow => [
      row,
      limit,
      formatMotionCell(cost),
      within &&
        cost.properties.every((property) => ["opacity", "transform"].includes(property)) &&
        isStillAfter(cost),
    ]),
  ];

  console.log("## Tracking, in the app");
  console.log();
  if (FAST_MODE) {
    console.log("FAST MODE: the idle launches above sampled once the page was quiet.");
    console.log();
  }
  console.log(
    "A collector is attached for the whole launch (Chrome DevTools Protocol, Network): push and request counts come from the wire, request timings from the protocol, and the motion rows err long by the cost of that attachment. Memory and idle are in the launches above, with nothing attached.",
  );
  console.log();
  console.log(`Load average over the minute before the launch: ${result.loadAtSpawn.toFixed(2)}`);
  console.log();
  const cells = ([row, limit, measuredText, within]: ReportRow) => [
    row,
    limit,
    measuredText,
    within === null ? "-" : within ? "yes" : "over",
  ];
  console.log(formatTable(["Row", "Limit", "Measured", "Within"], rows.map(cells)));
  console.log();
}
