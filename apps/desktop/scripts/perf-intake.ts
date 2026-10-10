/**
 * The desktop perf script's Intake scenario. `perf.ts` measures memory and
 * idle with Intake open as one of its measured launches, on the 200 signals
 * `raiseSignals` raises. This file then measures, in one more plain launch on
 * Intake, the rows of spec 17 §What Intake costs that need something to
 * happen:
 *
 * - what one signal raised costs, over 20 raised 1 s apart: the renderer's
 *   main thread and CPU, the controller's CPU, and how often the page reads
 *   To do again;
 * - what a burst of 30 signals raised at once costs: the renderer's longest
 *   task and the reads of To do;
 * - what opening and closing the split costs: the renderer's longest task
 *   and the frames the page drew while the split's transition ran, with the
 *   250 rows the steps above leave in the list.
 *
 * To do is sorted oldest first, so a raised signal lands below the rows on
 * screen. The per-push cost is then the read and the list's render, with no
 * row on screen to animate. The Performance panel rows of the cost table,
 * the per-push animation and inbox zero, are not measured here.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import type { SignalRaiseResult } from "../../../packages/contract/src/index";
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
  BUDGET,
  findRendererMainTasks,
  openScreenOnce,
  readCpuMs,
  readProcessMemory,
  readTrace,
  TIMELINE_CATEGORY,
  waitForPageSocketUrl,
} from "./perf-measures.ts";
import { pollUntil } from "./poll.ts";

/** How many signals are on To do when Intake is measured. */
export const INTAKE_SIGNALS = 200;

/** How many signals are raised one at a time, and how far apart. */
const PUSH_COUNT = 20;
const PUSH_INTERVAL_MS = 1_000;

/** How long after the last push the reading ends, so the last read and render are in it. */
const PUSH_SETTLE_MS = 2_000;

/** How many signals the burst raises at once. */
const BURST_SIZE = 30;

/**
 * How long the launch rests after Intake has shown, before the first push,
 * so the launch's own work is over.
 */
const LAUNCH_SETTLE_MS = 5_000;

/** Intake's list of signals, which holds one `.ask-row` for each row it draws. */
const SIGNALS_LIST = 'section[aria-label="Signals"]';

/** The header's button that opens and closes the split's pane. */
const PANE_TOGGLE = ".asks-pane-btn";

/**
 * Returns an expression that evaluates, in the page, to whether Intake shows
 * its list and the sidebar's Hercule segment counts `count` signals on To do.
 * The list is virtualized, so its rows cannot be counted; the segment counts
 * the whole of To do.
 */
const buildIntakeShown = (count: number) => `(() => {
  const segments = [...document.querySelectorAll('[role="tablist"][aria-label="Sidebar"] [role="tab"]')];
  return document.querySelector(${JSON.stringify(`${SIGNALS_LIST} .ask-row`)}) !== null &&
    segments.some((segment) => segment.getAttribute("aria-label") === "Hercule, ${String(count)} to do");
})()`;

/**
 * Raises `count` signals through `signal.raise`, one after another, titled
 * `title` and their number (see `raiseSignal`). Fails when the controller
 * refuses one.
 */
export async function raiseSignals(
  fixture: ThreadFixture,
  count: number,
  title: string,
): Promise<void> {
  for (let number = 1; number <= count; number += 1) {
    await raiseSignal(fixture, `${title} ${String(number)}`);
  }
}

/**
 * Raises one signal of the kind `fyi` titled `title` through `signal.raise`.
 * Fails when the controller refuses it.
 *
 * The signal names no event: no plugin in the perf script's controller emits
 * one, and the contract allows an empty list.
 */
async function raiseSignal(fixture: ThreadFixture, title: string): Promise<void> {
  await fixture.call<SignalRaiseResult>("POST", "/signals/raise", {
    kind: "fyi",
    title,
    reason: "Raised by the perf script",
    eventIds: [],
  });
}

/**
 * Opens Intake once in the signed-in app on `userDataDir`, so the app opens
 * it again at its next launch (see `openScreenOnce`). Fails when Intake's
 * list does not show a row.
 */
export const openIntakeOnce = (userDataDir: string): Promise<void> =>
  openScreenOnce(userDataDir, "/intake", (page: Page) =>
    page.locator(`${SIGNALS_LIST} .ask-row`).first().waitFor(),
  );

/** What the signals raised one at a time cost, summed over all of them. */
interface PushCost {
  /** The controller process's CPU time, in milliseconds. */
  readonly controllerCpuMs: number;
  /** The renderer process's CPU time, all of its threads, in milliseconds. */
  readonly rendererCpuMs: number;
  /** The time the renderer's main thread spent running tasks, in milliseconds. */
  readonly rendererMainThreadMs: number;
  /** How many times the page read To do. */
  readonly toDoReads: number;
}

