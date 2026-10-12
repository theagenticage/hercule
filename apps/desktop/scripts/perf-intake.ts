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
 * - what opening and closing the split costs: the renderer's longest task,
 *   how long after the click the transition starts, and the frames the page
 *   drew while the transition ran, with the 250 rows the steps above leave
 *   in the list;
 * - what the list's motion costs on screen: one signal arriving, a burst of
 *   30 arriving, and inbox zero after the user's own Done of the last
 *   signal. For each: the frames drawn and the longest gap between them, the
 *   renderer main thread's time and longest task, and what still runs once
 *   the motion is over (see `measureRowMotion`).
 *
 * To do is sorted oldest first, so a signal raised in the steps before the
 * motion lands below the rows on screen, and their cost is the read and the
 * list's render, with no row on screen to animate. The motion steps first
 * clear To do down to a few signals, so their arrivals land on screen.
 *
 * A second scenario, `measureEverythingWork`, measures Everything on 1,000
 * events (see `seedEvents`): opening the view, scrolling the list to its end,
 * and the memory after.
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
  type TraceEvent,
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
 * Raises one signal and snoozes it for an hour, so Intake runs its snooze
 * timer while the perf script reads it idle. The signal waits on Later, so To
 * do still holds the signals `raiseSignals` raised and no more. Fails when
 * the controller refuses either call.
 */
