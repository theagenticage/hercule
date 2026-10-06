/**
 * Measures the packaged desktop app, signed in to a controller, and prints
 * spec 17's budget table (§Performance). A reading over its budget is marked
 * "over" and does not fail the run, because the budgets are guides during
 * the first milestone (spec 17 §Budgets). Run it after `pnpm build:desktop`
 * and `pnpm build:binary`:
 *
 *     pnpm --filter @hercule/desktop perf
 *
 * It starts a controller from the compiled binary, `./hercule`, in a scratch
 * Hercule Home, completes its setup, and fills it with 40 threads through the
 * fleet of scripted runners (see `perf-fixture.ts`). Then it starts the test
 * package on one fresh user data directory, with that controller saved:
 *
 * 1. Through Playwright, to sign in on the sign-in screen, as a user does
 *    once. The app saves the token with the mock keychain, so the run never
 *    touches the real Keychain.
 * 2. Five measured launches: with 40 threads, with 40 threads and one row
 *    that shows minutes, with 40 threads and Settings › Profile open (see
 *    `openSettingsSection`), and, after spawning 460 more, with 500 threads,
 *    the last time with a thread of 500 transcript rows open (see step 3).
 *    Spec 17 §What Settings costs asks for Settings' memory and idle to be
 *    read with a section open; each section in `SETTINGS_SECTIONS` adds one
 *    launch.
 *    Before each of them the fixture restarts the controller with every idle
 *    thread's last activity set hours back. Then the script starts the app
 *    through Playwright, signed in, to warm it up (see `warmUpApp`), and
 *    then as a plain process, signed in, for the measured launch. From each
 *    measured launch the script reads, in this order:
 *    - the memory of each of the app's processes, 13 s after the page opens;
 *    - the age labels on screen, 28 s after the page opens;
 *    - each process's CPU and wakeups over 10 s with the window visible,
 *      from 30 s after the page opens;
 *    - the same over 10 s with the window hidden, from 3 s after hiding it,
 *      90 s after the page opens;
 *    - how often the age clock fired in the 60 s from 30 s after the page
 *      opened, with the window visible, and in the 60 s after hiding it;
 *    - with the window shown again, the CPU time of 20 live nudges (see
 *      `measureNudges`);
 *    - the launch times: how long from spawn until the window was shown,
 *      and until each step that leads up to it.
 * 3. For the last measured launch, the fixture first plays turns into one idle
 *    thread until its transcript holds 500 rows. The script opens that
 *    thread once, through Playwright, so the app opens it again at every
 *    later launch (see `openThreadOnce`). That launch's first screen is
 *    then the thread with its whole transcript, so its `first-screen` mark
 *    is when the transcript painted, and its memory is read with the thread
 *    open.
 * 4. One more plain launch, which reopens the same thread, measures a turn
 *    that streams into it at full speed (see `measureStreaming`).
 * 5. The last plain launch opens another idle thread, into which the fixture
 *    has played 20 subagents, 4 of them still running, and measures what
 *    spec 17 §What subagents cost asks for: memory with the side pane closed
 *    and open, idle with 4 running and with every subagent ended, how often
 *    the rows' durations change, the live topics held on each page, and
 *    the reads that subagent changes cause (see `perf-subagents.ts`).
 *
 * The first thread screen's JavaScript is not measured here: `pnpm
 * build:desktop` checks it, and prints it as "the first screen", because the
 * thread's route is among the routes its check counts.
 *
 * The age clock is the one timer that keeps the age labels on screen
 * current, and it marks each fire with `performance.mark("age-clock-fire")`.
 * The kernel's wakeup counter cannot see it, because Chromium wakes an idle
 * renderer up to twice a second on its own, so the script counts the marks.
 * With every age on screen hours old, the clock has nothing to change within
 * the visible 60 s and should fire 0 times. With one row that shows "2m", it
 * should fire once, when that row turns "3m". The row's next change, to
 * "4m", falls in the hidden 60 s, where the clock is stopped, so the hidden
 * count should be 0 in every launch. The page knows it is hidden only because
 * no Playwright is attached to it (see `launchPlainApp`).
 *
 * Nothing stays attached to the app while memory, CPU and wakeups are read,
 * because an attached tool changes what it measures: in two earlier versions
 * of the app, the renderer's memory read 7 MB and 14 MB higher with
 * Playwright attached than without. The age labels are read over the page's DevTools
 * connection before the samples start, and the connection is closed again at
 * once. The age clock's fires are read after the samples, and the launch
 * times last.
 *
 * Memory is read from outside the app, by process ID. Two numbers are read
 * for each process:
 *
 * - The physical footprint, which the budget limits: the memory `footprint`
 *   reports and Activity Monitor shows for a process.
 * - The working set, the resident size `ps` reports, which is the number
 *   `app.getAppMetrics()` reports on macOS. It is printed for information
 *   only. It counts the Electron framework's pages, which all four processes
 *   share, once in each process. The sum then reads about 200 MB above the
 *   summed footprint, however little the app itself holds: 315 MB against
 *   119 MB for an empty Electron app.
 *
 * CPU and wakeups come from `app.getAppMetrics()`, which the script calls in
 * main through the Node inspector the launch opens (see below). It connects
 * for each call and closes the connection again at once. The wakeups are the
 * kernel's count of each process's interrupt wakeups, averaged over the
 * sample and rounded to a whole number a second. `top` cannot check them: its
 * idle wakeups column counts only the wakeups that bring the whole processor
 * out of idle, and those stay at 0 on a busy machine, for every process.
 *
 * While the app is measured, its own process holds the inspector and the
 * DevTools endpoint the launch opens, both idle between the script's calls.
 *
 * Launch is measured without Playwright, because Playwright slows the launch
 * down: it holds each new renderer paused until it has attached to it, and it
 * connects to main through the inspector. The script notes the time, spawns
 * the app with `--remote-debugging-port=0`, and reads the launch times only
 * after the idle samples, each in milliseconds since the epoch like the time
 * noted at spawn:
 *
 * - `window-shown`, the budgeted one: the mark main sets in its own
 *   performance timeline when it shows the window, read through the
 *   inspector. Main shows the window once the page reports that its first
 *   screen, fonts included, has reached the window. The run fails when main
 *   logs that it showed the window without that report, on its time limit
 *   or after a failure, because the time is then not the first screen's.
 * - The steps that say where the time before the show went, in the order
 *   they happen:
 *   - From main, through the inspector: when its Node environment was
 *     ready, before any of the app's own code ran, and when it started the
 *     GPU process and the renderer process (`app.getAppMetrics()`). A launch
 *     that is not warm is slow already here: main's Node environment was
 *     ready after 200 ms or more, against about 90 ms warm.
 *   - From the page, over the Chrome DevTools Protocol: when the renderer
 *     started loading the page (`performance.timeOrigin`); `first-paint`,
 *     when the page first painted, which is when Electron emits
 *     `ready-to-show`; and `first-screen`, the mark the page sets at the
 *     moment the frame that drew its first screen was presented. The page
 *     reports to main after that. The script checks that the screen is the
 *     shell, so the time is a signed-in launch's and not the connect
 *     screen's.
 *
 * The plain launch also passes `--inspect=0` and `--use-mock-keychain`. The
 * mock keychain lets the app read the token saved in step 1. While its Node
 * inspector is closed, a packaged app refuses every argument except those
 * `buildAppArgs` passes, and `--inspect=0` opens the inspector without
 * attaching to it; the test package's fuses allow it. Opening it barely
 * moves the launch: over six launches each, before the refusal existed, the
 * median was 248 ms without it and 250 ms with it.
 *
 * The warm-up right before each measured launch puts the app's files in
 * macOS's file cache and its compiled scripts in Chromium's code cache, as
 * the budget's warm launch assumes (see `warmUpApp`).
 *
 * Launch time depends on how busy the machine is, so the script prints, for
 * each launch, the load average over the minute before it was spawned.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
// The extensions are spelled out because Node runs this script as it is, and
// Node resolves no import without one.
import {
  assertExitedCleanly,
  connectInspector,
  evaluateInMain,
  formatTable,
  launchPlainApp,
  signInOnce,
  stopPlainApp,
  writeSettings,
  type Inspector,
} from "./packaged-app.ts";
import { runWithThreadFixture, type LongThread, type ThreadFixture } from "./perf-fixture.ts";
import {
  BUDGET,
  HIDDEN_SETTLE_MS,
  MEMORY_READ_AT_MS,
  VISIBLE_SAMPLE_AT_MS,
  evaluateInPage,
  findProcessUse,
  openThreadOnce,
  readProcessMemory,
  runFile,
  sampleIdleUse,
  waitForPageSocketUrl,
  warmUpApp,
  type ProcessMemory,
  type ProcessUse,
} from "./perf-measures.ts";
import { measureSubagentLaunch, reportSubagentLaunch } from "./perf-subagents.ts";
import { pollUntil } from "./poll.ts";
import { SHOWN_WITHOUT_FIRST_SCREEN_ERROR } from "../src/main/window-visibility.ts";

/** How many rows the transcript of the thread the last measured launch opens holds at least. */
const LONG_THREAD_ROWS = 500;