/** What the burst of signals raised at once cost the renderer. */
interface BurstCost {
  /** The longest task the renderer's main thread ran, in milliseconds. */
  readonly longestTaskMs: number;
  /** How many of the main thread's tasks took over 50 ms. */
  readonly longTasks: number;
  /** How many times the page read To do. */
  readonly toDoReads: number;
}

/** What opening or closing the split cost the renderer while its transition ran. */
interface SplitCost {
  /** The longest task the renderer's main thread ran, in milliseconds. */
  readonly longestTaskMs: number;
  /** How long the transition runs, `--dur-3`, in milliseconds. */
  readonly transitionMs: number;
  /** How many frames the page drew, from the click's frame to one past the transition. */
  readonly frames: number;
  /** The longest time between two frames, in milliseconds. */
  readonly longestFrameGapMs: number;
  /** The usual time between two frames, the median, in milliseconds. */
  readonly frameIntervalMs: number;
}

/** What the Intake scenario measured. */
export interface IntakeWork {
  /** The machine's load average over the minute before the app was spawned. */
  readonly loadAtSpawn: number;
  readonly pushes: PushCost;
  readonly burst: BurstCost;
  readonly splitOpen: SplitCost;
  readonly splitClose: SplitCost;
}

/**
 * Starts the signed-in app on `userDataDir` as a plain process, where it
 * opens Intake again on `INTAKE_SIGNALS` signals, and measures what Intake
 * does when signals are raised and when its split opens and closes. Returns
 * the costs, in this order:
 *
 * - 20 signals raised 1 s apart: the controller's and the renderer's CPU
 *   time with `ps`, and the renderer main thread's time from the page's
 *   DevTools performance metrics, over the 22 s from the first raise to 2 s
 *   after the last. Each also holds whatever the process did while idle in
 *   that time, so the numbers err high;
 * - 30 signals raised at once: a Chromium trace from the first raise until
 *   the Hercule segment counts them all, plus 2 s;
 * - the split opened and then closed with the header's button: for each, a
 *   trace and the page's animation frames from the click until one frame
 *   after the transition's `--dur-3` is over.
 *
 * The reads of To do are counted from the page's resource timing entries.
 * One connection to the page serves the whole scenario. The window stays
 * shown throughout.
 *
 * Fails when Intake does not show with its signals within 15 s, when the
 * segment does not count a raised signal within 10 s, when the split does
 * not open or close, when the split has no transition to measure, when a
 * trace lost events, or when the app does not quit cleanly afterwards.
 */
