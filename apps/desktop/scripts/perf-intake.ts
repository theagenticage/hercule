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
 *   in the list.
 *
 * To do is sorted oldest first, so a raised signal lands below the rows on
 * screen. The per-push cost is then the read and the list's render, with no
 * row on screen to animate. The Performance panel rows of the cost table,
 * the per-push animation and inbox zero, are not measured here.
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
 *   after the transition's `--dur-3` is over (see `measureSplitToggle`).
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