/**
 * The sections of Settings that get a measured launch each, with the section
 * open, by the name that the section's row in the Settings list and its
 * header title show.
 */
const SETTINGS_SECTIONS = ["Profile"] as const;

type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** How long the measured turn streams (see `measureStreaming`). */
const STREAM_MS = 10_000;

/**
 * When the age labels on screen are read, in milliseconds after the page
 * opens: just before the visible sample, so the connection that reads them
 * is closed while the sample runs.
 */
const AGES_READ_AT_MS = 28_000;

/**
 * How long the age clock's fires are counted, with the window visible and
 * then hidden. The visible count starts with the visible sample, and the
 * window is hidden when it ends.
 */
const FIRE_COUNT_MS = 60_000;

/** How long the window is shown again before the nudges start, so the page has redrawn. */
const SHOW_SETTLE_MS = 3_000;

/** How many live nudges are measured, and how far apart they are. */
const NUDGE_COUNT = 20;
const NUDGE_INTERVAL_MS = 1_000;

/** How long after the last nudge the reading ends, so the last read and render are in it. */
const NUDGE_SETTLE_MS = 2_000;

/** How long a launch took, in milliseconds from spawn, step by step. */
interface LaunchTimes {
  /** Until main's Node environment was ready, before any of the app's own code ran. */
  readonly nodeReadyMs: number;
  /** Until main started the GPU process. */
  readonly gpuProcessMs: number;
  /** Until main started the renderer process. */
  readonly rendererProcessMs: number;
  /** Until the renderer started loading the page. */
  readonly pageStartMs: number;
  /** Until the page first painted. */
  readonly firstPaintMs: number;
  /** Until the frame that drew the page's first screen, fonts included, was presented. */
  readonly firstScreenMs: number;
  /** Until main showed the window. */
  readonly windowShownMs: number;
}

/** What 20 live nudges cost, summed over all of them. */
interface NudgeCost {
  /** The controller process's CPU time, in milliseconds. */
  readonly controllerCpuMs: number;
  /** The renderer process's CPU time, all of its threads, in milliseconds. */
  readonly rendererCpuMs: number;
  /** The time the renderer's main thread spent running tasks, in milliseconds. */
  readonly rendererMainThreadMs: number;
  /** How many times the page read the thread list. */
  readonly threadListReads: number;
}

