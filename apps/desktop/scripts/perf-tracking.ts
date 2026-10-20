/**
 * The desktop perf script's Tracking scenario: it measures the rows of spec 17
 * §What Intake costs that begin "Tracking" (#801). `perf.ts --tracking-only`
 * runs it. The idle rows (processes, memory, wakeups, the age clock) come
 * from two launches `perf.ts` measures as it measures Intake's: one with
 * nothing tracked and one after `seedTracking`, so the pair shows what the
 * rows add. This file measures the rest:
 *
 * - `measureTrackingReads`: what the two reads cost on the controller, with
 *   10 tracked Tasks and with 210 (see `seedMoreTracking`), and the query
 *   plan of each, which must name an index;
 * - `measureTrackingWork`, in one plain launch on Intake:
 *   - the requests the shell makes for Tracking while it loads;
 *   - the requests, the pushes and the renderer's main thread for a Task
 *     created and for a run that is not about a Task, which is a push on the
 *     `task` and on the `run` topic;
 *   - the animations of opening and closing Tracking, of a state change, of a
 *     handoff and of a tick-off (see `measureListChange`).
 *
 * The scenario runs twice in `--tracking-only`, so a push is measured with
 * nothing tracked too: a push then must make no read of the runs.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { RunStarted, Signal, WorkflowSaveResult } from "../../../packages/contract/src/index";
import {
  assertExitedCleanly,
  connectInspector,
  formatTable,
  launchPlainApp,
  stopPlainApp,
  type Inspector,
} from "./packaged-app.ts";
import type { ThreadFixture } from "./perf-fixture.ts";
import {
  droppedNoMotionFrame,
  formatMotion,
  isStillAfter,
  measureListChange,
  POINTER_OFF_LIST,
  PUSH_SETTLE_MS,
  raiseSignal,
  SIGNALS_LIST,
  type MotionCost,
} from "./perf-intake.ts";
import { RECORD_FRAMES, waitForPageSocketUrl } from "./perf-measures.ts";
import { pollUntil } from "./poll.ts";

/** How many Tasks of each state `seedTracking` tracks. */
export const TRACKED = { finished: 4, failed: 2, working: 3, stopped: 1 } as const;

/** How many Tasks are tracked after `seedTracking`. */
export const TRACKED_COUNT = Object.values(TRACKED).reduce((sum, count) => sum + count, 0);

/** How many more Tasks `seedMoreTracking` tracks, for the reads at scale. */
export const MORE_TRACKED = 200;

/** The most task ids one `run.query` takes (`MAX_RUN_FILTER_TASK_IDS`). */
const RUN_FILTER_TASK_IDS = 100;

/** The tray of Tracking in the list column. The sheet's closing copy (`.tr-fly`) is not a child of the list. */
const TRAY = ".asks-list > section.tr-tray";

/** How many times each read is timed on the controller. */
const READ_SAMPLES = 30;

/** How many Tasks, and how many runs not about a Task, are created one at a time, and how far apart. */
const PUSH_COUNT = 10;
const PUSH_INTERVAL_MS = 1_000;

/** How long the launch rests after Intake has shown, before the first step, so the launch's own work is over. */
const LAUNCH_SETTLE_MS = 5_000;

/** How many signals stay on To do before the handoff, so the signals that offer a handoff land on screen. */
const SIGNALS_BEFORE_HANDOFF = 2;

/** The Task id the failing workflow's step updates; no Task has it. */
const MISSING_TASK_ID = "0199c0ff-7777-7000-8000-000000000001";

/** The workflows `seedTracking` makes, by the name the Hand to answers carry. */
interface TrackingWorkflows {
  /** Waits a day: its runs stay live until cancelled. */
  readonly implement: string;
  /** Waits a second, then completes. */
  readonly review: string;
  /** Fails at once. */
  readonly investigate: string;
}

/** Makes an enabled workflow with a signal input for FYIs and one step, and returns its id. */
async function createHandoffWorkflow(
  fixture: ThreadFixture,
  name: string,
  action: string,
  params: Readonly<Record<string, string | number>>,
): Promise<string> {
  const { workflow } = await fixture.call<WorkflowSaveResult>("POST", "/workflows", {
    definition: {
      name,
      inputs: [{ name: "signal", signal: { kinds: ["fyi"] }, required: true }],
      steps: [{ id: "work", kind: "action", action, params }],
    },
  });
  await fixture.call("PATCH", `/workflows/${workflow.id}`, { enabled: true });
  return workflow.id;
}