export async function raiseSnoozedSignal(fixture: ThreadFixture): Promise<void> {
  const { signalId } = await raiseSignal(fixture, "Snoozed signal");
  await fixture.call("POST", "/signals/snooze", {
    signalIds: [signalId],
    until: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

/**
 * Raises one signal of the kind `fyi` titled `title` through `signal.raise`,
 * and returns its id. Fails when the controller refuses it.
 *
 * The signal names no event: no plugin in the perf script's controller emits
 * one, and the contract allows an empty list.
 */
async function raiseSignal(fixture: ThreadFixture, title: string): Promise<SignalRaiseResult> {
  return await fixture.call<SignalRaiseResult>("POST", "/signals/raise", {
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

/** What opening or closing the split cost the renderer, from the click to the transition's end. */
interface SplitCost {
  /** The longest task the renderer's main thread ran, in milliseconds. */
  readonly longestTaskMs: number;
  /**
   * How long after the click's frame the transition's first frame began, in
   * milliseconds. The split moves a frame after the frame that draws the
   * click, so this is a few frames.
   */
  readonly startDelayMs: number;
  /** The longest time between two frames before the transition began, in milliseconds. */
  readonly longestGapBeforeMs: number;
  /** How long the transition runs, `--dur-3`, in milliseconds. */
  readonly transitionMs: number;
  /** How many frames the page drew, from the transition's first frame to one past its end. */
  readonly frames: number;
  /** The longest time between two of those frames, in milliseconds. */
  readonly longestFrameGapMs: number;
  /** The usual time between two of those frames, the median, in milliseconds. */
  readonly frameIntervalMs: number;
}

/**
 * What one change to Intake's list cost while it moved on screen, from the
 * change until the last of its animations ended, and in the second after.
 */
interface MotionCost {
  /** How many signals were on screen when the change began, before it. */
  readonly rowsBefore: number;
  /** How long the motion ran, from its first frame to the frame that found no animation left, in milliseconds. */
  readonly motionMs: number;
  /** How many frames the page drew over the motion, both ends included. */
  readonly frames: number;
  /** The longest time between two of those frames, in milliseconds. */
  readonly longestFrameGapMs: number;
  /** The usual time between two of those frames, the median, in milliseconds. */
  readonly frameIntervalMs: number;
  /**
   * How many different start times the change's animations had. Rows that
   * start together move as one block, so a burst should have one, and its
   * leaving rows' fade at most one more.
   */
  readonly starts: number;
  /** How many animations the change ran on Intake. */
  readonly animations: number;
  /** The time the renderer's main thread spent running tasks, from the change to the motion's end, in milliseconds. */
  readonly mainThreadMs: number;
  /** The longest of those tasks, in milliseconds. */
  readonly longestTaskMs: number;
  /**
   * How long the spec gives the motion, in milliseconds: `--dur-2` for rows,
   * 800 ms plus the pane's 320 ms wait for inbox zero's arrival.
   */
  readonly lengthMs: number;
  /**
   * How long after the motion's first frame the renderer's main thread drew
   * its last frame, up to a second after the motion ended, in milliseconds.
   */
  readonly lastFrameMs: number;
  /** How many frames the renderer's main thread drew in the second after the motion. */
  readonly framesAfter: number;
  /** The time the renderer's main thread spent running tasks in that second, in milliseconds. */
  readonly mainThreadAfterMs: number;
  /** The longest of those tasks, in milliseconds. */
  readonly longestTaskAfterMs: number;
  /** How many animations the page still held, in any state, when the recording ended. */
  readonly animationsAfter: number;
  /** How many leaving rows' copies the ghost layer still held when the recording ended. */
  readonly ghostsAfter: number;
}

/** What the Intake scenario measured. */
export interface IntakeWork {
  /** The machine's load average over the minute before the app was spawned. */
  readonly loadAtSpawn: number;
  readonly pushes: PushCost;
  readonly burst: BurstCost;
  readonly splitOpen: SplitCost;
  readonly splitClose: SplitCost;
  /** One signal raised elsewhere that lands on screen. */
  readonly arrival: MotionCost;
  /** `BURST_SIZE` signals raised elsewhere at once, landing on screen. */
  readonly arrivalBurst: MotionCost;
  /** The user's own Done of the last signal on To do, which brings inbox zero. */
  readonly inboxZero: MotionCost;
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
 *   after the transition's `--dur-3` is over (see `measureSplitToggle`);
 * - the list's motion: one arrival and a burst landing on screen, and inbox
 *   zero arriving (see `measureRowMotion`).
 *
 * The reads of To do are counted from the page's resource timing entries.
 * One connection to the page serves the whole scenario. The window stays
 * shown throughout.
 *
 * Fails when Intake does not show with its signals within 15 s, when the
 * segment does not count a raised signal within 10 s, when the split does
 * not open or close, when the split has no transition to measure, when a
 * trace lost events, when a step of the list's motion fails (see
 * `measureRowMotion`), or when the app does not quit cleanly afterwards.
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
      await sleep(PUSH_SETTLE_MS);
      measured = {
        loadAtSpawn,
        pushes,
        burst,
        splitOpen,
        splitClose,
        ...(await measureRowMotion(page, fixture)),
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
 * set and closes it otherwise, and returns what that cost: the renderer's
 * tasks from a trace, and the page's animation frames from the click's frame
 * until one frame after `--dur-3`, the transition's length, is over from the
 * transition's first frame. Fails when `--dur-3` is 0, as under Reduce
 * motion, because there is then no transition to measure, and when the pane
 * is not in the state `opens` asks for afterwards.
 *
 * The click runs inside an animation frame callback, so the first frame
 * recorded is the click's. The gap after each frame holds that frame's work.
 * The transition's first frame is the first one that, once its callback
 * and the renders it caused have run, finds the split's `has-pane` class as
 * `opens` asks for: that frame's style starts the transition. The class
 * changes a frame after the frame that draws the click, so the gaps before
 * the transition, which hold the click's render, are reported apart from the
 * transition's own.
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
      globalThis.splitStart = undefined;
      let until;
      const record = (at) => {
        frames.push(at);
        if (frames.length === 1) document.querySelector(${JSON.stringify(PANE_TOGGLE)}).click();
        // React applies the click's render in a microtask, so the class is
        // read in one queued after it, still before this frame's style.
        queueMicrotask(() => {
          if (until === undefined && (document.querySelector(".asks.has-pane") !== null) === ${String(opens)}) {
            globalThis.splitStart = frames.length - 1;
            until = at + ${String(transitionMs)};
          }
          // One frame past the transition's end, so the gap into the frame
          // that draws its last state is measured too. A transition that
          // never starts stops the recording after a second.
          if (until === undefined ? at - frames[0] < 1000 : at <= until) requestAnimationFrame(record);
        });
      };
      requestAnimationFrame(record);
    })()`);
    await sleep(transitionMs + 400);
  });
  const shown = await evaluate(`document.querySelector(".asks.has-pane") !== null`);
  if (shown !== opens) {
    throw new Error(
      `the split's pane did not ${opens ? "open" : "close"} on a click on its button`,
    );
  }
  const frames = (await evaluate("globalThis.splitFrames")) as number[];
  const start = (await evaluate("globalThis.splitStart")) as number;
  const gaps = frames.slice(1).map((at, index) => at - frames[index]!);
  const transitionGaps = gaps.slice(start).toSorted((a, b) => a - b);
  return {
    longestTaskMs: Math.max(...tasks),
    startDelayMs: frames[start]! - frames[0]!,
    longestGapBeforeMs: Math.max(0, ...gaps.slice(0, start)),
    transitionMs,
    frames: frames.length - start,
    longestFrameGapMs: transitionGaps.at(-1) ?? 0,
    frameIntervalMs: transitionGaps[Math.floor(transitionGaps.length / 2)] ?? 0,
  };
}

/** How many signals stay on To do while signals arrive, so that each arrival lands on screen. */
const ROWS_BEFORE_ARRIVAL = 3;

/**
 * Where the pointer rests while signals arrive: over the sidebar, off
 * Intake's list. With the pointer over the list, Intake holds changes made
 * elsewhere until it leaves (spec 17 §Motion), so nothing would move.
 */
const POINTER_OFF_LIST = { x: 100, y: 400 };

/**
 * How long a measured change runs before its recording is read, in
 * milliseconds. It covers the change's request, the read it causes, the
 * longest motion (inbox zero's 1,120 ms) and the second after, so nothing
 * talks to the page while the second after the motion is recorded.
 */
const MOTION_RECORD_MS = 3_500;

/**
 * How long inbox zero's arrival runs here, as spec 17 §Motion sets it, in
 * milliseconds: 800 ms, after a wait of `--dur-3` (320 ms) for the pane to
 * close, because the measured Done is made with the pane open.
 */
const INBOX_ZERO_ARRIVAL_MS = 800 + 320;

/** The renderer's main thread draws a frame in each `BeginMainThreadFrame` event. */
const MAIN_THREAD_FRAME = "BeginMainThreadFrame";

/**
 * Measures how Intake's list moves on screen, after the scenario's other
 * steps, and returns what each change cost (see `measureListChange`):
 *
 * - one signal raised elsewhere, landing on screen;
 * - `BURST_SIZE` signals raised elsewhere at once, landing on screen;
 * - the user's own Done, with the E key, of the last signal on To do,
 *   which brings inbox zero.
 *
 * To do is sorted oldest first, so a raised signal lands below the rows on
 * screen. To land it on screen, `signal.markDone` first clears To do down to
 * `ROWS_BEFORE_ARRIVAL` signals, and before inbox zero down to one. The
 * pointer rests off the list while signals arrive. Fails when `--dur-2` is
 * 0, as under Reduce motion, because then nothing moves, when the list does
 * not show what a step asks for within 10 s, and when a change moves nothing.
 */
async function measureRowMotion(
  page: Inspector,
  fixture: ThreadFixture,
): Promise<Pick<IntakeWork, "arrival" | "arrivalBurst" | "inboxZero">> {
  const evaluate = (expression: string) =>
    page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
  const waitInPage = (expression: string, timeoutMessage: string) =>
    pollUntil(async () => ((await evaluate(expression)) === true ? true : undefined), {
      timeoutMs: 10_000,
      intervalMs: 50,
      timeoutMessage,
    });
  const rowsMs = (await evaluate(`(() => {
    const value = getComputedStyle(document.documentElement).getPropertyValue("--dur-2").trim();
    return value.endsWith("ms") ? parseFloat(value) : parseFloat(value) * 1000;
  })()`)) as number;
  if (!(rowsMs > 0)) {
    throw new Error(
      `--dur-2 is ${String(rowsMs)} ms, so Intake's rows do not move. Turn Reduce motion off and run the script again.`,
    );
  }
  const rows = `${SIGNALS_LIST} .ask-row`;
  const leaveOnToDo = async (count: number) => {
    const { items } = await fixture.call<{ readonly items: readonly { readonly id: string }[] }>(
      "GET",
      "/signals?view=to-do",
    );
    await fixture.call("POST", "/signals/mark-done", {
      signalIds: items.slice(count).map((signal) => signal.id),
    });
    await waitInPage(
      `document.querySelectorAll(${JSON.stringify(rows)}).length === ${String(count)} &&
        document.getAnimations().length === 0`,
      `Intake's list did not settle on ${String(count)} signals`,
    );
    await sleep(PUSH_SETTLE_MS);
  };
  // Whether a row whose title starts with the given text sits inside the
  // list's visible area.
  const countRowsOnScreen = (title: string) => `(() => {
    const view = document.querySelector(${JSON.stringify(`${SIGNALS_LIST} .asks-scroll`)}).getBoundingClientRect();
    return [...document.querySelectorAll(${JSON.stringify(rows)})].filter((row) => {
      const box = row.getBoundingClientRect();
      return row.querySelector(".ask-title")?.textContent.startsWith(${JSON.stringify(title)}) &&
        box.bottom > view.top && box.top < view.bottom;
    }).length;
  })()`;

  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...POINTER_OFF_LIST });
  await leaveOnToDo(ROWS_BEFORE_ARRIVAL);
  const arrival = await measureListChange(page, {
    change: async () => {
      await raiseSignal(fixture, "Arrived signal");
    },
    lengthMs: rowsMs,
    endsWhen: "true",
    mustSee: "true",
  });
  if ((await evaluate(countRowsOnScreen("Arrived signal"))) !== 1) {
    throw new Error("the arrived signal did not land on screen");
  }
  await sleep(PUSH_SETTLE_MS);
  const arrivalBurst = await measureListChange(page, {
    change: async () => {
      await Promise.all(
        Array.from({ length: BURST_SIZE }, (_, index) =>
          raiseSignal(fixture, `Arrived burst signal ${String(index + 1)}`),
        ),
      );
    },
    lengthMs: rowsMs,
    endsWhen: "true",
    mustSee: "true",
  });
  if (((await evaluate(countRowsOnScreen("Arrived burst signal"))) as number) === 0) {
    throw new Error("no signal of the burst landed on screen");
  }

  await leaveOnToDo(1);
  const box = (await evaluate(`(() => {
    const box = document.querySelector(${JSON.stringify(rows)}).getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`)) as { x: number; y: number };
  // A click selects the row and gives it the focus the keys need. The
  // pointer stays over the list, where a user who clicked leaves it.
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, ...box, button: "left", clickCount: 1 });
  }
  await waitInPage(
    `document.querySelector(${JSON.stringify(`${rows}[aria-current="true"]`)}) !== null`,
    "a click on the last signal did not select it",
  );
  await sleep(PUSH_SETTLE_MS);
  const inboxZero = await measureListChange(page, {
    change: async () => {
      for (const type of ["keyDown", "keyUp"]) {
        await page.send("Input.dispatchKeyEvent", {
          type,
          key: "e",
          code: "KeyE",
          windowsVirtualKeyCode: 69,
          ...(type === "keyDown" ? { text: "e" } : {}),
        });
      }
    },
    lengthMs: INBOX_ZERO_ARRIVAL_MS,
    endsWhen: `document.querySelector(".asks-zero") !== null`,
    mustSee: `document.querySelector(".asks-zero.is-arriving") !== null`,
  });
  return { arrival, arrivalBurst, inboxZero };
}