/** What one plain launch of the app measured. */
interface PlainLaunch {
  readonly launch: LaunchTimes;
  /** Each process's memory, 13 s after the page opened. */
  readonly memory: ProcessMemory[];
  /** The age labels on screen 28 s after the page opened, such as "2m" and "3h", top to bottom. */
  readonly agesOnScreen: string[];
  /** Each process's use over 10 s with the window visible, from 30 s after the page opened. */
  readonly visible: ProcessUse[];
  /** Each process's use over 10 s with the window hidden, from 3 s after it was hidden. */
  readonly hidden: ProcessUse[];
  /** How often the age clock fired in the 60 s from 30 s after the page opened. */
  readonly firesVisible: number;
  /** How often the age clock fired in the 60 s after the window was hidden. */
  readonly firesHidden: number;
  readonly nudges: NudgeCost;
}

/**
 * Starts the test package signed in, as a plain process, and measures it:
 *
 * - the memory of each of its processes (see `readProcessMemory`);
 * - the age labels on screen;
 * - each process's CPU and wakeups with the window visible, then hidden
 *   (see `sampleIdleUse`), and the age clock's fires in each state;
 * - with the window shown again, what 20 live nudges cost (see
 *   `measureNudges`);
 * - last, how long it took to show its window, step by step (see
 *   `LaunchTimes`), the measures that need a connection to main and to the
 *   page.
 *
 * With `opensThread`, the app is expected to open the last open thread, so
 * the first screen is that thread's transcript. With a `settingsSection`,
 * the script opens that section of Settings once the first screen is up (see
 * `openSettingsSection`). The launch times are then still the first
 * screen's, and the memory, the age labels, the idle samples and the nudges
 * are read with the section open.
 *
 * Fails when the app does not open its page within 10 s, when the section of
 * Settings has not rendered by the time memory is read, when the window is
 * not visible while it is sampled, when main showed the window without its
 * first screen, when the first screen is not the shell, or not the thread's
 * transcript when `opensThread` is set, or when the app does not quit
 * cleanly afterwards.
 */
async function measurePlainLaunch(
  userDataDir: string,
  fixture: ThreadFixture,
  opensThread: boolean,
  settingsSection: SettingsSection | null,
): Promise<PlainLaunch> {
  const spawnedAt = Date.now();
  const app = await launchPlainApp(userDataDir);
  const { inspectorUrl, endpoint } = app;
  let measured: PlainLaunch;
  try {
    const pageSocketUrl = await waitForPageSocketUrl(endpoint);
    const pageOpenedAt = Date.now();
    const sleepUntil = (msAfterOpen: number) =>
      sleep(Math.max(0, pageOpenedAt + msAfterOpen - Date.now()));

    if (settingsSection !== null) {
      await openSettingsSection(
        inspectorUrl,
        pageSocketUrl,
        settingsSection,
        pageOpenedAt + MEMORY_READ_AT_MS,
      );
    }
    await sleepUntil(MEMORY_READ_AT_MS);
    const memory = await readProcessMemory(app.process.pid!);
    const rendererPid = memory.find((sample) => sample.label === "Tab")?.pid;
    if (rendererPid === undefined) throw new Error("the app has no renderer process");

    await sleepUntil(AGES_READ_AT_MS);
    const agesOnScreen = (await evaluateInPage(pageSocketUrl, READ_AGES_ON_SCREEN)) as string[];

    await sleepUntil(VISIBLE_SAMPLE_AT_MS);
    const visibleCountFrom = Date.now();
    const visible = await sampleIdleUse(inspectorUrl);
    const shown = await evaluateInMain(
      inspectorUrl,
      `require("electron").BrowserWindow.getAllWindows()[0]?.isVisible()`,
    );
    if (shown !== true) throw new Error("the window was not visible while sampled");
    await sleepUntil(VISIBLE_SAMPLE_AT_MS + FIRE_COUNT_MS);
    await evaluateInMain(
      inspectorUrl,
      `require("electron").BrowserWindow.getAllWindows()[0]?.hide()`,
    );
    const hiddenCountFrom = Date.now();
    await sleep(HIDDEN_SETTLE_MS);
    const hidden = await sampleIdleUse(inspectorUrl);
    await sleep(Math.max(0, hiddenCountFrom + FIRE_COUNT_MS - Date.now()));

    // `showInactive` leaves the focus where it is, so the run does not take
    // the keyboard from whoever is using the machine.
    await evaluateInMain(
      inspectorUrl,
      `require("electron").BrowserWindow.getAllWindows()[0]?.showInactive()`,
    );
    await sleep(SHOW_SETTLE_MS);
    const fires = (await evaluateInPage(
      pageSocketUrl,
      `performance.getEntriesByName("age-clock-fire").map((entry) => performance.timeOrigin + entry.startTime)`,
    )) as number[];
    const countFires = (from: number) =>
      fires.filter((at) => at >= from && at < from + FIRE_COUNT_MS).length;
    const nudges = await measureNudges(pageSocketUrl, fixture, rendererPid);

    const mainSteps = (await evaluateInMain(inspectorUrl, READ_MAIN_LAUNCH_STEPS)) as {
      nodeReady: number;
      gpuProcess: number;
      rendererProcess: number;
      windowShown: number | null;
    };
    if (mainSteps.windowShown === null) {
      throw new Error("main has no window-shown mark, so it never showed the window");
    }
    if (app.readMainOutput().includes(SHOWN_WITHOUT_FIRST_SCREEN_ERROR)) {
      throw new Error(
        `main showed the window without its first screen, so the launch time is not the first screen's. Main's output:\n${app.readMainOutput()}`,
      );
    }

    const firstScreen = await pollUntil(
      async () =>
        ((await evaluateInPage(pageSocketUrl, READ_FIRST_SCREEN)) as FirstScreen | null) ??
        undefined,
      {
        timeoutMs: 10_000,
        intervalMs: 100,
        timeoutMessage: "the page did not mark first-paint and first-screen within 10 s",
      },
    );
    if (!firstScreen.showsShell) {
      throw new Error("the app did not open on the shell, so it was not signed in");
    }
    if (opensThread && !firstScreen.showsTranscript) {
      throw new Error("the app did not open the last open thread");
    }
    measured = {
      launch: {
        nodeReadyMs: mainSteps.nodeReady - spawnedAt,
        gpuProcessMs: mainSteps.gpuProcess - spawnedAt,
        rendererProcessMs: mainSteps.rendererProcess - spawnedAt,
        pageStartMs: firstScreen.pageStart - spawnedAt,
        firstPaintMs: firstScreen.firstPaint - spawnedAt,
        firstScreenMs: firstScreen.firstScreen - spawnedAt,
        windowShownMs: mainSteps.windowShown - spawnedAt,
      },
      memory,
      agesOnScreen,
      visible,
      hidden,
      firesVisible: countFires(visibleCountFrom),
      firesHidden: countFires(hiddenCountFrom),
      nudges,
    };
  } finally {
    await stopPlainApp(app);
  }
  assertExitedCleanly(app.process);
  return measured;
}