export async function measureIntakeWork(
  userDataDir: string,
  fixture: ThreadFixture,
): Promise<IntakeWork> {
  const loadAtSpawn = loadavg()[0]!;
  const app = await launchPlainApp(userDataDir);
  let measured: IntakeWork;
  try {
    const page = await connectInspector(await waitForPageSocketUrl(app.endpoint));
    try {
      const evaluate = (expression: string) =>
        page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
      const waitInPage = (expression: string, timeoutMs: number, timeoutMessage: string) =>
        pollUntil(async () => ((await evaluate(expression)) === true ? true : undefined), {
          timeoutMs,
          intervalMs: 50,
          timeoutMessage,
        });
      let onToDo = INTAKE_SIGNALS;
      await waitInPage(
        buildIntakeShown(onToDo),
        15_000,
        `the app did not open Intake on ${String(onToDo)} signals`,
      );
      await sleep(LAUNCH_SETTLE_MS);

      const memory = await readProcessMemory(app.process.pid!);
      const rendererPid = memory.find((sample) => sample.label === "Tab")?.pid;
      if (rendererPid === undefined) throw new Error("the app has no renderer process");
      const controllerPid = fixture.readControllerPid();
      await page.send("Performance.enable");
      const readMainThreadMs = async () => {
        const { metrics } = (await page.send("Performance.getMetrics")) as {
          metrics: { name: string; value: number }[];
        };
        const seconds = metrics.find((metric) => metric.name === "TaskDuration")?.value;
        if (seconds === undefined) throw new Error("the page reports no TaskDuration metric");
        return seconds * 1_000;
      };
      const readPageNow = async () => (await evaluate("performance.now()")) as number;
      const countToDoReads = async (from: number) =>
        (await evaluate(`performance.getEntriesByType("resource").filter((entry) => {
          const url = new URL(entry.name);
          return entry.startTime >= ${String(from)} &&
            url.pathname === "/api/v1/signals" && url.searchParams.get("view") === "to-do";
        }).length`)) as number;

      const pushesFrom = await readPageNow();
      const before = {
        controller: await readCpuMs(controllerPid),
        renderer: await readCpuMs(rendererPid),
        mainThread: await readMainThreadMs(),
      };
      for (let push = 1; push <= PUSH_COUNT; push += 1) {
        await raiseSignal(fixture, `Pushed signal ${String(push)}`);
        await sleep(PUSH_INTERVAL_MS);
      }
      await sleep(PUSH_SETTLE_MS);
      const after = {
        controller: await readCpuMs(controllerPid),
        renderer: await readCpuMs(rendererPid),
        mainThread: await readMainThreadMs(),
      };
      const pushes: PushCost = {
        controllerCpuMs: after.controller - before.controller,
        rendererCpuMs: after.renderer - before.renderer,
        rendererMainThreadMs: after.mainThread - before.mainThread,
        toDoReads: await countToDoReads(pushesFrom),
      };
      onToDo += PUSH_COUNT;
      await waitInPage(
        buildIntakeShown(onToDo),
        10_000,
        `the Hercule segment did not count the ${String(PUSH_COUNT)} signals raised one at a time`,
      );

      const burstFrom = await readPageNow();
      const burstTasks = await traceRendererTasks(page, async () => {
        await Promise.all(
          Array.from({ length: BURST_SIZE }, (_, index) =>
            raiseSignal(fixture, `Burst signal ${String(index + 1)}`),
          ),
        );
        onToDo += BURST_SIZE;
        await waitInPage(
          buildIntakeShown(onToDo),
          10_000,
          `the Hercule segment did not count the burst of ${String(BURST_SIZE)} signals`,
        );
        await sleep(PUSH_SETTLE_MS);
      });
      const burst: BurstCost = {
        longestTaskMs: Math.max(...burstTasks),
        longTasks: burstTasks.filter((ms) => ms > BUDGET.streamingTaskMs).length,
        toDoReads: await countToDoReads(burstFrom),
      };

      const splitOpen = await measureSplitToggle(page, true);
      await sleep(PUSH_SETTLE_MS);
      const splitClose = await measureSplitToggle(page, false);
      measured = { loadAtSpawn, pushes, burst, splitOpen, splitClose };
    } finally {
      page.close();
    }
  } finally {
    await stopPlainApp(app);
  }
  assertExitedCleanly(app.process);
  return measured;
}

/**
 * Records a Chromium trace on `page` while `work` runs, and returns how long
 * each task of the renderer's main thread took, in milliseconds. Tracing
 * costs the renderer a little time of its own, so the tasks err long. Fails
 * when the trace lost events.
 */
async function traceRendererTasks(page: Inspector, work: () => Promise<void>): Promise<number[]> {
  await page.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: { includedCategories: [TIMELINE_CATEGORY] },
  });
  await work();
  await page.send("Tracing.end");
  return findRendererMainTasks(await readTrace(page)).map((event) => event.dur! / 1_000);
}

/**
 * Clicks the split's toggle on `page`, which opens the pane when `opens` is
 * set and closes it otherwise, and returns what the transition cost: the
 * renderer's tasks from a trace, and the gaps between the frames the page
 * drew from the click until one frame after `--dur-3`, the transition's
 * length, is over. Fails when `--dur-3` is 0, as under Reduce motion, because
 * there is then no transition to measure, and when the pane is not in the
 * state `opens` asks for afterwards.
 *
 * The click runs inside an animation frame callback, so the first frame
 * recorded is the one that starts the transition, and the first gap holds
 * that frame's work.
 */
async function measureSplitToggle(page: Inspector, opens: boolean): Promise<SplitCost> {
  const evaluate = (expression: string) =>
    page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
  const transitionMs = (await evaluate(`(() => {
    const value = getComputedStyle(document.documentElement).getPropertyValue("--dur-3").trim();
    return value.endsWith("ms") ? parseFloat(value) : parseFloat(value) * 1000;
  })()`)) as number;
  if (!(transitionMs > 0)) {
    throw new Error(
      `--dur-3 is ${String(transitionMs)} ms, so the split does not animate. Turn Reduce motion off and run the script again.`,
    );
  }
  const tasks = await traceRendererTasks(page, async () => {
    await evaluate(`(() => {
      const frames = [];
      globalThis.splitFrames = frames;
      let until;
      const record = (at) => {
        frames.push(at);
        if (until === undefined) {
          until = at + ${String(transitionMs)};
          document.querySelector(${JSON.stringify(PANE_TOGGLE)}).click();
        }
        // One frame past the transition's end, so the gap into the frame
        // that draws its last state is measured too.
        if (at <= until) requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    })()`);
    await sleep(transitionMs + 200);
  });
  const shown = await evaluate(`document.querySelector(".asks.has-pane") !== null`);
  if (shown !== opens) {
    throw new Error(
      `the split's pane did not ${opens ? "open" : "close"} on a click on its button`,
    );
  }
  const frames = (await evaluate("globalThis.splitFrames")) as number[];
  const gaps = frames.slice(1).map((at, index) => at - frames[index]!);
  const sorted = gaps.toSorted((a, b) => a - b);
  return {
    longestTaskMs: Math.max(...tasks),
    transitionMs,
    frames: frames.length,
    longestFrameGapMs: sorted.at(-1) ?? 0,
    frameIntervalMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
  };
}