/** What `measureListChange` makes and checks. */
interface ListChange {
  /** Makes the change, from outside the page. */
  readonly change: () => Promise<void>;
  /** How long the spec gives the motion, in milliseconds. */
  readonly lengthMs: number;
  /**
   * An expression that evaluates, in the page, to whether the change has
   * drawn its end state. The motion ends at the first frame after the first
   * animation where it holds and no animation runs on Intake.
   */
  readonly endsWhen: string;
  /** An expression that must evaluate to true, in the page, in at least one frame of the motion. */
  readonly mustSee: string;
}

/**
 * Makes one change to Intake's list, and returns what the motion it caused
 * cost:
 *
 * - the page's animation frames, from the change until the motion's end,
 *   and the animations it ran on Intake, with their start times;
 * - the renderer main thread's tasks and frames from a Chromium trace,
 *   which runs from the change until `MOTION_RECORD_MS` after it;
 * - the animations and the ghost layer's copies left when the trace ends.
 *
 * Fails when the change moves nothing on Intake, when the motion does not end
 * within `MOTION_RECORD_MS`, when `mustSee` never held, or when the trace
 * lost events.
 *
 * The page marks the change, the motion's first frame and its end with
 * `console.timeStamp`, which puts a `TimeStamp` event in the trace, so the
 * trace can be split at them. The recording asks for every frame while it
 * runs, so the frames counted are those the page could draw, not only those
 * the motion needed. It stops at the motion's end, so the frames after it
 * are only those something else asked for.
 */