/**
 * Opens the section of Settings named `section` in the app's page, which
 * `pageSocketUrl` connects to, and returns once the section has rendered:
 * the main pane shows a heading that reads `section`. Fails when that has
 * not happened by `deadline`, in milliseconds since the epoch.
 *
 * Once the page shows the shell, main sends the page the `openSettings` menu
 * command, through main's inspector at `inspectorUrl`. Unlike the menu, main
 * sends the command without showing the window: the window is already shown,
 * and showing it again would take the keyboard focus. That command opens the
 * section opened last, so the script then clicks the section's row in the
 * page.
 *
 * One connection to the page serves every check, and it is closed before
 * the function returns, so nothing stays attached while memory is read.
 */
async function openSettingsSection(
  inspectorUrl: string,
  pageSocketUrl: string,
  section: SettingsSection,
  deadline: number,
): Promise<void> {
  const page = await connectInspector(pageSocketUrl);
  try {
    const waitInPage = (expression: string, timeoutMessage: string) =>
      pollUntil(
        async () =>
          (await page.evaluate("Runtime.evaluate", { expression, returnByValue: true })) === true
            ? true
            : undefined,
        { timeoutMs: Math.max(0, deadline - Date.now()), intervalMs: 100, timeoutMessage },
      );
    const sectionName = JSON.stringify(section);
    // The shell listens for menu commands from the moment it is on screen.
    await waitInPage(
      `performance.getEntriesByName("first-screen").length > 0 && document.querySelector("main") !== null`,
      "the app did not show the shell before memory was read",
    );
    await evaluateInMain(
      inspectorUrl,
      `require("electron").BrowserWindow.getAllWindows()[0].webContents.send("menu.command", "openSettings")`,
    );
    await waitInPage(
      `(() => {
        const row = [...document.querySelectorAll("main a")].find(
          (link) => link.textContent.trim() === ${sectionName},
        );
        row?.click();
        return row !== undefined;
      })()`,
      `Settings did not open with a row for ${section} before memory was read`,
    );
    await waitInPage(
      `[...document.querySelectorAll("main h1")].some((heading) => heading.textContent.trim() === ${sectionName})`,
      `Settings › ${section} did not render before memory was read`,
    );
  } finally {
    page.close();
  }
}

/**
 * An expression that evaluates, in the page, to the text of every age label
 * inside the visible part of the thread list, top to bottom. A mounted row
 * outside that part, in the list's overscan, is left out, because the age
 * clock does not keep its label current.
 */
const READ_AGES_ON_SCREEN = `(() => {
  const list = document.querySelector(".side-scroll").getBoundingClientRect();
  return [...document.querySelectorAll(".side-scroll .side-age")]
    .filter((label) => {
      const box = label.getBoundingClientRect();
      return box.bottom > list.top && box.top < list.bottom;
    })
    .map((label) => label.textContent);
})()`;

/**
 * When the page reached its first screen, in milliseconds since the epoch,
 * and which screen that was.
 */
interface FirstScreen {
  /** When the renderer started loading the page. */
  readonly pageStart: number;
  /** When the page first painted. */
  readonly firstPaint: number;
  /** When the frame that drew the first screen was presented. */
  readonly firstScreen: number;
  /** Whether the page shows the shell. Only the shell has a <main>; the connect and sign-in screens do not. */
  readonly showsShell: boolean;
  /** Whether the page shows a thread's transcript. */
  readonly showsTranscript: boolean;
}

/**
 * An expression that evaluates, in the page, to its `FirstScreen`, or to
 * null while the page has not yet marked both `first-paint` and
 * `first-screen`.
 */
const READ_FIRST_SCREEN = `(() => {
  const [firstPaint] = performance.getEntriesByName("first-paint");
  const [firstScreen] = performance.getEntriesByName("first-screen");
  if (firstPaint === undefined || firstScreen === undefined) return null;
  return {
    pageStart: performance.timeOrigin,
    firstPaint: performance.timeOrigin + firstPaint.startTime,
    firstScreen: performance.timeOrigin + firstScreen.startTime,
    showsShell: document.querySelector("main") !== null,
    showsTranscript: document.querySelector('section[aria-label="Transcript"]') !== null,
  };
})()`;

/**
 * An expression that evaluates, in main, to the launch steps main knows, in
 * milliseconds since the epoch: when its Node environment was ready, when it
 * started the GPU process and the renderer process, and when it showed the
 * window. The window's time is null when main never showed it.
 */
