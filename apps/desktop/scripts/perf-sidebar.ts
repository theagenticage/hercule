/**
 * Measures the desktop perf script's sidebar scenario: what hiding, showing
 * and resizing the sidebar cost, as spec 17 §The sidebar's layout and rule 2 of
 * §Rules ask. It runs one plain launch that reopens a thread with a long
 * transcript beside a sidebar of 500 threads, and measures:
 *
 * - hiding the sidebar by its Hide button, and showing it by the Show
 *   button: the frames the page drew over the slide, the longest gap between
 *   them, and the longest time one frame spent on style and layout;
 * - a drag of the sidebar's edge, one pointer move a frame: the same;
 * - a press and release of the edge with no move, and an arrow key on the
 *   focused edge: the same, because each sets the shell's `data-resizing`.
 *
 * Style and layout are added up per frame, from one frame's animation frame
 * callbacks to the next frame's, because rule 2's bar is per frame.
 *
 * It runs on plain Node, like the perf script, so its imports name the `.ts`
 * file.
 */
import { loadavg } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import {
  assertExitedCleanly,
  connectInspector,
  formatTable,
  launchPlainApp,
  stopPlainApp,
  type Inspector,
} from "./packaged-app.ts";
import {
  findRendererMainTasks,
  readTrace,
  TIMELINE_CATEGORY,
  waitForPageSocketUrl,
} from "./perf-measures.ts";
import { pollUntil } from "./poll.ts";

/** How long the launch settles before the first measurement, in milliseconds. */
const LAUNCH_SETTLE_MS = 5_000;

/** How long the page rests between two measurements, in milliseconds. */
const STEP_SETTLE_MS = 2_000;

/** How many pointer moves the drag makes, one a frame. */
const DRAG_MOVES = 40;

/** How far each pointer move of the drag goes, in pixels. */
const DRAG_STEP_PX = 3;

/** The trace events of the renderer's main thread that are style and layout work. */
const STYLE_AND_LAYOUT = new Set(["UpdateLayoutTree", "Layout"]);

/** The mark the page writes into the trace when a measured change starts. */
const START_MARK = "sidebar-measure-start";

/**
 * What one change of the sidebar cost the renderer. The frames are counted
 * from the slide's first frame, or the drag's; the renderer's tasks from the
 * click's frame on, the click's own work included.
 */
export interface SidebarCost {
  /** How long the page recorded frames, in milliseconds: the slide's length, or the drag's. */
  readonly recordedMs: number;
  /** How long after the click's frame the slide's first frame came, in milliseconds; 0 for a drag. */
  readonly startDelayMs: number;
  /** The longest time between two frames before the slide's first frame, in milliseconds. */
  readonly longestGapBeforeMs: number;
  /** How many frames the page drew in that time. */
  readonly frames: number;
  /** The longest time between two of those frames, in milliseconds. */
  readonly longestFrameGapMs: number;
  /** The usual time between two of those frames, the median, in milliseconds. */
  readonly frameIntervalMs: number;
  /**
   * The most time one frame spent on style and layout on the renderer's main
   * thread, in milliseconds: every task's style and layout from that frame's
   * animation frame callbacks to the next frame's, added up.
   */
  readonly longestFrameWorkMs: number;
  /** The usual time a frame that ran style or layout spent on them, the median, in milliseconds. */
  readonly usualFrameWorkMs: number;
  /** When the most expensive frame started, in milliseconds after the click's frame. */
  readonly longestFrameAtMs: number;
  /** The time the most expensive frame spent on style alone, in milliseconds. */
  readonly longestFrameStyleMs: number;
  /** The time the most expensive frame spent on layout alone, in milliseconds. */
  readonly longestFrameLayoutMs: number;
  /** The longest task the renderer's main thread ran, in milliseconds. */
  readonly longestTaskMs: number;
}

/** What the sidebar scenario measured. */
export interface SidebarWork {
  /** The machine's load average over the minute before the app was spawned. */
  readonly loadAtSpawn: number;
  /** The window's width, in pixels, which decides how wide the main pane is. */
  readonly windowWidth: number;
  readonly hide: SidebarCost;
  readonly show: SidebarCost;
  readonly drag: SidebarCost;
  readonly press: SidebarCost;
  readonly arrowKey: SidebarCost;
}

/**
 * Measures the sidebar in a plain launch of the app on `userDataDir`, which
 * must reopen a thread whose transcript shows. Fails when the transcript
 * does not show within 15 s, when `--dur-3` is 0, as under Reduce motion,
 * when the sidebar does not hide or show, when a trace lost events, or when
 * the app does not quit cleanly afterwards.
 */