/** Makes the three workflows the handoffs go to. */
const createTrackingWorkflows = async (fixture: ThreadFixture): Promise<TrackingWorkflows> => ({
  implement: await createHandoffWorkflow(fixture, "Implement", "wait", { seconds: 86_400 }),
  review: await createHandoffWorkflow(fixture, "Review PR", "wait", { seconds: 1 }),
  investigate: await createHandoffWorkflow(fixture, "Investigate", "task.update", {
    taskId: MISSING_TASK_ID,
    title: "Never",
  }),
});

/**
 * Raises one signal titled `title`, hands it to the workflow `workflowId`
 * through `signal.handOff`, and returns the id of the run it started. The
 * signal is raised after the workflows exist, because a signal offers Hand to
 * an agent for the workflows that exist when it is raised.
 */
async function handOffSignal(
  fixture: ThreadFixture,
  title: string,
  workflowId: string,
): Promise<string> {
  const { signalId } = await raiseSignal(fixture, title);
  const resolved = await fixture.call<Signal>("POST", `/signals/${signalId}/hand-off`, {
    workflowId,
  });
  const runId = resolved.resolution?.runId;
  if (runId === undefined) throw new Error(`the handoff of "${title}" resolved with no run`);
  return runId;
}

/** Waits until the run `runId` has the status `status`. Fails after 30 s. */
const waitForRunStatus = (fixture: ThreadFixture, runId: string, status: string): Promise<void> =>
  pollUntil(
    async () =>
      (await fixture.call<{ readonly status: string }>("GET", `/runs/${runId}`)).status === status
        ? true
        : undefined,
    {
      timeoutMs: 30_000,
      intervalMs: 100,
      timeoutMessage: `the run ${runId} was not ${status} within 30 s`,
    },
  ).then(() => undefined);

/** The workflows and the Tasks' runs `seedTracking` made. */
export interface SeededTracking {
  readonly workflows: TrackingWorkflows;
  /** The runs of the Working rows that are still live, oldest first. */
  readonly liveRunIds: readonly string[];
}

/**
 * Hands signals to workflows until `TRACKED` Tasks are tracked: Finished,
 * Failed, Working and Stopped. The Stopped Task is a Working one whose run is
 * cancelled. Returns once each run has the status its row needs.
 *
 * The handed-off signals leave To do, so To do holds the signals it held
 * before. The runs are about a few minutes old; the next `prepareLaunch`
 * moves them back three hours, so the rows show hours and no label changes
 * during a launch.
 */
export async function seedTracking(fixture: ThreadFixture): Promise<SeededTracking> {
  const workflows = await createTrackingWorkflows(fixture);
  const finished: string[] = [];
  const failed: string[] = [];
  const working: string[] = [];
  for (let number = 1; number <= TRACKED.finished; number += 1) {
    finished.push(
      await handOffSignal(fixture, `Review PR #${String(1_300 + number)}`, workflows.review),
    );
  }
  for (let number = 1; number <= TRACKED.failed; number += 1) {
    failed.push(
      await handOffSignal(
        fixture,
        `Webhook deliveries fail ${String(number)}`,
        workflows.investigate,
      ),
    );
  }
  for (let number = 1; number <= TRACKED.working + TRACKED.stopped; number += 1) {
    working.push(
      await handOffSignal(fixture, `Implement PAY-${String(200 + number)}`, workflows.implement),
    );
  }
  const stopped = working.splice(0, TRACKED.stopped);
  for (const runId of stopped) {
    await fixture.call("POST", `/runs/${runId}/cancel`, {});
    await waitForRunStatus(fixture, runId, "cancelled");
  }
  for (const runId of finished) await waitForRunStatus(fixture, runId, "completed");
  for (const runId of failed) await waitForRunStatus(fixture, runId, "failed");
  for (const runId of working) await waitForRunStatus(fixture, runId, "running");
  return { workflows, liveRunIds: working };
}

/**
 * Hands `MORE_TRACKED` more signals to the quick workflow, which finishes
 * each at once, for the reads at scale. Returns once every run is completed.
 */
export async function seedMoreTracking(
  fixture: ThreadFixture,
  { workflows }: SeededTracking,
): Promise<void> {
  const runIds: string[] = [];
  for (let number = 1; number <= MORE_TRACKED; number += 1) {
    runIds.push(await handOffSignal(fixture, `Scale PR #${String(number)}`, workflows.review));
  }
  for (const runId of runIds) await waitForRunStatus(fixture, runId, "completed");
}