const READ_MAIN_LAUNCH_STEPS = `(() => {
  const metrics = require("electron").app.getAppMetrics();
  const findCreationTime = (type) => metrics.find((metric) => metric.type === type).creationTime;
  const shown = performance.getEntriesByName("window-shown")[0];
  return {
    nodeReady: performance.timeOrigin + performance.nodeTiming.environment,
    gpuProcess: findCreationTime("GPU"),
    rendererProcess: findCreationTime("Tab"),
    windowShown: shown === undefined ? null : performance.timeOrigin + shown.startTime,
  };
})()`;

/** Minutes per unit of an age label, by the label's last letter. */
const AGE_UNIT_MINUTES: Readonly<Record<string, number>> = {
  m: 1,
  h: 60,
  d: 60 * 24,
  w: 60 * 24 * 7,
};

/** Returns the youngest of the age labels `ages`, such as "2m", or "none" when there are none. */
function findYoungestAge(ages: readonly string[]): string {
  const minutes = (age: string) =>
    age === "now" ? 0 : Number.parseInt(age, 10) * AGE_UNIT_MINUTES[age.at(-1)!]!;
  return ages.toSorted((a, b) => minutes(a) - minutes(b))[0] ?? "none";
}

/**
 * Returns the CPU time the process `pid` has used so far, in milliseconds.
 * `ps` reports it to the hundredth of a second, as `[hours:]minutes:seconds`.
 */
async function readCpuMs(pid: number): Promise<number> {
  const { stdout } = await runFile("ps", ["-o", "time=", "-p", String(pid)]);
  return (
    stdout
      .trim()
      .split(":")
      .reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1_000
  );
}

/**
 * Nudges the app 20 times, 1 s apart, and returns what the nudges cost. A
 * nudge is one thread moving from busy to idle, or back, so the controller
 * pushes one change and the page reads the thread list again.
 *
 * The cost is read over the whole 22 s, from the first nudge to 2 s after the
 * last: the controller's and the renderer's CPU time with `ps`, and the time
 * the renderer's main thread spent in tasks from the page's DevTools
 * performance metrics. Each also holds whatever the process did while idle
 * in that time, so the numbers err high. The thread list's reads are counted
 * from the page's resource timing entries.
 */
async function measureNudges(
  pageSocketUrl: string,
  fixture: ThreadFixture,
  rendererPid: number,
): Promise<NudgeCost> {
  const controllerPid = fixture.readControllerPid();
  const page = await connectInspector(pageSocketUrl);
  try {
    await page.send("Performance.enable");
    const readMainThreadMs = async () => {
      const { metrics } = (await page.send("Performance.getMetrics")) as {
        metrics: { name: string; value: number }[];
      };
      const seconds = metrics.find((metric) => metric.name === "TaskDuration")?.value;
      if (seconds === undefined) throw new Error("the page reports no TaskDuration metric");
      return seconds * 1_000;
    };
    const readPageNow = async () =>
      (await page.evaluate("Runtime.evaluate", {
        expression: "performance.now()",
        returnByValue: true,
      })) as number;

    const readsFrom = await readPageNow();
    const before = {
      controller: await readCpuMs(controllerPid),
      renderer: await readCpuMs(rendererPid),
      mainThread: await readMainThreadMs(),
    };
    for (let nudge = 0; nudge < NUDGE_COUNT; nudge += 1) {
      fixture.nudge();
      await sleep(NUDGE_INTERVAL_MS);
    }
    await sleep(NUDGE_SETTLE_MS);
    const after = {
      controller: await readCpuMs(controllerPid),
      renderer: await readCpuMs(rendererPid),
      mainThread: await readMainThreadMs(),
    };
    const threadListReads = (await page.evaluate("Runtime.evaluate", {
      expression: `performance.getEntriesByType("resource").filter((entry) => {
        const url = new URL(entry.name);
        return entry.startTime >= ${String(readsFrom)} &&
          url.pathname === "/api/v1/sessions" && url.searchParams.get("thread") === "true";
      }).length`,
      returnByValue: true,
    })) as number;
    return {
      controllerCpuMs: after.controller - before.controller,
      rendererCpuMs: after.renderer - before.renderer,
      rendererMainThreadMs: after.mainThread - before.mainThread,
      threadListReads,
    };
  } finally {
    page.close();
  }
}

/** What one turn streaming at full speed into the open thread cost the renderer. */
interface StreamingCost {
  /** The longest task the renderer's main thread ran, in milliseconds. */
  readonly longestTaskMs: number;
  /** How many of the main thread's tasks took over 50 ms. */
  readonly longTasks: number;
  /** How many times the page changed the text of the paragraph being written. */
  readonly paragraphWrites: number;
  /** How many frames the page drew meanwhile. */
  readonly frames: number;
}

/**
 * The trace category that holds `RunTask`, the event Chromium records for
 * each task a thread runs. It is the category DevTools' Performance panel
 * records.
 */
const TIMELINE_CATEGORY = "disabled-by-default-devtools.timeline";

/** One event of a Chromium trace, with only the fields the script reads. */
interface TraceEvent {
  readonly name: string;
  /** The phase: `X` for an event with a duration, `M` for metadata such as a thread's name. */
  readonly ph: string;
  readonly pid: number;
  readonly tid: number;
  /** The duration, in microseconds, of an event whose phase is `X`. */
  readonly dur?: number;
  readonly args?: { readonly name?: string };
}

/**
 * Starts the signed-in app on `userDataDir` as a plain process, where it
 * opens `thread` again, and streams one turn into the thread at full speed:
 * a word every 2 ms for 10 s (see the fixture's `streamTurn`). Returns what
 * the turn cost the renderer, from the user's question until the turn
 * completed:
 *
 * - the longest task on the renderer's main thread, and how many took over
 *   50 ms, from a Chromium trace of the whole turn;
 * - how often the page changed the text of the paragraph being written, and
 *   how many frames it drew, from an observer and an animation frame loop in
 *   the page.
 *
 * The trace is recorded over the page's DevTools connection, which stays
 * open for the whole turn. Tracing costs the renderer a little time of its
 * own, so the tasks err long.
 *
 * Fails when the app does not open the thread, when the paragraph being
 * written never shows text, which means the stream did not reach the page,
 * when the trace lost events, or when the app does not quit cleanly
 * afterwards.
 */