export async function measureSidebarWork(userDataDir: string): Promise<SidebarWork> {
  const loadAtSpawn = loadavg()[0]!;
  const app = await launchPlainApp(userDataDir);
  let measured: SidebarWork;
  try {
    const page = await connectInspector(await waitForPageSocketUrl(app.endpoint));
    try {
      const evaluate = (expression: string) =>
        page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
      await pollUntil(
        async () =>
          (await evaluate(`document.querySelector('section[aria-label="Transcript"]') !== null`))
            ? true
            : undefined,
        { timeoutMs: 15_000, intervalMs: 50, timeoutMessage: "the app did not reopen the thread" },
      );
      await sleep(LAUNCH_SETTLE_MS);
      const slideMs = (await evaluate(`(() => {
        const value = getComputedStyle(document.documentElement).getPropertyValue("--dur-3").trim();
        return value.endsWith("ms") ? parseFloat(value) : parseFloat(value) * 1000;
      })()`)) as number;
      if (!(slideMs > 0)) {
        throw new Error(
          `--dur-3 is ${String(slideMs)} ms, so the sidebar does not slide. Turn Reduce motion off and run the script again.`,
        );
      }
      const windowWidth = (await evaluate("innerWidth")) as number;
      const readState = async () =>
        (await evaluate(`document.querySelector(".app").dataset.sidebar`)) as string;

      // Hiding takes --dur-2, shorter than --dur-3, so recording for --dur-3
      // covers it and a frame or two of rest after it.
      const hide = await measureChange(
        page,
        slideMs,
        `document.querySelector('[title^="Hide the sidebar"]').click()`,
        "closed",
      );
      if ((await readState()) !== "closed")
        throw new Error("the Hide button did not hide the sidebar");
      await sleep(STEP_SETTLE_MS);
      const show = await measureChange(
        page,
        slideMs,
        `document.querySelector(".side-show").click()`,
        "open",
      );
      if ((await readState()) !== "open")
        throw new Error("the Show button did not show the sidebar");
      await sleep(STEP_SETTLE_MS);
      const drag = await measureDrag(page);
      await sleep(STEP_SETTLE_MS);
      const press = await measurePress(page);
      await sleep(STEP_SETTLE_MS);
      const arrowKey = await measureArrowKey(page);
      measured = { loadAtSpawn, windowWidth, hide, show, drag, press, arrowKey };
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
 * Runs `action`, a statement evaluated in the page that hides or shows the
 * sidebar, inside an animation frame callback, and returns what it cost:
 * the page's animation frames, and from a trace, the renderer's tasks and
 * their style and layout work. `box` is the state the sidebar's box slides
 * to; the slide's frames are counted from the frame that sets it, one frame
 * after the click, and the frames before it are reported apart.
 */
async function measureChange(
  page: Inspector,
  slideMs: number,
  action: string,
  box: "open" | "closed",
): Promise<SidebarCost> {
  return traceFrames(page, slideMs, action, box, async () => {
    await sleep(slideMs + 600);
  });
}

/**
 * Drags the sidebar's edge right by `DRAG_MOVES` moves of `DRAG_STEP_PX`,
 * one a frame, then back to where it was, and returns what the drag cost.
 */
async function measureDrag(page: Inspector): Promise<SidebarCost> {
  const box = await findHandleCentre(page);
  const mouse = (type: string, x: number) =>
    page.send("Input.dispatchMouseEvent", {
      type,
      x,
      y: box.y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
    });
  const frameMs = 1_000 / 120;
  const recordMs = DRAG_MOVES * 2 * frameMs + 200;
  await mouse("mousePressed", box.x);
  const cost = await traceFrames(page, recordMs, "", null, async () => {
    for (let move = 1; move <= DRAG_MOVES * 2; move += 1) {
      const offset = move <= DRAG_MOVES ? move : DRAG_MOVES * 2 - move;
      await mouse("mouseMoved", box.x + offset * DRAG_STEP_PX);
      await sleep(frameMs);
    }
    await sleep(400);
  });
  await mouse("mouseReleased", box.x);
  return cost;
}

/** Returns the centre of the sidebar's handle, in the page's pixels. */
const findHandleCentre = async (page: Inspector) =>
  (await page.evaluate("Runtime.evaluate", {
    expression: `(() => {
      const rect = document.querySelector(".side-handle").getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`,
    returnByValue: true,
  })) as { x: number; y: number };

/** How long a measurement of one press or key records frames, in milliseconds. */
const SHORT_RECORD_MS = 400;

/**
 * Presses the sidebar's edge and lets it go without moving, as the first
 * click of a double-click does, and returns what that cost.
 */
async function measurePress(page: Inspector): Promise<SidebarCost> {
  const { x, y } = await findHandleCentre(page);
  const mouse = (type: string) =>
    page.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: 1,
    });
  return traceFrames(page, SHORT_RECORD_MS, "", null, async () => {
    await mouse("mousePressed");
    await sleep(80);
    await mouse("mouseReleased");
    await sleep(SHORT_RECORD_MS);
  });
}

/**
 * Presses → on the focused edge, which widens the sidebar 16px, and returns
 * what that cost. Presses ← afterwards, outside the trace, to put the
 * sidebar back.
 */
async function measureArrowKey(page: Inspector): Promise<SidebarCost> {
  await page.evaluate("Runtime.evaluate", {
    expression: `document.querySelector(".side-handle").focus()`,
  });
  const press = async (key: string, keyCode: number) => {
    for (const type of ["rawKeyDown", "keyUp"]) {
      await page.send("Input.dispatchKeyEvent", {
        type,
        key,
        code: key,
        windowsVirtualKeyCode: keyCode,
      });
    }
  };
  const cost = await traceFrames(page, SHORT_RECORD_MS, "", null, async () => {
    await press("ArrowRight", 39);
    await sleep(SHORT_RECORD_MS);
  });
  await press("ArrowLeft", 37);
  return cost;
}

/**
 * Records a trace and the page's animation frames from the next frame, runs
 * `action` in the page inside that frame's callback, and `work` in the
 * script meanwhile. Returns the frames and the renderer's tasks from that
 * frame on. Fails when the trace lost events.
 *
 * With `box` null, the recording runs `recordMs` from the first frame. With
 * a `box`, it runs `recordMs` from the frame that sets the shell's
 * `data-sidebar-box` to it, which starts the slide, and that frame is where
 * the slide's frames start. A mutation observer notes the frame, because the
 * shell sets the attribute in an animation frame callback of its own. A
 * slide that never starts stops the recording after a second.
 */
async function traceFrames(
  page: Inspector,
  recordMs: number,
  action: string,
  box: "open" | "closed" | null,
  work: () => Promise<void>,
): Promise<SidebarCost> {
  const evaluate = (expression: string) =>
    page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
  await page.send("Tracing.start", {
    transferMode: "ReturnAsStream",
    traceConfig: { includedCategories: [TIMELINE_CATEGORY, "devtools.timeline"] },
  });
  await evaluate(`(() => {
    const frames = [];
    globalThis.sidebarFrames = frames;
    globalThis.sidebarStart = ${box === null ? "0" : "undefined"};
    ${
      box === null
        ? ""
        : `const shell = document.querySelector(".app");
    new MutationObserver((records, observer) => {
      if (shell.dataset.sidebarBox !== ${JSON.stringify(box)}) return;
      globalThis.sidebarStart = Math.max(0, frames.length - 1);
      observer.disconnect();
    }).observe(shell, { attributes: true, attributeFilter: ["data-sidebar-box"] });`
    }
    const record = (at) => {
      frames.push(at);
      if (frames.length === 1) {
        console.timeStamp(${JSON.stringify(START_MARK)});
        ${action};
      }
      const start = globalThis.sidebarStart;
      // One frame past the end, so the gap into the frame after it is measured too.
      if (start === undefined ? at - frames[0] < 1000 : at - frames[start] <= ${String(recordMs)}) {
        requestAnimationFrame(record);
      }
    };
    requestAnimationFrame(record);
  })()`);
  await work();
  await page.send("Tracing.end");
  const events = await readTrace(page);
  const frames = (await evaluate("globalThis.sidebarFrames")) as number[];
  const start = (await evaluate("globalThis.sidebarStart")) as number | undefined;
  if (start === undefined) throw new Error(`the sidebar's box did not turn ${String(box)}`);
  const gaps = frames.slice(1).map((at, index) => at - frames[index]!);
  const slideGaps = gaps.slice(start).toSorted((a, b) => a - b);

  const mark = events.find(
    (event) => event.name === "TimeStamp" && event.args?.data?.message === START_MARK,
  );
  if (mark === undefined) throw new Error("the trace holds no mark of the change's start");
  // The mark is written in the first frame's callback, so a frame's callback
  // runs at the mark plus the frame's time after the first.
  const frameStarts = frames.map((at) => mark.ts + (at - frames[0]!) * 1_000);
  const end = frameStarts.at(-1)!;
  const tasks = findRendererMainTasks(events).filter(
    (task) => task.ts + task.dur! >= mark.ts && task.ts <= end,
  );
  const mainThreads = new Set(tasks.map((task) => `${String(task.pid)}:${String(task.tid)}`));
  const styleAndLayout = events.filter(
    (event) =>
      STYLE_AND_LAYOUT.has(event.name) &&
      event.ph === "X" &&
      mainThreads.has(`${String(event.pid)}:${String(event.tid)}`),
  );
  const perFrame = frameStarts.slice(0, -1).map((from, index) => {
    const to = frameStarts[index + 1]!;
    const inFrame = styleAndLayout.filter((event) => event.ts >= from && event.ts < to);
    const sumMs = (name: string) =>
      inFrame.filter((event) => event.name === name).reduce((sum, event) => sum + event.dur!, 0) /
      1_000;
    const styleMs = sumMs("UpdateLayoutTree");
    const layoutMs = sumMs("Layout");
    return { atMs: (from - mark.ts) / 1_000, styleMs, layoutMs, totalMs: styleMs + layoutMs };
  });
  const worst = perFrame.reduce((most, frame) => (frame.totalMs > most.totalMs ? frame : most), {
    atMs: 0,
    styleMs: 0,
    layoutMs: 0,
    totalMs: 0,
  });
  const busyFrames = perFrame
    .map((frame) => frame.totalMs)
    .filter((ms) => ms > 0)
    .toSorted((a, b) => a - b);
  return {
    recordedMs: frames.at(-1)! - frames[start]!,
    startDelayMs: frames[start]! - frames[0]!,
    longestGapBeforeMs: Math.max(0, ...gaps.slice(0, start)),
    frames: frames.length - start,
    longestFrameGapMs: slideGaps.at(-1) ?? 0,
    frameIntervalMs: slideGaps[Math.floor(slideGaps.length / 2)] ?? 0,
    longestFrameWorkMs: worst.totalMs,
    usualFrameWorkMs: busyFrames[Math.floor(busyFrames.length / 2)] ?? 0,
    longestFrameAtMs: worst.atMs,
    longestFrameStyleMs: worst.styleMs,
    longestFrameLayoutMs: worst.layoutMs,
    longestTaskMs: Math.max(0, ...tasks.map((task) => task.dur! / 1_000)),
  };
}

/**
 * Checks that a change kept every frame: its longest gap is under one and a
 * half usual ones, so a dropped frame, a gap of two usual ones, fails it.
 */
const keepsEveryFrame = (cost: SidebarCost) => cost.longestFrameGapMs < 1.5 * cost.frameIntervalMs;

/** Formats a change's cost as one table cell. */
const formatCost = (cost: SidebarCost) =>
  `${String(cost.frames)} frames over ${cost.recordedMs.toFixed(0)} ms, starting ` +
  `${cost.startDelayMs.toFixed(1)} ms after the click (longest gap before ${cost.longestGapBeforeMs.toFixed(1)} ms); longest gap ` +
  `${cost.longestFrameGapMs.toFixed(1)} ms against ${cost.frameIntervalMs.toFixed(1)} ms usual; ` +
  `style and layout ${cost.usualFrameWorkMs.toFixed(2)} ms usual, ` +
  `${cost.longestFrameWorkMs.toFixed(2)} ms at most a frame, ${cost.longestFrameAtMs.toFixed(0)} ms after the click (style ${cost.longestFrameStyleMs.toFixed(2)}, ` +
  `layout ${cost.longestFrameLayoutMs.toFixed(2)}); longest task ${cost.longestTaskMs.toFixed(1)} ms`;

/** Prints what the sidebar scenario measured, as a table, and whether each change keeps rule 2. */
export function reportSidebarWork(measured: SidebarWork): void {
  console.log(
    `\n### The sidebar, a long transcript open, 500 threads, ${String(measured.windowWidth)}px window (load ${measured.loadAtSpawn.toFixed(1)})\n`,
  );
  const decideVerdict = (cost: SidebarCost) =>
    keepsEveryFrame(cost) && cost.longestFrameWorkMs <= 2 ? "passes" : "FAILS";
  console.log(
    formatTable(
      ["Change", "Measured", "Rule 2: no dropped frame, at most 2 ms of style and layout"],
      [
        ["Hiding", formatCost(measured.hide), decideVerdict(measured.hide)],
        ["Showing", formatCost(measured.show), decideVerdict(measured.show)],
        ["Dragging the edge", formatCost(measured.drag), decideVerdict(measured.drag)],
        [
          "Pressing the edge and letting go",
          formatCost(measured.press),
          decideVerdict(measured.press),
        ],
        ["→ on the edge", formatCost(measured.arrowKey), decideVerdict(measured.arrowKey)],
      ],
    ),
  );
}