/** What the controller spent answering Tracking's two reads. */
interface ReadCost {
  /** How many Tasks `task.query` returned. */
  readonly taskCount: number;
  /** How many runs `run.query` returned. */
  readonly runCount: number;
  /** The median time of `task.query` with `handedOff` and `in-progress`, from the request to the parsed answer, in milliseconds. */
  readonly tasksMs: number;
  /** How many `run.query` requests one snapshot makes: one for each 100 Tasks. */
  readonly runQueries: number;
  /** The median time of all the `run.query` requests of a snapshot, made at once, in milliseconds. */
  readonly runsMs: number;
  /** The query plan of each read: one line per step of SQLite's plan. */
  readonly plans: { readonly tasks: readonly string[]; readonly runs: readonly string[] };
}

/** Returns the median of `numbers`. */
const median = (numbers: readonly number[]): number =>
  numbers.toSorted((a, b) => a - b)[Math.floor(numbers.length / 2)]!;

/**
 * Returns SQLite's plan for `sql`, one string per step, from a read-only
 * connection to the controller's database. The plan is for the query as
 * written here, which mirrors the repository's: it is what a reader checks
 * for a full scan, not a trace of the controller's own statement.
 */
function explainQuery(
  home: string,
  sql: string,
  parameters: readonly (string | Uint8Array)[],
): readonly string[] {
  const database = new DatabaseSync(join(home, "data", "hercule.db"), { readOnly: true });
  try {
    return database
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...parameters)
      .map((row) => String(row["detail"]));
  } finally {
    database.close();
  }
}

/**
 * Times Tracking's two reads on the controller, as the shell makes them
 * (`task.query` with `handedOff` and `in-progress`, then `run.query` by the
 * Tasks' ids), `READ_SAMPLES` times each, and returns the medians with the
 * query plans. The plans are checked by the caller for a scan of `tasks`,
 * `task_provenance` or `runs`.
 *
 * Fails when no Task is tracked, because the second read then has nothing to
 * measure.
 */
export async function measureTrackingReads(fixture: ThreadFixture): Promise<ReadCost> {
  const readTasks = () =>
    fixture.call<{ readonly items: readonly { readonly id: string }[] }>(
      "GET",
      "/tasks?handedOff=true&status=in-progress&limit=500",
    );
  const tasks = (await readTasks()).items;
  if (tasks.length === 0) throw new Error("no Task is tracked, so there are no reads to measure");
  // run.query takes at most 100 task ids, so the app asks in chunks of 100, all at once.
  const chunks: string[][] = [];
  for (let start = 0; start < tasks.length; start += RUN_FILTER_TASK_IDS) {
    chunks.push(tasks.slice(start, start + RUN_FILTER_TASK_IDS).map((task) => task.id));
  }
  const readRuns = async () =>
    (
      await Promise.all(
        chunks.map((chunk) =>
          fixture.call<{ readonly items: readonly unknown[] }>(
            "GET",
            `/runs?${chunk.map((id) => `taskIds=${id}`).join("&")}&limit=500`,
          ),
        ),
      )
    ).flatMap((page) => page.items);
  const time = async (read: () => Promise<unknown>) => {
    const samples: number[] = [];
    for (let sample = 0; sample < READ_SAMPLES; sample += 1) {
      const startedAt = performance.now();
      await read();
      samples.push(performance.now() - startedAt);
    }
    return median(samples);
  };
  const ids = chunks[0]!.map((id) => Buffer.from(id.replaceAll("-", ""), "hex"));
  return {
    taskCount: tasks.length,
    runCount: (await readRuns()).length,
    runQueries: chunks.length,
    tasksMs: await time(readTasks),
    runsMs: await time(readRuns),
    plans: {
      tasks: explainQuery(
        fixture.home,
        `SELECT tasks.id FROM tasks
         WHERE tasks.status IN ('in-progress')
           AND tasks.id IN (SELECT task_id FROM task_provenance WHERE signal_id IS NOT NULL)
         ORDER BY tasks.updated_at DESC, tasks.id DESC LIMIT 500`,
        [],
      ),
      runs: explainQuery(
        fixture.home,
        `SELECT id FROM runs WHERE task_id IN (${ids.map(() => "?").join(", ")})
         ORDER BY created_at DESC, id DESC LIMIT 500`,
        ids,
      ),
    },
  };
}