async function measureListChange(page: Inspector, measured: ListChange): Promise<MotionCost> {
  const evaluate = (expression: string) =>
    page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
  await page.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: {
      includedCategories: [
        TIMELINE_CATEGORY,
        "devtools.timeline",
        "disabled-by-default-devtools.timeline.frame",
      ],
    },
  });
  await evaluate(`(() => {
    const intake = document.querySelector(".asks");
    const record = {
      rowsBefore: document.querySelectorAll(${JSON.stringify(`${SIGNALS_LIST} .ask-row`)}).length,
      frames: [],
      first: undefined,
      last: undefined,
      starts: new Set(),
      animations: new Set(),
      sawExpected: false,
    };
    globalThis.motionRecord = record;
    const deadline = performance.now() + ${String(MOTION_RECORD_MS)};
    console.timeStamp("motion-change");
    const step = (at) => {
      const running = document
        .getAnimations()
        .filter((animation) => animation.playState === "running" && intake.contains(animation.effect?.target ?? null));
      for (const animation of running) {
        record.animations.add(animation);
        if (animation.startTime !== null) record.starts.add(Math.round(animation.startTime));
      }
      if (running.length > 0 && record.first === undefined) {
        record.first = record.frames.length;
        console.timeStamp("motion-first-frame");
      }
      if (${measured.mustSee}) record.sawExpected = true;
      record.frames.push(at);
      if (record.first !== undefined && running.length === 0 && (${measured.endsWhen})) {
        record.last = record.frames.length - 1;
        console.timeStamp("motion-end");
        return;
      }
      if (at < deadline) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  })()`);
  await measured.change();
  await sleep(MOTION_RECORD_MS);
  await page.send("Tracing.end");
  const events = await readTrace(page);
  const recorded = (await evaluate(`(() => {
    const record = globalThis.motionRecord;
    return {
      rowsBefore: record.rowsBefore,
      frames: record.first === undefined || record.last === undefined ? null : record.frames.slice(record.first, record.last + 1),
      starts: record.starts.size,
      animations: record.animations.size,
      sawExpected: record.sawExpected,
      animationsAfter: document.getAnimations().length,
      ghostsAfter: document.querySelector(".asks-ghosts")?.childElementCount ?? 0,
    };
  })()`)) as {
    rowsBefore: number;
    frames: number[] | null;
    starts: number;
    animations: number;
    sawExpected: boolean;
    animationsAfter: number;
    ghostsAfter: number;
  };
  if (recorded.frames === null) {
    throw new Error(
      recorded.animations === 0
        ? "the change moved nothing on Intake"
        : `the change was still moving ${String(MOTION_RECORD_MS)} ms after it was made`,
    );
  }
  if (!recorded.sawExpected) {
    throw new Error(`no frame of the motion found ${measured.mustSee}`);
  }
  const findMark = (message: string) => {
    const mark = events.find(
      (event) => event.name === "TimeStamp" && event.args?.data?.message === message,
    );
    if (mark === undefined) throw new Error(`the trace holds no "${message}" mark`);
    return mark.ts;
  };
  const changedAt = findMark("motion-change");
  const startedAt = findMark("motion-first-frame");
  const endedAt = findMark("motion-end");
  const afterEnd = endedAt + 1_000_000;
  const tasks = findRendererMainTasks(events);
  const mainThread = `${String(tasks[0]!.pid)}:${String(tasks[0]!.tid)}`;
  const isBetween = (event: TraceEvent, from: number, to: number) =>
    event.ts >= from && event.ts < to;
  const during = tasks.filter((task) => isBetween(task, changedAt, endedAt));
  const after = tasks.filter((task) => isBetween(task, endedAt, afterEnd));
  const frameStarts = events
    .filter(
      (event) =>
        event.name === MAIN_THREAD_FRAME &&
        `${String(event.pid)}:${String(event.tid)}` === mainThread &&
        isBetween(event, startedAt, afterEnd),
    )
    .map((event) => event.ts);
  const sumMs = (list: readonly TraceEvent[]) =>
    list.reduce((sum, task) => sum + task.dur! / 1_000, 0);
  const longestMs = (list: readonly TraceEvent[]) =>
    Math.max(0, ...list.map((task) => task.dur! / 1_000));
  const gaps = recorded.frames
    .slice(1)
    .map((at, index) => at - recorded.frames![index]!)
    .toSorted((a, b) => a - b);
  return {
    rowsBefore: recorded.rowsBefore,
    motionMs: recorded.frames.at(-1)! - recorded.frames[0]!,
    frames: recorded.frames.length,
    longestFrameGapMs: gaps.at(-1) ?? 0,
    frameIntervalMs: gaps[Math.floor(gaps.length / 2)] ?? 0,
    starts: recorded.starts,
    animations: recorded.animations,
    mainThreadMs: sumMs(during),
    longestTaskMs: longestMs(during),
    lengthMs: measured.lengthMs,
    lastFrameMs: (Math.max(startedAt, ...frameStarts) - startedAt) / 1_000,
    framesAfter: frameStarts.filter((at) => at >= endedAt).length,
    mainThreadAfterMs: sumMs(after),
    longestTaskAfterMs: longestMs(after),
    animationsAfter: recorded.animationsAfter,
    ghostsAfter: recorded.ghostsAfter,
  };
}