/**
 * Whether a split's frames dropped none: no gap between two frames is half
 * again as long as the usual one. A dropped frame makes a gap of two usual
 * ones.
 */
const droppedNoFrame = (cost: SplitCost) => cost.longestFrameGapMs < 1.5 * cost.frameIntervalMs;

/** Formats a cost of all the pushes as the cost of one, with the total after it. */
const formatPerPush = (totalMs: number) =>
  `${(totalMs / PUSH_COUNT).toFixed(1)} ms a push (${totalMs.toFixed(0)} ms for ${String(PUSH_COUNT)})`;

/** Formats a split's cost as one table cell. */
const formatSplit = (cost: SplitCost) =>
  `longest task ${cost.longestTaskMs.toFixed(1)} ms; ${String(cost.frames)} frames over the ` +
  `${cost.transitionMs.toFixed(0)} ms transition, ` +
  `longest gap ${cost.longestFrameGapMs.toFixed(1)} ms against ${cost.frameIntervalMs.toFixed(1)} ms usual`;

/** Prints what the Intake scenario measured, against the limits spec 17 sets. */
export function reportIntakeWork(measured: IntakeWork): void {
  const { pushes, burst, splitOpen, splitClose } = measured;
  // Budget, limit, measured, and whether the measurement is within the
  // limit, or null for a measure that is recorded but has no budget.
  const budgets: [string, string, string, boolean | null][] = [
    [
      "Per push, renderer main thread",
      `recorded; the thread list's nudge limit is ${String(BUDGET.rendererMainThreadPerNudgeMs)} ms`,
      formatPerPush(pushes.rendererMainThreadMs),
      null,
    ],
    ["Per push, renderer CPU", "recorded; not budgeted", formatPerPush(pushes.rendererCpuMs), null],
    [
      "Per push, controller CPU",
      "recorded; not budgeted",
      formatPerPush(pushes.controllerCpuMs),
      null,
    ],
    [
      "Per push, To do reads",
      "To do read whole, once a push",
      `${String(pushes.toDoReads)} for ${String(PUSH_COUNT)} pushes`,
      pushes.toDoReads <= PUSH_COUNT,
    ],
    [
      `Burst of ${String(BURST_SIZE)}, renderer main thread`,
      `recorded; streaming's limit is no task over ${String(BUDGET.streamingTaskMs)} ms`,
      `longest task ${burst.longestTaskMs.toFixed(1)} ms (${String(burst.longTasks)} over ${String(BUDGET.streamingTaskMs)} ms)`,
      null,
    ],
    [
      `Burst of ${String(BURST_SIZE)}, To do reads`,
      "recorded; not budgeted",
      String(burst.toDoReads),
      null,
    ],
    [
      `Opening the split, ${String(INTAKE_SIGNALS + PUSH_COUNT + BURST_SIZE)} rows`,
      "no dropped frame",
      formatSplit(splitOpen),
      droppedNoFrame(splitOpen),
    ],
    [
      `Closing the split, ${String(INTAKE_SIGNALS + PUSH_COUNT + BURST_SIZE)} rows`,
      "no dropped frame",
      formatSplit(splitClose),
      droppedNoFrame(splitClose),
    ],
  ];

  console.log(`## Intake at work, opened on ${String(INTAKE_SIGNALS)} signals`);
  console.log();
  console.log(`Load average over the minute before the launch: ${measured.loadAtSpawn.toFixed(2)}`);
  console.log();
  console.log(
    formatTable(
      ["Budget", "Limit", "Measured", "Within"],
      budgets.map(([budget, limit, measuredText, within]) => [
        budget,
        limit,
        measuredText,
        within === null ? "-" : within ? "yes" : "over",
      ]),
    ),
  );
  console.log();
}