/** The requests the page made for Tasks and runs in a stretch of time. */
interface ReadCount {
  /** `task.query` with `handedOff`. */
  readonly trackedTasks: number;
  /** `run.query` with `taskIds`. */
  readonly trackedRuns: number;
  /** `run.read`, one for the reason of a Failed row. */
  readonly runReads: number;
  /** Any other request to `/tasks` or `/runs`. */
  readonly other: number;
}

/** One read of Tracking, as the page's resource timing recorded it. */
interface TimedRead {
  readonly name: "task.query" | "run.query" | "run.read";
  /** When the request began, in milliseconds after the page opened. */
  readonly startMs: number;
  /** From the request to the end of its answer. */
  readonly durationMs: number;
  /** From the request being sent to the first byte of the answer. */
  readonly waitMs: number;
  /** The size of the answer's body, in bytes. */
  readonly bytes: number;
}

/** What `measureTrackingWork` measured in one launch. */
export interface TrackingWork {
  /** The label of the launch: what was tracked. */
  readonly label: string;
  /** How many Tasks were tracked when the app launched. */
  readonly tracked: number;
  readonly loadAtSpawn: number;
  /** The reads the shell made for Tracking while it loaded. */
  readonly loadReads: readonly TimedRead[];
  /** A Task created, `PUSH_COUNT` times: one push on the `task` topic each. */
  readonly taskPushes: PushCost;
  /** A run that is not about a Task, `PUSH_COUNT` times: pushes on the `run` topic. */
  readonly runPushes: PushCost;
  /** Present only with Tasks tracked. */
  readonly motion?: {
    readonly open: MotionCost;
    readonly close: MotionCost;
    readonly stateChange: MotionCost;
    readonly handoff: MotionCost;
    readonly tickOff: MotionCost;
  };
}

/** What a series of pushes cost the page. */
interface PushCost {
  /** How many pushes the page received. */
  readonly pushes: number;
  readonly reads: ReadCount;
  /** The time the renderer's main thread spent running tasks over the series, in milliseconds. */
  readonly mainThreadMs: number;
}

/** Sends a key to the page, as a press: down, then up. */
async function pressKey(page: Inspector, key: string): Promise<void> {
  const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
      ...(type === "keyDown" && key.length === 1 ? { text: key } : {}),
    });
  }
}

/**
 * Starts the app on `userDataDir` as a plain process, which opens Intake
 * again, and measures Tracking at work in it (see the top of this file).
 * `label` names the launch in the report. Fails when Intake does not show
 * within 15 s, when a step's change moves nothing (see `measureListChange`),
 * or when the app does not quit cleanly afterwards.
 *
 * With Tasks tracked it also measures the motion, which clears To do down to
 * `SIGNALS_BEFORE_HANDOFF` signals, so it runs last and leaves Tracking
 * closed, as the app stores the last screen it settled on.
 *
 * `seeded` is what `seedTracking` made. With `null`, nothing is tracked, and
 * only the reads and the pushes are measured.
 */