/**
 * Whether the split's transition dropped no frame: no gap between two of
 * its frames is half again as long as the usual one. A dropped frame makes a
 * gap of two usual ones. The frames before the transition starts do not
 * count, because nothing on screen moves in them.
 */
const droppedNoFrame = (cost: SplitCost) => cost.longestFrameGapMs < 1.5 * cost.frameIntervalMs;

/** Formats a cost of all the pushes as the cost of one, with the total after it. */
const formatPerPush = (totalMs: number) =>
  `${(totalMs / PUSH_COUNT).toFixed(1)} ms a push (${totalMs.toFixed(0)} ms for ${String(PUSH_COUNT)})`;

/** Formats a split's cost as one table cell. */
const formatSplit = (cost: SplitCost) =>
  `longest task ${cost.longestTaskMs.toFixed(1)} ms; transition starts ${cost.startDelayMs.toFixed(1)} ms ` +
  `after the click (longest gap before it ${cost.longestGapBeforeMs.toFixed(1)} ms); ` +
  `${String(cost.frames)} frames over the ` +
  `${cost.transitionMs.toFixed(0)} ms transition, ` +
  `longest gap ${cost.longestFrameGapMs.toFixed(1)} ms against ${cost.frameIntervalMs.toFixed(1)} ms usual`;

/** Whether a motion dropped no frame, by the same rule as the split's (see `droppedNoFrame`). */
const droppedNoMotionFrame = (cost: MotionCost) =>
  cost.longestFrameGapMs < 1.5 * cost.frameIntervalMs;

/**
 * Whether nothing drew after the motion's length was over: the renderer's
 * main thread drew its last frame no later than three frames after the
 * spec's length, which leaves room for the frame that draws the end and the
 * one that drops the finished animations, and the page held no animation and
 * no leaving row's copy when the recording ended.
 */
const isStillAfter = (cost: MotionCost) =>
  cost.lastFrameMs <= cost.lengthMs + 3 * cost.frameIntervalMs &&
  cost.animationsAfter === 0 &&
  cost.ghostsAfter === 0;

/** Formats a motion's cost as one table cell. */
const formatMotion = (cost: MotionCost) =>
  `${String(cost.animations)} animations, ${String(cost.starts)} start times; ` +
  `${String(cost.frames)} frames over ${cost.motionMs.toFixed(0)} ms, longest gap ` +
  `${cost.longestFrameGapMs.toFixed(1)} ms against ${cost.frameIntervalMs.toFixed(1)} ms usual; ` +
  `main thread ${cost.mainThreadMs.toFixed(1)} ms, longest task ${cost.longestTaskMs.toFixed(1)} ms; ` +
  `last frame ${cost.lastFrameMs.toFixed(0)} ms after the first; the second after: ` +
  `${String(cost.framesAfter)} frames, main thread ${cost.mainThreadAfterMs.toFixed(1)} ms, ` +
  `longest task ${cost.longestTaskAfterMs.toFixed(1)} ms; then ` +
  `${String(cost.animationsAfter)} animations, ${String(cost.ghostsAfter)} ghosts`;