async function measureStreaming(
  userDataDir: string,
  fixture: ThreadFixture,
  thread: LongThread,
): Promise<StreamingCost> {
  const app = await launchPlainApp(userDataDir);
  let measured: StreamingCost;
  try {
    const page = await connectInspector(await waitForPageSocketUrl(app.endpoint));
    try {
      const evaluate = (expression: string) =>
        page.evaluate("Runtime.evaluate", { expression, returnByValue: true });
      // The first screen is marked once the thread's screen has committed, and
      // with it the tap's subscription, so the stream's deltas reach the page.
      await pollUntil(
        async () => ((await evaluate(READ_TRANSCRIPT_SHOWN)) === true ? true : undefined),
        {
          timeoutMs: 10_000,
          intervalMs: 100,
          timeoutMessage: "the app did not open the last open thread",
        },
      );
      await evaluate(RECORD_PARAGRAPH_WRITES);
      await page.send("Tracing.start", {
        transferMode: "ReturnAsStream",
        traceConfig: { includedCategories: [TIMELINE_CATEGORY] },
      });
      await fixture.streamTurn(thread.id, STREAM_MS);
      await page.send("Tracing.end");
      const taskMs = findRendererMainTasks(await readTrace(page)).map(
        (event) => event.dur! / 1_000,
      );
      const { paragraphWrites, frames } = (await evaluate("globalThis.streamingCounts")) as {
        paragraphWrites: number;
        frames: number;
      };
      if (paragraphWrites === 0) {
        throw new Error(
          "the paragraph being written never showed text, so the stream never reached the page",
        );
      }
      measured = {
        longestTaskMs: Math.max(...taskMs),
        longTasks: taskMs.filter((ms) => ms > BUDGET.streamingTaskMs).length,
        paragraphWrites,
        frames,
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
 * An expression that evaluates, in the page, to whether the page has marked
 * its first screen and shows a thread's transcript.
 */
const READ_TRANSCRIPT_SHOWN = `performance.getEntriesByName("first-screen").length > 0 &&
  document.querySelector('section[aria-label="Transcript"]') !== null`;

/**
 * An expression that starts counting, in the page's `globalThis.streamingCounts`,
 * how often the page changes the text of the paragraph being written and how
 * many frames it draws. A change is one observer callback with a change
 * inside that paragraph: the callback runs once after each task that changed
 * the page.
 */
const RECORD_PARAGRAPH_WRITES = `(() => {
  const counts = { paragraphWrites: 0, frames: 0 };
  globalThis.streamingCounts = counts;
  const isInOpenParagraph = (node) =>
    (node instanceof Element ? node : node.parentElement)?.closest(".streaming") != null;
  new MutationObserver((records) => {
    if (records.some((record) => isInOpenParagraph(record.target))) counts.paragraphWrites += 1;
  }).observe(document.querySelector('section[aria-label="Transcript"]'), {
    subtree: true,
    childList: true,
    characterData: true,
  });
  const countFrame = () => {
    counts.frames += 1;
    requestAnimationFrame(countFrame);
  };
  requestAnimationFrame(countFrame);
})()`;

/**
 * Waits for the trace that `Tracing.end` finished on `page`, and returns its
 * events. Fails when the trace lost events because its buffer filled up.
 */
async function readTrace(page: Inspector): Promise<TraceEvent[]> {
  const { stream, dataLossOccurred } = (await page.waitForEvent("Tracing.tracingComplete")) as {
    stream: string;
    dataLossOccurred: boolean;
  };
  if (dataLossOccurred) throw new Error("the trace's buffer filled up, so the trace lost events");
  let text = "";
  for (;;) {
    const chunk = (await page.send("IO.read", { handle: stream })) as {
      data: string;
      eof: boolean;
      base64Encoded?: boolean;
    };
    text +=
      chunk.base64Encoded === true ? Buffer.from(chunk.data, "base64").toString() : chunk.data;
    if (chunk.eof) break;
  }
  await page.send("IO.close", { handle: stream });
  const trace = JSON.parse(text) as { traceEvents: TraceEvent[] } | TraceEvent[];
  return Array.isArray(trace) ? trace : trace.traceEvents;
}

/**
 * Returns the tasks the renderer's main thread ran in `events`: the `RunTask`
 * events of the thread named `CrRendererMain`. The app has one renderer.
 * Fails when the trace holds no such task.
 */
function findRendererMainTasks(events: readonly TraceEvent[]): TraceEvent[] {
  const mainThreads = new Set(
    events
      .filter((event) => event.name === "thread_name" && event.args?.name === "CrRendererMain")
      .map((event) => `${String(event.pid)}:${String(event.tid)}`),
  );
  const tasks = events.filter(
    (event) =>
      event.name === "RunTask" &&
      event.ph === "X" &&
      mainThreads.has(`${String(event.pid)}:${String(event.tid)}`),
  );
  if (tasks.length === 0) throw new Error("the trace holds no task of the renderer's main thread");
  return tasks;
}

/** Prints what streaming one turn into the open thread cost, against its budget. */
function reportStreaming(cost: StreamingCost, thread: LongThread): void {
  console.log(
    `## Streaming a turn at full speed, a word every 2 ms for ${String(STREAM_MS / 1_000)} s, ` +
      `into a thread of ${String(thread.rowCount)} transcript rows`,
  );
  console.log();
  console.log(
    formatTable(
      ["Budget", "Limit", "Measured", "Within"],
      [
        [
          "Renderer main thread, longest task",
          `no task over ${String(BUDGET.streamingTaskMs)} ms`,
          `${cost.longestTaskMs.toFixed(1)} ms (${String(cost.longTasks)} over ${String(BUDGET.streamingTaskMs)} ms)`,
          cost.longTasks === 0 ? "yes" : "over",
        ],
        [
          "Paragraph writes",
          "at most one a frame, over the whole turn",
          `${String(cost.paragraphWrites)} in ${String(cost.frames)} frames`,
          cost.paragraphWrites <= cost.frames ? "yes" : "over",
        ],
      ],
    ),
  );
  console.log();
}

/** Formats a process's CPU and wakeups as table cells, or dashes when it was not running. */
function formatUse(sample: ProcessUse | undefined): string[] {
  if (sample === undefined) return ["-", "-"];
  return [sample.cpuPercent.toFixed(1), sample.wakeupsPerSecond.toFixed(1)];
}

/** One measured launch: the threads it ran against, and what it measured. */
interface MeasuredLaunch extends PlainLaunch {
  /** The launch's name in the tables, such as "40 threads, run 2". */
  readonly name: string;
  readonly threadCount: number;
  /** Whether one row on screen showed minutes, so the age clock should fire once while visible. */
  readonly twoMinuteRow: boolean;
  /** The thread the app opened at launch, or `null` when it opened on the new-thread screen. */
  readonly openThread: LongThread | null;
  /** The machine's load average over the minute before the app was spawned. */
  readonly loadAtSpawn: number;
}

/** Formats a cost of all the nudges as the cost of one, with the total after it. */
const formatPerNudge = (totalMs: number) =>
  `${(totalMs / NUDGE_COUNT).toFixed(1)} ms a nudge (${totalMs.toFixed(0)} ms for ${String(NUDGE_COUNT)})`;

/** Prints one launch's memory, CPU and wakeups, and its readings against their budgets. */
function reportLaunch(measured: MeasuredLaunch): void {
  const { launch, memory, visible, hidden, nudges } = measured;
  const memoryRows = memory.map((sample) => [
    sample.label,
    String(sample.pid),
    sample.workingSetMb.toFixed(1),
    sample.footprintMb.toFixed(1),
  ]);
  const summedMb = memory.reduce((sum, sample) => sum + sample.workingSetMb, 0);
  const summedFootprintMb = memory.reduce((sum, sample) => sum + sample.footprintMb, 0);
  memoryRows.push(["Sum", "", summedMb.toFixed(1), summedFootprintMb.toFixed(1)]);
  const renderer = memory.find((sample) => sample.label === "Tab");
  const rendererMb = renderer?.workingSetMb ?? 0;
  const rendererFootprintMb = renderer?.footprintMb ?? 0;

  // A process that started or exited between the two samples is in one of
  // them only, so the table lists every process either sample saw.
  const seen = [...new Map([...visible, ...hidden].map((sample) => [sample.pid, sample.label]))];
  const useRows = seen.map(([pid, label]) => [
    label,
    String(pid),
    ...formatUse(visible.find((sample) => sample.pid === pid)),
    ...formatUse(hidden.find((sample) => sample.pid === pid)),
  ]);

  const gpuWakeups = findProcessUse(visible, "GPU")?.wakeupsPerSecond ?? 0;
  const rendererWakeupsVisible = findProcessUse(visible, "Tab")?.wakeupsPerSecond ?? 0;
  const rendererWakeupsHidden = findProcessUse(hidden, "Tab")?.wakeupsPerSecond ?? 0;
  const rendererLimit = `no wakeups from the app (at most ${BUDGET.rendererWakeups}/s)`;
  const expectedFiresVisible = measured.twoMinuteRow ? 1 : 0;
  // Spec 17 sets the nudge limit for 500 threads; at 40 the cost is recorded
  // only.
  const checksNudgeLimit = measured.threadCount === 500;

  // Budget, limit, measured, and whether the measurement is within the limit,
  // or null for a measure that is recorded but has no budget.
  const budgets: [string, string, string, boolean | null][] = [
    [
      "Launch, spawn to window shown",
      `shown within ${BUDGET.launchMs} ms of spawn (warm, signed in)`,
      `${launch.windowShownMs.toFixed(0)} ms`,
      launch.windowShownMs <= BUDGET.launchMs,
    ],
    ...(measured.openThread === null
      ? []
      : [
          [
            "Launch, spawn to the last thread's transcript",
            `painted within ${BUDGET.transcriptPaintMs} ms of spawn (warm, signed in)`,
            `${launch.firstScreenMs.toFixed(0)} ms`,
            launch.firstScreenMs <= BUDGET.transcriptPaintMs,
          ] satisfies [string, string, string, boolean],
        ]),
    [
      "Processes",
      `${BUDGET.processes}: browser, GPU, network utility, renderer`,
      `${memory.length}: ${memory.map((sample) => sample.label).join(", ")}`,
      memory.length <= BUDGET.processes,
    ],
    [
      "Footprint, summed",
      `at most ${BUDGET.summedFootprintMb} MB`,
      `${summedFootprintMb.toFixed(0)} MB`,
      summedFootprintMb <= BUDGET.summedFootprintMb,
    ],
    [
      "Footprint, renderer",
      `at most ${BUDGET.rendererFootprintMb} MB`,
      `${rendererFootprintMb.toFixed(0)} MB`,
      rendererFootprintMb <= BUDGET.rendererFootprintMb,
    ],
    ["Working set, summed", "recorded; not budgeted", `${summedMb.toFixed(0)} MB`, null],
    ["Working set, renderer", "recorded; not budgeted", `${rendererMb.toFixed(0)} MB`, null],
    [
      "Idle visible, GPU",
      `at most ${BUDGET.gpuWakeupsVisible} wakeups/s`,
      `${gpuWakeups.toFixed(1)}/s`,
      gpuWakeups <= BUDGET.gpuWakeupsVisible,
    ],
    [
      "Idle visible, renderer",
      rendererLimit,
      `${rendererWakeupsVisible.toFixed(1)}/s`,
      rendererWakeupsVisible <= BUDGET.rendererWakeups,
    ],
    [
      "Idle visible, age clock over 60 s",
      measured.twoMinuteRow
        ? "1 fire: one row on screen shows minutes"
        : "0 fires: every age on screen is over an hour",
      `${String(measured.firesVisible)} (${String(measured.agesOnScreen.length)} ages on screen, the youngest ${findYoungestAge(measured.agesOnScreen)})`,
      measured.firesVisible === expectedFiresVisible,
    ],
    [
      "Idle hidden, renderer",
      rendererLimit,
      `${rendererWakeupsHidden.toFixed(1)}/s`,
      rendererWakeupsHidden <= BUDGET.rendererWakeups,
    ],
    [
      "Idle hidden, age clock over 60 s",
      "0 fires: the clock is stopped while hidden",
      String(measured.firesHidden),
      measured.firesHidden === 0,
    ],
    [
      "Nudges, renderer main thread",
      checksNudgeLimit
        ? `at most ${BUDGET.rendererMainThreadPerNudgeMs} ms a nudge, one frame at 60 Hz`
        : "recorded; the limit is for 500 threads",
      formatPerNudge(nudges.rendererMainThreadMs),
      checksNudgeLimit
        ? nudges.rendererMainThreadMs / NUDGE_COUNT <= BUDGET.rendererMainThreadPerNudgeMs
        : null,
    ],
    ["Nudges, renderer CPU", "recorded; not budgeted", formatPerNudge(nudges.rendererCpuMs), null],
    [
      "Nudges, controller CPU",
      "recorded; not budgeted",
      formatPerNudge(nudges.controllerCpuMs),
      null,
    ],
    [
      "Nudges, thread list reads",
      "recorded; not budgeted",
      `${String(nudges.threadListReads)} for ${String(NUDGE_COUNT)} nudges`,
      null,
    ],
  ];

  console.log(`## ${measured.name}`);
  console.log();
  console.log(`Load average over the minute before the launch: ${measured.loadAtSpawn.toFixed(2)}`);
  console.log();
  console.log(
    `Launch steps, in ms from spawn (first screen: ${measured.openThread === null ? "the new-thread screen" : "the last thread's transcript"}):`,
  );
  console.log(
    formatTable(
      [
        "Main's Node ready",
        "GPU process",
        "Renderer process",
        "Page start",
        "First paint",
        "First screen",
        "Window shown",
      ],
      [
        [
          launch.nodeReadyMs,
          launch.gpuProcessMs,
          launch.rendererProcessMs,
          launch.pageStartMs,
          launch.firstPaintMs,
          launch.firstScreenMs,
          launch.windowShownMs,
        ].map((ms) => ms.toFixed(0)),
      ],
    ),
  );
  console.log();
  console.log("Memory, 13 s after the page opened:");
  console.log(formatTable(["Process", "PID", "Working set MB", "Footprint MB"], memoryRows));
  console.log();
  console.log(
    "CPU and wakeups over 10 s: visible from 30 s after the page opened, hidden from 3 s after hiding:",
  );
  const useHeader = ["CPU %", "Wakeups/s"];
  console.log(
    formatTable(
      [
        "Process",
        "PID",
        ...useHeader.map((cell) => `${cell}, visible`),
        ...useHeader.map((cell) => `${cell}, hidden`),
      ],
      useRows,
    ),
  );
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

const { launches, streaming, longThread, subagents } = await runWithThreadFixture(
  async (fixture) => {
    const userDataDir = mkdtempSync(join(tmpdir(), "hercule-desktop-perf-"));
    try {
      await fixture.growTo(40);
      writeSettings(userDataDir, { controllerUrl: fixture.url });
      await signInOnce(userDataDir);
      const measured: MeasuredLaunch[] = [];
      const measure = async (
        name: string,
        threadCount: number,
        twoMinuteRow: boolean,
        {
          openThread = null,
          settingsSection = null,
        }: {
          readonly openThread?: LongThread | null;
          readonly settingsSection?: SettingsSection | null;
        } = {},
      ) => {
        await fixture.prepareLaunch({ twoMinuteRow });
        if (openThread !== null) await openThreadOnce(userDataDir, openThread.title);
        await warmUpApp(userDataDir);
        measured.push({
          name,
          threadCount,
          twoMinuteRow,
          openThread,
          loadAtSpawn: loadavg()[0]!,
          ...(await measurePlainLaunch(userDataDir, fixture, openThread !== null, settingsSection)),
        });
      };
      await measure("40 threads, run 1", 40, false);
      await measure("40 threads, run 2", 40, true);
      for (const section of SETTINGS_SECTIONS) {
        await measure(`40 threads, Settings › ${section} open`, 40, false, {
          settingsSection: section,
        });
      }
      await fixture.growTo(500);
      await measure("500 threads, run 1", 500, false);
      const thread = await fixture.growTranscript(LONG_THREAD_ROWS);
      await measure(
        `500 threads, a thread of ${String(thread.rowCount)} transcript rows open`,
        500,
        false,
        { openThread: thread },
      );
      return {
        launches: measured,
        streaming: await measureStreaming(userDataDir, fixture, thread),
        longThread: thread,
        subagents: await measureSubagentLaunch(userDataDir, fixture, thread.id),
      };
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  },
);

for (const launch of launches) reportLaunch(launch);
reportStreaming(streaming, longThread);
reportSubagentLaunch(subagents);