export async function measureTrackingWork(
  userDataDir: string,
  fixture: ThreadFixture,
  label: string,
  seeded: SeededTracking | null,
): Promise<TrackingWork> {
  const loadAtSpawn = loadavg()[0]!;
  const app = await launchPlainApp(userDataDir);
  let measured: TrackingWork;
  try {
    const page = await connectInspector(await waitForPageSocketUrl(app.endpoint));
    try {
      const evaluate = (expression: string) =>
        page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
      const waitInPage = (expression: string, timeoutMessage: string) =>
        pollUntil(async () => ((await evaluate(expression)) === true ? true : undefined), {
          timeoutMs: 15_000,
          intervalMs: 50,
          timeoutMessage,
        }).then(() => undefined);
      await waitInPage(
        `document.querySelector(${JSON.stringify(`${SIGNALS_LIST} .ask-row`)}) !== null`,
        "the app did not open Intake with its signals",
      );
      const loadReads = (await evaluate(READ_TRACKING_REQUESTS)) as TimedRead[];
      await sleep(LAUNCH_SETTLE_MS);

      await evaluate(RECORD_FRAMES);
      await page.send("Performance.enable");
      const readMainThreadMs = async () => {
        const { metrics } = (await page.send("Performance.getMetrics")) as {
          metrics: { name: string; value: number }[];
        };
        return metrics.find((metric) => metric.name === "TaskDuration")!.value * 1_000;
      };
      const measurePushes = async (push: () => Promise<void>): Promise<PushCost> => {
        const from = (await evaluate("performance.now()")) as number;
        const framesFrom = (await evaluate("globalThis.receivedFrames.length")) as number;
        const threadFrom = await readMainThreadMs();
        for (let count = 0; count < PUSH_COUNT; count += 1) {
          await push();
          await sleep(PUSH_INTERVAL_MS);
        }
        await sleep(PUSH_SETTLE_MS);
        return {
          pushes: ((await evaluate("globalThis.receivedFrames.length")) as number) - framesFrom,
          reads: (await evaluate(`(${COUNT_REQUESTS})(${String(from)})`)) as ReadCount,
          mainThreadMs: (await readMainThreadMs()) - threadFrom,
        };
      };
      const taskPushes = await measurePushes(async () => {
        await fixture.call("POST", "/tasks", { title: "A Task nobody hands off", description: "" });
      });
      const pause = await createHandoffWorkflowWithoutInput(fixture);
      const runPushes = await measurePushes(async () => {
        await fixture.call<RunStarted>("POST", "/runs/start", { workflowId: pause });
      });

      measured = {
        label,
        tracked: seeded === null ? 0 : TRACKED_COUNT,
        loadAtSpawn,
        loadReads,
        taskPushes,
        runPushes,
        ...(seeded === null
          ? {}
          : { motion: await measureTrackingMotion(page, fixture, seeded, evaluate, waitInPage) }),
      };
    } finally {
      page.close();
    }
  } finally {
    await stopPlainApp(app);
  }
  assertExitedCleanly(app.process);
  return measured;
}

/** Makes an enabled workflow with no input and one step that waits a second, and returns its id. */
async function createHandoffWorkflowWithoutInput(fixture: ThreadFixture): Promise<string> {
  const { workflow } = await fixture.call<WorkflowSaveResult>("POST", "/workflows", {
    definition: {
      name: `A pause ${String(Date.now())}`,
      steps: [{ id: "work", kind: "action", action: "wait", params: { seconds: 1 } }],
    },
  });
  return workflow.id;
}

/**
 * An expression that evaluates, in the page, to Tracking's reads so far, from
 * the page's resource timing: the `task.query` with `handedOff`, the
 * `run.query` with `taskIds` and each `run.read`. The page keeps the first
 * 250 resource entries, which the shell's loading stays well under.
 */
const READ_TRACKING_REQUESTS = `(() => {
  return performance.getEntriesByType("resource").flatMap((entry) => {
    const url = new URL(entry.name);
    const common = {
      startMs: entry.startTime,
      durationMs: entry.duration,
      waitMs: entry.responseStart - entry.requestStart,
      bytes: entry.decodedBodySize,
    };
    if (url.pathname === "/api/v1/tasks" && url.searchParams.get("handedOff") === "true") {
      return [{ name: "task.query", ...common }];
    }
    if (url.pathname === "/api/v1/runs" && url.searchParams.has("taskIds")) {
      return [{ name: "run.query", ...common }];
    }
    if (/^\\/api\\/v1\\/runs\\/[0-9a-f-]{36}$/.test(url.pathname)) {
      return [{ name: "run.read", ...common }];
    }
    return [];
  });
})()`;

/**
 * An expression for a function that counts, in the page, the requests to
 * `/tasks` and `/runs` that began at or after the time it is given, in
 * milliseconds after the page opened.
 */
const COUNT_REQUESTS = `(from) => {
  const counts = { trackedTasks: 0, trackedRuns: 0, runReads: 0, other: 0 };
  for (const entry of performance.getEntriesByType("resource")) {
    if (entry.startTime < from) continue;
    const url = new URL(entry.name);
    if (!/^\\/api\\/v1\\/(tasks|runs)(\\/|$)/.test(url.pathname)) continue;
    if (url.pathname === "/api/v1/tasks" && url.searchParams.get("handedOff") === "true") counts.trackedTasks += 1;
    else if (url.pathname === "/api/v1/runs" && url.searchParams.has("taskIds")) counts.trackedRuns += 1;
    else if (/^\\/api\\/v1\\/runs\\/[0-9a-f-]{36}$/.test(url.pathname)) counts.runReads += 1;
    else counts.other += 1;
  }
  return counts;
}`;

/**
 * Clicks, with the mouse, at the centre of the element that `element`, an
 * expression evaluated in the page, evaluates to. A click selects a row and
 * gives it the focus the keys need. Fails when the expression evaluates to no
 * element.
 */