/** Prints what the Intake scenario measured, against the limits spec 17 sets. */
export function reportIntakeWork(measured: IntakeWork): void {
  const { pushes, burst, splitOpen, splitClose, arrival, arrivalBurst, inboxZero } = measured;
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
    [
      `One arrival on screen, ${String(arrival.rowsBefore)} rows before it`,
      "no dropped frame; nothing draws after --dur-2",
      formatMotion(arrival),
      droppedNoMotionFrame(arrival) && isStillAfter(arrival),
    ],
    [
      `Burst of ${String(BURST_SIZE)} arriving on screen, ${String(arrivalBurst.rowsBefore)} rows before it`,
      "one block; no dropped frame; nothing draws after --dur-2",
      formatMotion(arrivalBurst),
      arrivalBurst.starts === 1 && droppedNoMotionFrame(arrivalBurst) && isStillAfter(arrivalBurst),
    ],
    [
      "Inbox zero, after the user's Done of the last signal, with the pane open",
      "no dropped frame; nothing draws after 800 ms plus the pane's --dur-3",
      formatMotion(inboxZero),
      droppedNoMotionFrame(inboxZero) && isStillAfter(inboxZero),
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

/** How many events Everything's list holds when it is measured. */
export const EVENT_COUNT = 1_000;

/**
 * How many events one signal names at most (`MAX_SIGNAL_EVENT_IDS` in the
 * contract; this script imports only the contract's types).
 */
const EVENTS_PER_SIGNAL = 64;

/** The events page Everything reads at a time, the controller's default page size. */
const EVENTS_PAGE_SIZE = 50;

/** Everything's list of events, which holds one `.ask-row` for each row it draws. */
const EVENTS_LIST = 'section[aria-label="Events"]';

/**
 * How long the app idles so that V8 runs its idle garbage collection, which
 * in a trace of an earlier version of the app first ran about 30 s after
 * launch. A reading taken before it holds garbage the app no longer uses.
 */
const IDLE_GARBAGE_COLLECTION_MS = 30_000;

/** How long the scroll to the end of the list may take before the scenario fails, in milliseconds. */
const SCROLL_TIMEOUT_MS = 60_000;

/** How far each step of the scroll moves the list, in pixels, and how long it waits, in milliseconds. */
const SCROLL_STEP_PX = 1_500;
const SCROLL_STEP_MS = 50;

/**
 * Writes `EVENT_COUNT` events into the controller, all of them events of
 * Intake: `event.emit` writes each one, `signal.raise` raises signals that
 * name them 64 at a time (the most one signal may name), and `signal.markDone`
 * resolves those signals at once. An event is an event of Intake when a
 * signal is behind it, and the resolved signals leave To do as it was. Fails
 * when the controller refuses a call, or when its listing of Intake's events
 * does not hold `EVENT_COUNT` afterwards.
 *
 * `event.emit` writes no title, no author and no arrival time, so the
 * fixture sets them in the database before each launch (see `titleEvents`).
 */
export async function seedEvents(fixture: ThreadFixture): Promise<void> {
  const eventIds: number[] = [];
  for (let number = 1; number <= EVENT_COUNT; number += 1) {
    const { eventId } = await fixture.call<{ readonly eventId: number }>("POST", "/events/emit", {
      kind: "github.notification",
      payload: {
        subject: {
          repo: "acme/webshop",
          url: `https://github.com/acme/webshop/pull/${String(number)}`,
        },
        reason: "review_requested",
      },
    });
    eventIds.push(eventId);
  }
  const signalIds: string[] = [];
  for (let from = 0; from < eventIds.length; from += EVENTS_PER_SIGNAL) {
    const { signalId } = await fixture.call<SignalRaiseResult>("POST", "/signals/raise", {
      kind: "fyi",
      title: `Signal over events from ${String(from + 1)}`,
      reason: "Raised by the perf script",
      eventIds: eventIds.slice(from, from + EVENTS_PER_SIGNAL),
    });
    signalIds.push(signalId);
  }
  await fixture.call("POST", "/signals/mark-done", { signalIds });

  let held = 0;
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ intake: "true", limit: "500" });
    if (cursor !== undefined) query.set("cursor", cursor);
    const result = await fixture.call<{
      readonly items: readonly unknown[];
      readonly nextCursor?: string;
    }>("GET", `/events?${query.toString()}`);
    held += result.items.length;
    cursor = result.nextCursor;
  } while (cursor !== undefined);
  if (held !== EVENT_COUNT) {
    throw new Error(
      `Intake lists ${String(held)} events after seeding, and the scenario needs ${String(EVENT_COUNT)}`,
    );
  }
}

/** What opening Everything and scrolling it to its end cost. */
export interface EverythingWork {
  /** The machine's load average over the minute before the app was spawned. */
  readonly loadAtSpawn: number;
  /** From the click on "Everything" until the list drew its first row, in milliseconds. */
  readonly firstRowMs: number;
  /** The longest task the renderer's main thread ran from the click until one second after the first row, in milliseconds. */
  readonly openLongestTaskMs: number;
  /** How many events reads the page made from the click until the end of the scroll. */
  readonly eventReads: number;
  /** How long the scroll took, from its first step until the list showed its end line, in milliseconds. */
  readonly scrollMs: number;
  /** The longest task the renderer's main thread ran over the scroll, in milliseconds. */
  readonly scrollLongestTaskMs: number;
  /** How many of the main thread's tasks over the scroll took over 50 ms. */
  readonly scrollLongTasks: number;
  /** How many rows the list drew at its end, out of `EVENT_COUNT`. */
  readonly rowsDrawn: number;
  /** The processes' memory on To do, 35 s after Intake showed, with no connection to the page. */
  readonly memoryOnToDo: Awaited<ReturnType<typeof readProcessMemory>>;
  /** The processes' memory 4 s after the scroll, with no connection to the page. */
  readonly memory: Awaited<ReturnType<typeof readProcessMemory>>;
  /** The processes' memory 30 s after `memory`, once the app idled. */
  readonly memoryAfterRest: Awaited<ReturnType<typeof readProcessMemory>>;
}

/**
 * Starts the signed-in app on `userDataDir` as a plain process, where it
 * opens Intake on To do again, and measures Everything in `EVENT_COUNT`
 * events:
 *
 * - a click on "Everything": the time until the list draws its first row,
 *   which includes loading the view's code, and the renderer's longest
 *   task until one second after;
 * - a scroll to the end of the list in steps of 1,500 px, 50 ms apart,
 *   which reads every page: the renderer's longest task and the tasks over
 *   50 ms in a trace, the events reads counted from the page's resource
 *   timing entries, and how many rows are drawn at the end;
 * - the processes' memory 3 s after the scroll, read once the connection to
 *   the page is closed, so the inspector's own cost is not in it.
 *
 * Fails when Intake does not show within 15 s, when the list does not draw a
 * row within 10 s of the click or reach its end line within a minute, when
 * a trace lost events, or when the app does not quit cleanly afterwards.
 */
export async function measureEverythingWork(userDataDir: string): Promise<EverythingWork> {
  const loadAtSpawn = loadavg()[0]!;
  const app = await launchPlainApp(userDataDir);
  let measured: EverythingWork;
  try {
    const connect = async () => connectInspector(await waitForPageSocketUrl(app.endpoint));
    const waitForIntake = async (page: Inspector) =>
      pollUntil(
        async () =>
          (await page.evaluate("Runtime.evaluate", {
            expression: `document.querySelector(${JSON.stringify(`${SIGNALS_LIST} .ask-row`)}) !== null`,
            returnByValue: true,
          })) === true
            ? true
            : undefined,
        { timeoutMs: 15_000, intervalMs: 20, timeoutMessage: "the app did not open Intake" },
      );
    // The memory of Intake on To do comes first, read with no connection to
    // the page, so the Everything reading can be compared with it.
    const first = await connect();
    try {
      await waitForIntake(first);
      await sleep(LAUNCH_SETTLE_MS + IDLE_GARBAGE_COLLECTION_MS);
    } finally {
      first.close();
    }
    await sleep(1_000);
    const memoryOnToDo = await readProcessMemory(app.process.pid!);

    const page = await connect();
    let readings: Omit<
      EverythingWork,
      "loadAtSpawn" | "memoryOnToDo" | "memory" | "memoryAfterRest"
    >;
    try {
      const evaluate = (expression: string) =>
        page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
      const waitInPage = (expression: string, timeoutMs: number, timeoutMessage: string) =>
        pollUntil(async () => ((await evaluate(expression)) === true ? true : undefined), {
          timeoutMs,
          intervalMs: 20,
          timeoutMessage,
        });

      let clickedAt = 0;
      let firstRowMs = 0;
      const openTasks = await traceRendererTasks(page, async () => {
        clickedAt = (await evaluate(`(() => {
          const at = performance.now();
          [...document.querySelectorAll('[role="group"][aria-label="View"] button')]
            .find((button) => button.textContent.startsWith("Everything")).click();
          return at;
        })()`)) as number;
        await waitInPage(
          `document.querySelector(${JSON.stringify(`${EVENTS_LIST} .ask-row`)}) !== null`,
          10_000,
          "Everything did not draw a row",
        );
        firstRowMs = ((await evaluate("performance.now()")) as number) - clickedAt;
        await sleep(1_000);
      });

      const endShown = `document.querySelector(${JSON.stringify(`${EVENTS_LIST} .asks-note`)})
        ?.textContent.startsWith("No more events") === true`;
      const scrollStep = `document.querySelector(${JSON.stringify(`${EVENTS_LIST} .asks-scroll`)})
        .scrollTop += ${String(SCROLL_STEP_PX)}`;
      const scrollStarted = Date.now();
      const scrollTasks = await traceRendererTasks(page, async () => {
        while ((await evaluate(endShown)) !== true) {
          if (Date.now() - scrollStarted > SCROLL_TIMEOUT_MS) {
            throw new Error("Everything's list did not reach its end line within a minute");
          }
          await evaluate(scrollStep);
          await sleep(SCROLL_STEP_MS);
        }
      });
      const scrollMs = Date.now() - scrollStarted;
      const eventReads = (await evaluate(`performance.getEntriesByType("resource").filter((entry) =>
        entry.startTime >= ${String(clickedAt)} && new URL(entry.name).pathname === "/api/v1/events"
      ).length`)) as number;
      const rowsDrawn = (await evaluate(
        `document.querySelectorAll(${JSON.stringify(`${EVENTS_LIST} .ask-row`)}).length`,
      )) as number;
      readings = {
        firstRowMs,
        openLongestTaskMs: Math.max(...openTasks),
        eventReads,
        scrollMs,
        scrollLongestTaskMs: Math.max(...scrollTasks),
        scrollLongTasks: scrollTasks.filter((ms) => ms > BUDGET.streamingTaskMs).length,
        rowsDrawn,
      };
      await sleep(3_000);
    } finally {
      page.close();
    }
    await sleep(1_000);
    const memory = await readProcessMemory(app.process.pid!);
    await sleep(IDLE_GARBAGE_COLLECTION_MS);
    measured = {
      loadAtSpawn,
      ...readings,
      memoryOnToDo,
      memory,
      memoryAfterRest: await readProcessMemory(app.process.pid!),
    };
  } finally {
    await stopPlainApp(app);
  }
  assertExitedCleanly(app.process);
  return measured;
}