async function clickElement(
  page: Inspector,
  evaluate: (expression: string) => Promise<unknown>,
  element: string,
): Promise<void> {
  const box = (await evaluate(`(() => {
    const element = ${element};
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`)) as { x: number; y: number } | null;
  if (box === null) throw new Error(`no element for ${element}`);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, ...box, button: "left", clickCount: 1 });
  }
}

/**
 * Measures the motion of Tracking, with the pointer off the list:
 *
 * - opening it with `T`, and closing it with `T`;
 * - a state change: a Working row's run is cancelled, which makes it Stopped;
 * - a handoff: a signal that offers Review PR is handed to it from the pane,
 *   and its row flies to folded Tracking;
 * - a tick-off: `E` on the Finished row that handoff made once its run ends.
 *
 * Fails when To do does not settle on `SIGNALS_BEFORE_HANDOFF` signals within
 * 10 s, and as `measureListChange` fails.
 */
async function measureTrackingMotion(
  page: Inspector,
  fixture: ThreadFixture,
  seeded: SeededTracking,
  evaluate: (expression: string) => Promise<unknown>,
  waitInPage: (expression: string, timeoutMessage: string) => Promise<void>,
): Promise<NonNullable<TrackingWork["motion"]>> {
  const rows = `${SIGNALS_LIST} .ask-row`;
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...POINTER_OFF_LIST });
  // Clear To do down to a few signals, so the signals raised next land on screen.
  const { items } = await fixture.call<{ readonly items: readonly { readonly id: string }[] }>(
    "GET",
    "/signals?view=to-do",
  );
  await fixture.call("POST", "/signals/mark-done", {
    signalIds: items.slice(SIGNALS_BEFORE_HANDOFF).map((signal) => signal.id),
  });
  await waitInPage(
    `document.querySelectorAll(${JSON.stringify(rows)}).length === ${String(SIGNALS_BEFORE_HANDOFF)} &&
      document.getAnimations().length === 0`,
    "To do did not settle on the signals left",
  );
  const trayIsOpen = `document.querySelector(${JSON.stringify(`${TRAY}.is-open`)}) !== null`;

  await clickElement(page, evaluate, `document.querySelector(${JSON.stringify(rows)})`);
  await waitInPage(
    `document.querySelector(${JSON.stringify(`${rows}[aria-current="true"]`)}) !== null`,
    "a click on a signal did not select it",
  );
  // Esc closes the pane and a second Esc clears the selection, so neither
  // the split's width nor the row's selection moves while Tracking opens.
  await pressKey(page, "Escape");
  await sleep(PUSH_SETTLE_MS);
  await pressKey(page, "Escape");
  await sleep(PUSH_SETTLE_MS);
  const open = await measureListChange(page, {
    change: () => pressKey(page, "t"),
    lengthMs: 450,
    endsWhen: trayIsOpen,
    mustSee: trayIsOpen,
  });
  await sleep(PUSH_SETTLE_MS);
  const close = await measureListChange(page, {
    change: () => pressKey(page, "t"),
    lengthMs: 180,
    endsWhen: `!(${trayIsOpen})`,
    mustSee: `!(${trayIsOpen})`,
  });
  await sleep(PUSH_SETTLE_MS);

  // A change the user did not make is held while the pointer is on the list column,
  // and the clicks above left it there.
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...POINTER_OFF_LIST });
  await sleep(500);
  const stoppedRows = `document.querySelectorAll('${TRAY} .tr-run-item[data-state="stopped"]').length`;
  const stoppedBefore = (await evaluate(stoppedRows)) as number;
  const stateChange = await measureListChange(page, {
    change: async () => {
      await fixture.call("POST", `/runs/${seeded.liveRunIds[0]!}/cancel`, {});
    },
    lengthMs: 180,
    endsWhen: `${stoppedRows} > ${String(stoppedBefore)}`,
    mustSee: `${stoppedRows} > ${String(stoppedBefore)}`,
  });
  await sleep(PUSH_SETTLE_MS);

  const handedOffTitle = "Handed off while measured";
  await raiseSignal(fixture, handedOffTitle);
  const handedOffRow = `[...document.querySelectorAll(${JSON.stringify(rows)})].find((row) => row.querySelector(".ask-title")?.textContent === ${JSON.stringify(handedOffTitle)})`;
  await waitInPage(
    `(${handedOffRow}) !== undefined`,
    "the signal to hand off did not land on screen",
  );
  await clickElement(page, evaluate, handedOffRow);
  await waitInPage(
    `(${handedOffRow})?.getAttribute("aria-current") === "true"`,
    "a click on the signal to hand off did not select it",
  );
  await sleep(PUSH_SETTLE_MS);
  const inTracking = `[...document.querySelectorAll("${TRAY} .tr-run-title")].some((title) => title.textContent === ${JSON.stringify(handedOffTitle)})`;
  const handoff = await measureListChange(page, {
    change: () =>
      clickElement(
        page,
        evaluate,
        `document.querySelector('button[aria-label="Hand to Review PR"]')`,
      ),
    lengthMs: 320,
    endsWhen: inTracking,
    mustSee: inTracking,
  });
  const trackedRow = `[...document.querySelectorAll("${TRAY} .tr-run-item")].find((row) => row.querySelector(".tr-run-title")?.textContent === ${JSON.stringify(handedOffTitle)})`;
  await waitInPage(
    `(${trackedRow})?.getAttribute("data-state") === "finished"`,
    "the handed-off row did not finish",
  );
  await sleep(PUSH_SETTLE_MS);
  await evaluate(`(${trackedRow}).querySelector(".tr-run").focus()`);
  const tickOff = await measureListChange(page, {
    change: () => pressKey(page, "e"),
    lengthMs: 180,
    endsWhen: `!(${inTracking})`,
    mustSee: `!(${inTracking})`,
  });
  return { open, close, stateChange, handoff, tickOff };
}

/**
 * Whether no step of a plan is a scan of a whole table. A step that scans an
 * index (`SCAN ... USING ... INDEX`) is allowed: the index here holds only
 * the handoff entries, or only the runs of Tasks.
 */
const usesIndexOnly = (plan: readonly string[]): boolean =>
  plan.every((step) => !step.startsWith("SCAN ") || step.includes(" USING "));

/** Formats one read's timing as a table cell. */
const formatTimedRead = (read: TimedRead): string =>
  `${read.name} ${read.durationMs.toFixed(1)} ms (${read.waitMs.toFixed(1)} ms to the first byte, ${String(read.bytes)} bytes), started ${read.startMs.toFixed(0)} ms after the page opened`;

/** Formats a series of pushes as a table cell. */
const formatPushes = ({ pushes, reads, mainThreadMs }: PushCost): string =>
  `${String(pushes)} pushes received for ${String(PUSH_COUNT)} changes; requests: ` +
  `${String(reads.trackedTasks)} task.query, ${String(reads.trackedRuns)} run.query, ` +
  `${String(reads.runReads)} run.read, ${String(reads.other)} other; ` +
  `renderer main thread ${(mainThreadMs / PUSH_COUNT).toFixed(1)} ms a change`;

/** Prints what the Tracking scenario measured, against the planned costs in spec 17. */
export function reportTrackingWork(
  work: readonly TrackingWork[],
  reads: readonly { readonly label: string; readonly cost: ReadCost }[],
): void {
  console.log("## Tracking");
  console.log();
  console.log("### The two reads on the controller");
  console.log();
  console.log(
    formatTable(
      ["Tracked Tasks", "Runs", "task.query, median", "run.query, median", "Plans"],
      reads.map(({ label, cost }) => [
        label,
        String(cost.runCount),
        `${cost.tasksMs.toFixed(1)} ms`,
        `${cost.runsMs.toFixed(1)} ms`,
        usesIndexOnly(cost.plans.tasks) && usesIndexOnly(cost.plans.runs)
          ? "indexes only"
          : "A FULL SCAN",
      ]),
    ),
  );
  for (const { label, cost } of reads) {
    console.log();
    console.log(`Plan of task.query, ${label}:`);
    for (const step of cost.plans.tasks) console.log(`  ${step}`);
    console.log(`Plan of run.query, ${label}:`);
    for (const step of cost.plans.runs) console.log(`  ${step}`);
  }
  for (const each of work) {
    console.log();
    console.log(`### In the app, ${each.label}`);
    console.log();
    console.log(`Load average over the minute before the launch: ${each.loadAtSpawn.toFixed(2)}`);
    console.log();
    const motion = each.motion;
    // Row, limit, measured, and whether the measurement is within the limit,
    // or null for a measure that is recorded but has no limit.
    const rows: [string, string, string, boolean | null][] = [
      [
        "Reads while the shell loads",
        each.tracked === 0
          ? "up to 3 snapshot reads (the first task and run pushes may each re-read), each only a task.query: no Task, so no run.query"
          : "up to 3 snapshot reads (the first task and run pushes may each re-read), each one task.query and one run.query for each 100 Tasks; one run.read per Failed row once it has been in view",
        each.loadReads.length === 0 ? "none" : each.loadReads.map(formatTimedRead).join("; "),
        (() => {
          const taskQueries = each.loadReads.filter((read) => read.name === "task.query").length;
          const runQueries = each.loadReads.filter((read) => read.name === "run.query").length;
          return (
            taskQueries >= 1 &&
            taskQueries <= 3 &&
            runQueries === (each.tracked === 0 ? 0 : taskQueries)
          );
        })(),
      ],
      [
        "A Task created: a push on the task topic",
        each.tracked === 0
          ? "a task.query once a push, and no run.query while no Task is tracked"
          : "one snapshot (task.query and run.query) once a push",
        formatPushes(each.taskPushes),
        each.tracked === 0
          ? each.taskPushes.reads.trackedRuns === 0 &&
            each.taskPushes.reads.trackedTasks <= each.taskPushes.pushes
          : each.taskPushes.reads.trackedTasks <= each.taskPushes.pushes &&
            each.taskPushes.reads.trackedRuns === each.taskPushes.reads.trackedTasks,
      ],
      [
        "A run that is not about a Task: pushes on the run topic",
        each.tracked === 0
          ? "no run.query while no Task is tracked"
          : "one snapshot for each run's creation, and nothing for its later pushes",
        formatPushes(each.runPushes),
        each.tracked === 0
          ? each.runPushes.reads.trackedRuns === 0
          : each.runPushes.reads.trackedTasks <= PUSH_COUNT &&
            each.runPushes.reads.trackedRuns === each.runPushes.reads.trackedTasks,
      ],
      ...(motion === undefined
        ? []
        : ([
            [
              "Opening Tracking with T",
              "one animation for the sheet, at most 13 for the cascade, done within 450 ms; transform and opacity only",
              `${formatMotion(motion.open)}; properties ${motion.open.properties.join(", ")}; animations: ${motion.open.kinds.join("; ")}`,
              motion.open.animations <= 14 &&
                motion.open.motionMs <= 450 &&
                motion.open.properties.every((p) => ["opacity", "transform"].includes(p)) &&
                droppedNoMotionFrame(motion.open) &&
                isStillAfter(motion.open),
            ],
            [
              "Closing Tracking with T",
              "one animation, 180 ms",
              `${formatMotion(motion.close)}; properties ${motion.close.properties.join(", ")}; animations: ${motion.close.kinds.join("; ")}`,
              motion.close.animations === 1 &&
                droppedNoMotionFrame(motion.close) &&
                isStillAfter(motion.close),
            ],
            [
              "A state change: a Working row stops",
              "one opacity animation, plus one transform per row that moves",
              `${formatMotion(motion.stateChange)}; properties ${motion.stateChange.properties.join(", ")}; animations: ${motion.stateChange.kinds.join("; ")}`,
              motion.stateChange.properties.every((p) => ["opacity", "transform"].includes(p)) &&
                isStillAfter(motion.stateChange),
            ],
            [
              "A handoff from the pane",
              "one animation for the lifted copy, plus one transform per row that moves on screen",
              `${formatMotion(motion.handoff)}; properties ${motion.handoff.properties.join(", ")}; animations: ${motion.handoff.kinds.join("; ")}`,
              motion.handoff.properties.every((p) => ["opacity", "transform"].includes(p)) &&
                isStillAfter(motion.handoff),
            ],
            [
              "A tick-off with E on a Finished row",
              "one opacity animation, plus one transform per row that moves",
              `${formatMotion(motion.tickOff)}; properties ${motion.tickOff.properties.join(", ")}; animations: ${motion.tickOff.kinds.join("; ")}`,
              motion.tickOff.properties.every((p) => ["opacity", "transform"].includes(p)) &&
                isStillAfter(motion.tickOff),
            ],
          ] satisfies [string, string, string, boolean | null][])),
    ];
    console.log(
      formatTable(
        ["Row", "Limit", "Measured", "Within"],
        rows.map(([row, limit, measuredText, within]) => [
          row,
          limit,
          measuredText,
          within === null ? "-" : within ? "yes" : "over",
        ]),
      ),
    );
  }
  console.log();
}