/** Prints what the Everything scenario measured, against the limits spec 17 sets. */
export function reportEverythingWork(measured: EverythingWork): void {
  const sumFootprintMb = (memory: EverythingWork["memory"]) =>
    memory.reduce((sum, sample) => sum + sample.footprintMb, 0);
  const readFootprintMb = (memory: EverythingWork["memory"], label: string) =>
    memory.find((sample) => sample.label === label)?.footprintMb ?? 0;
  const formatFootprint = (memory: EverythingWork["memory"]) =>
    `${sumFootprintMb(memory).toFixed(0)} MB summed: renderer ${readFootprintMb(memory, "Tab").toFixed(0)} MB, GPU ${readFootprintMb(memory, "GPU").toFixed(0)} MB`;
  const summedFootprintMb = sumFootprintMb(measured.memoryAfterRest);
  const rendererFootprintMb = readFootprintMb(measured.memoryAfterRest, "Tab");
  const summedGrowthMb = summedFootprintMb - sumFootprintMb(measured.memoryOnToDo);
  const rendererGrowthMb = rendererFootprintMb - readFootprintMb(measured.memoryOnToDo, "Tab");
  const pages = Math.ceil(EVENT_COUNT / EVENTS_PAGE_SIZE);
  const rows: [string, string, string, boolean | null][] = [
    [
      "Opening Everything",
      "recorded; not budgeted",
      `first row ${measured.firstRowMs.toFixed(0)} ms after the click, longest task ${measured.openLongestTaskMs.toFixed(1)} ms`,
      null,
    ],
    [
      `Scrolling ${String(EVENT_COUNT)} events, renderer main thread`,
      `recorded; streaming's limit is no task over ${String(BUDGET.streamingTaskMs)} ms`,
      `longest task ${measured.scrollLongestTaskMs.toFixed(1)} ms (${String(measured.scrollLongTasks)} over ${String(BUDGET.streamingTaskMs)} ms), end line after ${(measured.scrollMs / 1_000).toFixed(1)} s`,
      null,
    ],
    [
      "Events reads",
      `one read for each page of ${String(EVENTS_PAGE_SIZE)}, ${String(pages)} for the list`,
      String(measured.eventReads),
      measured.eventReads <= pages,
    ],
    [
      "Rows drawn at the end of the list",
      `far fewer than the ${String(EVENT_COUNT)} events`,
      String(measured.rowsDrawn),
      measured.rowsDrawn < EVENT_COUNT / 10,
    ],
    [
      "Memory on To do, 35 s after Intake showed",
      "recorded",
      formatFootprint(measured.memoryOnToDo),
      null,
    ],
    ["Memory 4 s after the scroll", "recorded", formatFootprint(measured.memory), null],
    [
      "Memory 34 s after the scroll, summed footprint",
      `at most ${String(BUDGET.summedFootprintMb)} MB`,
      `${summedFootprintMb.toFixed(0)} MB, ${summedGrowthMb.toFixed(0)} MB more than on To do`,
      summedFootprintMb <= BUDGET.summedFootprintMb,
    ],
    [
      "Memory 34 s after the scroll, renderer footprint",
      `at most ${String(BUDGET.rendererFootprintMb)} MB`,
      `${rendererFootprintMb.toFixed(0)} MB, ${rendererGrowthMb.toFixed(0)} MB more than on To do`,
      rendererFootprintMb <= BUDGET.rendererFootprintMb,
    ],
  ];

  console.log(`## Everything at work, on ${String(EVENT_COUNT)} events`);
  console.log();
  console.log(`Load average over the minute before the launch: ${measured.loadAtSpawn.toFixed(2)}`);
  console.log();
  console.log(
    formatTable(
      ["Budget", "Limit", "Measured", "Within"],
      rows.map(([budget, limit, measuredText, within]) => [
        budget,
        limit,
        measuredText,
        within === null ? "-" : within ? "yes" : "over",
      ]),
    ),
  );
  console.log();
}
