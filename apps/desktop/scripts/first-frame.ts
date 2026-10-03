/**
 * Checks that the desktop app's window already holds its whole first screen
 * at the moment macOS first puts it on screen, focus ring included. Re-run it
 * after every Electron upgrade: the check rests on Chromium behaviour that no
 * unit test covers, and an upgrade can change any of it:
 *
 * - a hidden window still draws and presents its page's frames;
 * - the `renderTime` of an Element Timing entry is the moment its frame was
 *   presented, and so reached the window, or, rarely, failed to present;
 * - the window shows the frame it holds, not an empty one, when `show()` is
 *   called.
 *
 * Run it after `pnpm build:desktop` and `pnpm build:binary`:
 *
 *     pnpm --filter @hercule/desktop first-frame [--repeat=<n>] [--at=<x>,<y>] [<case>...]
 *
 * The cases are `sign-in-light`, `sign-in-dark`, `shell-light` and
 * `shell-dark`: the screen the app opens on, and the app's theme. Without a
 * case it runs all four. `--repeat` sets how many times each case is
 * launched, 2 by default. `--at` opens the window with its top-left corner at
 * `x`,`y`, in points, in the coordinates Electron's `screen` module uses, so
 * it can open on a display nobody is working on, such as `--at=-2000,59`.
 * The equals sign keeps a negative `x` from being read as an option. Without
 * `--at` the window opens centred on the main display, as at a first launch.
 *
 * It needs the Screen Recording permission for the terminal it runs in, and
 * `swiftc` (Xcode's command line tools), to compile the recorder,
 * `./first-frame-recorder.swift`.
 *
 * Each launch goes like this:
 *
 * 1. It waits until no key or pointer has been used for 3 s and the screen is
 *    unlocked. The app is started through LaunchServices (`open`), as a user
 *    starts it, so its window takes the keyboard focus when it shows, and a
 *    key typed then would land in it.
 * 2. It starts the test package with `--inspect-brk=0`, so main waits on its
 *    first line, and prepares main through the inspector (see
 *    `prepareLaunch`) before the app's own code runs.
 * 3. Main stops again right after it creates its window, still hidden,
 *    before the window loads its page. The script starts the recorder on the
 *    window then, and lets main go on once the recorder is recording. The
 *    stop is needed because starting a recording takes over 100 ms, and the
 *    window can show sooner than that after it is created. Nothing the check
 *    measures has started while main waits. The recorder records the window
 *    with ScreenCaptureKit, which reads the window's own buffer, until 1 s
 *    after it went on screen. ScreenCaptureKit delivers no frame of a window
 *    that has never been on screen, so the first frame it delivers is the
 *    first the window showed. A capture of the page, as Playwright or
 *    `capturePage` takes one, cannot see this: it reads the page's pixels,
 *    not what the window holds when it shows.
 * 4. It stops the app, and judges the launch. A launch passes when:
 *    - main showed the window on the page's report, not on its time limit;
 *    - the page saw its frame presented before main called `show()`, and
 *      `show()` was called before the window went on screen;
 *    - the style that hides the caret reached the page before `show()`;
 *    - on the sign-in screen, the focused field showed its focus ring when
 *      the frame was presented. The shell focuses nothing at launch;
 *    - the first frame the window showed is the same, pixel for pixel, as the
 *      window 1 s later, when everything has settled. The corner with the
 *      traffic lights is left out (see `LIGHTS_CORNER_PT`).
 *
 * It prints a table with one row per launch, with each time in milliseconds
 * from the moment the page's frame was presented. The frames of a launch that
 * failed are kept as PNG files, in a folder the script names; it exits with
 * code 1 when any launch failed.
 *
 * Everything runs on scratch folders and a scratch controller (see
 * `runWithScratchController`), and the theme is the app's own
 * (`nativeTheme.themeSource`): the script never changes the Mac's appearance.
 */
import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { parseArgs } from "node:util";
import type { App, NativeTheme } from "electron";
// The extensions are spelled out because Node runs this script as it is, and
// Node resolves no import without one.
import { compareBitmaps, OUTSIDE_CELLS, type Bitmap } from "./compare-bitmaps.ts";
import {
  buildAppArgs,
  buildBinaryPathArgument,
  connectInspector,
  evaluateInMain,
  findPackagedApp,
  formatTable,
  MOCK_KEYCHAIN_SWITCH,
  runWithScratchController,
  signInOnce,
  stopApp,
  writeSettings,
} from "./packaged-app.ts";
import { pollUntil } from "./poll.ts";
import type { WindowState } from "../src/main/app-settings.ts";
import { DEFAULT_WINDOW_SIZE } from "../src/main/window-placement.ts";
import { SHOWN_WITHOUT_FIRST_SCREEN_ERROR } from "../src/main/window-visibility.ts";

type Theme = "light" | "dark";

/** The launches the script knows: the screen the app opens on, and its theme. */
const CASES = {
  "sign-in-light": { signedIn: false, theme: "light" },
  "sign-in-dark": { signedIn: false, theme: "dark" },
  "shell-light": { signedIn: true, theme: "light" },
  "shell-dark": { signedIn: true, theme: "dark" },
} as const satisfies Record<string, { readonly signedIn: boolean; readonly theme: Theme }>;

type CaseName = keyof typeof CASES;

/**
 * How long the recorder goes on after the window went on screen. The last
 * frame by then is the settled window, which the first one is compared with.
 */
const RECORD_AFTER_ON_SCREEN_MS = 1000;

/** How long no key or pointer must have been used before a launch. */
const IDLE_BEFORE_LAUNCH_MS = 3000;

/**
 * The top-left corner of the window, in points, that the comparison leaves
 * out. It holds the traffic lights, which macOS draws on its own schedule as
 * the window becomes the key window, and the "window is being shared"
 * indicator it draws over them while the window is recorded. On macOS 15 the
 * two change pixels only within the top-left 72 by 30 points; the corner
 * leaves a margin around that.
 */
const LIGHTS_CORNER_PT = { width: 80, height: 36 };

/**
 * The script the page runs as soon as its navigation commits, before the
 * app's own code. It watches for the Element Timing entry of the sentinel the
 * page adds to time its first screen (`elementtiming="presented-frame"`, see
 * `src/renderer/app/presented-frame.ts`), and keeps what it saw in
 * `globalThis.firstFrameRecord`, each time in milliseconds since the epoch:
 *
 * - `registeredAt`: when this observer started;
 * - `presentedAt`: when the frame that drew the first screen reached the
 *   window, the entry's `renderTime`;
 * - `observedAt`: when this observer received the entry. Chromium hands an
 *   entry to every observer of the page in the same task, so this is also
 *   when the page's own wait received it, and then reported to main;
 * - `focusRing`: whether the focused element showed its focus ring then.
 *
 * It asks for buffered entries too, so it still finds the entry when it
 * starts late; `registeredAt` then comes after `presentedAt`, and
 * `observedAt` is not the page's time. The script is text, not a function,
 * because this file is type-checked without the browser's types.
 */
const OBSERVE_PRESENTED_FRAME = `(() => {
  const readEpochMs = () => performance.timeOrigin + performance.now();
  const registeredAt = readEpochMs();
  const observer = new PerformanceObserver((list) => {
    const entry = list.getEntries().find((candidate) => candidate.identifier === "presented-frame");
    if (entry === undefined) return;
    observer.disconnect();
    const focused = document.activeElement;
    globalThis.firstFrameRecord = {
      registeredAt,
      presentedAt: performance.timeOrigin + entry.renderTime,
      observedAt: readEpochMs(),
      focusRing: focused !== null && focused.matches(":focus-visible"),
    };
  });
  observer.observe({ type: "element", buffered: true });
})()`;

/**
 * Prepares the app's main process for a recorded launch. It runs in main
 * while main waits on its first line, before the app's own code:
 *
 * - It sets the app's theme once the app is ready, before the window exists.
 * - It lets the pointer through the window, so a pointer resting where the
 *   window opens cannot draw a hover state after the window shows.
 * - When the page's navigation commits, it hides the caret, whose blinking
 *   would make every comparison a matter of chance, and starts
 *   `OBSERVE_PRESENTED_FRAME` in the page.
 * - It keeps a `MainRecord` in `globalThis.firstFrameMainRecord`: when main
 *   first called the window's `show()`, and when the style that hides the
 *   caret had reached the page.
 * - Once the window is created, it stops main at a `debugger` statement,
 *   while the script starts the recorder on the window (see `recordLaunch`).
 *
 * The function reaches main as its source text, so it uses nothing from
 * outside itself.
 */
function prepareLaunch(
  { app, nativeTheme }: { readonly app: App; readonly nativeTheme: NativeTheme },
  { theme, pageScript }: { readonly theme: Theme; readonly pageScript: string },
): void {
  const readEpochMs = () => performance.timeOrigin + performance.now();
  const record: MainRecord = { showCalledAt: null, caretHiddenAt: null };
  (globalThis as { firstFrameMainRecord?: MainRecord }).firstFrameMainRecord = record;
  app.once("ready", () => {
    nativeTheme.themeSource = theme;
  });
  app.once("browser-window-created", (_event, window) => {
    window.setIgnoreMouseEvents(true);
    const show = window.show.bind(window);
    window.show = () => {
      record.showCalledAt ??= readEpochMs();
      show();
    };
    window.webContents.once("did-navigate", () => {
      void window.webContents.insertCSS("* { caret-color: transparent !important; }").then(() => {
        record.caretHiddenAt = readEpochMs();
      });
      void window.webContents.executeJavaScript(pageScript);
    });
    // eslint-disable-next-line no-debugger -- the script's inspector stops main here, on purpose, to start the recorder before the window can show.
    debugger;
  });
}

/** What `prepareLaunch` kept in main, each time in milliseconds since the epoch. */
interface MainRecord {
  /** When main first called `show()`, or null when it never did. */
  showCalledAt: number | null;
  /** When the style that hides the caret had reached the page, or null when it never did. */
  caretHiddenAt: number | null;
}

/** What `OBSERVE_PRESENTED_FRAME` kept in the page. */
interface PageRecord {
  readonly registeredAt: number;
  readonly presentedAt: number;
  readonly observedAt: number;
  readonly focusRing: boolean;
}

/** A frame the recorder wrote: `<file>.bgra` holds its pixels, BGRA, rows packed. */
interface RecordedFrame {
  /** When macOS composited the frame, in milliseconds since the epoch. */
  readonly at: number;
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

/** What the recorder recorded of one launch. */
interface Recording {
  /** The window's width in points, as main created it. */
  readonly widthPt: number;
  /** When macOS first reported the window on screen, in milliseconds since the epoch. */
  readonly onScreenAt: number;
  /** Every frame whose pixels differ from the frame before, in the order they came. */
  readonly frames: ReadonlyArray<RecordedFrame>;
}

/** Everything one launch recorded, in the app and outside it. */
interface Launch extends Readonly<MainRecord> {
  /** What the page saw, or null when it never saw its frame presented. */
  readonly page: PageRecord | null;
  readonly recording: Recording;
  /** What main wrote to its standard output and error. */
  readonly mainOutput: string;
}

/** The recorder, started on one launch. */
interface Recorder {
  /** Settles once the recorder is recording the window; fails when the recorder fails first. */
  readonly ready: Promise<void>;
  /** Settles with the recording once the recorder is done; fails when the recorder fails. */
  readonly finished: Promise<Recording>;
  readonly process: ChildProcessByStdio<null, Readable, Readable>;
}

/** The window to record: its number in the window server, and its size in points. */
interface RecordedWindow {
  readonly id: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Starts the compiled recorder on `window`, writing its frames into
 * `folder`, and follows its output (see `./first-frame-recorder.swift`). The
 * output is also kept in `folder`, as `recorder.jsonl`, to explain a failed
 * launch.
 */
function startRecorder(recorder: string, window: RecordedWindow, folder: string): Recorder {
  const args = [
    ...[window.id, window.width, window.height].map(String),
    folder,
    String(RECORD_AFTER_ON_SCREEN_MS),
  ];
  const child = spawn(recorder, args, { stdio: ["ignore", "pipe", "pipe"] });
  let errors = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (errors += chunk));
  let markReady: () => void = () => undefined;
  let failReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  const finished = new Promise<Recording>((resolve, reject) => {
    let onScreenAt: number | null = null;
    const frames: RecordedFrame[] = [];
    const fail = (error: Error) => {
      failReady(error);
      reject(error);
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      appendFileSync(join(folder, "recorder.jsonl"), `${line}\n`);
      const message = JSON.parse(line) as Record<string, unknown>;
      if ("ready" in message) markReady();
      if ("onScreen" in message) onScreenAt = message["onScreen"] as number;
      if ("frame" in message) frames.push(message as unknown as RecordedFrame);
      if ("error" in message) fail(new Error(`the recorder failed: ${String(message["error"])}`));
      if ("done" in message) {
        if (onScreenAt === null) {
          fail(new Error("the recorder finished without seeing the window go on screen"));
        } else {
          resolve({ widthPt: window.width, onScreenAt, frames });
        }
      }
    });
    // `close`, not `exit`: the output can still hold lines when the process exits.
    child.once("close", (code) =>
      fail(
        new Error(`the recorder exited with code ${String(code)} before it was done: ${errors}`),
      ),
    );
  });
  // Whichever of the two promises the caller is not waiting on must not
  // become an unhandled rejection.
  ready.catch(() => undefined);
  finished.catch(() => undefined);
  return { ready, finished, process: child };
}

/** Returns what `file` holds, or an empty string when it does not exist yet. */
const readIfPresent = (file: string): string =>
  existsSync(file) ? readFileSync(file, "utf8") : "";

/** Returns how long no key or pointer has been used, in milliseconds, as macOS counts it. */
function readIdleMs(): number {
  const found = /"HIDIdleTime" = (\d+)/.exec(
    execFileSync("ioreg", ["-c", "IOHIDSystem"], { encoding: "utf8" }),
  );
  if (found === null) throw new Error("ioreg did not report how long the keyboard has been idle");
  return Number(found[1]) / 1e6;
}

/** Checks whether the screen is locked. */
function isScreenLocked(): boolean {
  const session = execFileSync("ioreg", ["-n", "Root", "-d1", "-a"], { encoding: "utf8" });
  return /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(session);
}

/** Checks whether no key or pointer has been used for `IDLE_BEFORE_LAUNCH_MS`, with the screen unlocked. */
const isIdleAndUnlocked = (): boolean => readIdleMs() >= IDLE_BEFORE_LAUNCH_MS && !isScreenLocked();

/**
 * Waits until no key or pointer has been used for `IDLE_BEFORE_LAUNCH_MS`
 * and the screen is unlocked, and prints once that it is waiting. Fails after
 * 5 minutes.
 */
async function waitUntilIdle(): Promise<void> {
  if (isIdleAndUnlocked()) return;
  console.log("Waiting until no key or pointer has been used for 3 s, with the screen unlocked...");
  await pollUntil(() => (isIdleAndUnlocked() ? true : undefined), {
    timeoutMs: 5 * 60_000,
    intervalMs: 500,
    timeoutMessage:
      "the keyboard and pointer were never idle for 3 s in 5 minutes, so no launch was started",
  });
}

/**
 * Launches the test package on `userDataDir`, in `theme`, records its window
 * into `folder` with the compiled `recorder`, and stops it. Returns what the
 * launch recorded, main's output included. Fails when the app, its inspector
 * or the recorder fails.
 */
async function recordLaunch(
  recorder: string,
  userDataDir: string,
  theme: Theme,
  folder: string,
): Promise<Launch> {
  const stdout = join(folder, "main-stdout.txt");
  const stderr = join(folder, "main-stderr.txt");
  await waitUntilIdle();
  execFileSync("open", [
    "-n",
    findPackagedApp("test"),
    "--stdout",
    stdout,
    "--stderr",
    stderr,
    "--args",
    // A packaged app refuses any argument but `buildAppArgs`'s while its
    // inspector is closed; this one opens it (see `MOCK_KEYCHAIN_SWITCH` and
    // `buildBinaryPathArgument`).
    "--inspect-brk=0",
    ...buildAppArgs(userDataDir),
    MOCK_KEYCHAIN_SWITCH,
    buildBinaryPathArgument(userDataDir),
  ]);
  const inspectorUrl = await pollUntil(
    () => /Debugger listening on (ws:\/\/\S+)/.exec(readIfPresent(stderr))?.[1],
    {
      timeoutMs: 10_000,
      intervalMs: 10,
      timeoutMessage: "the app did not open its inspector within 10 s",
    },
  );

  let pid: number | null = null;
  let started: Recorder | null = null;
  let read: Omit<Launch, "mainOutput">;
  try {
    const inspector = await connectInspector(inspectorUrl);
    try {
      /**
       * Waits until main stops, and returns a function that evaluates an
       * expression where it stopped. `require` is not a global in main; the
       * inspector's command line API supplies it to the expression.
       */
      const waitForPause = async () => {
        const paused = (await inspector.waitForEvent("Debugger.paused")) as {
          readonly callFrames: ReadonlyArray<{ readonly callFrameId: string }>;
        };
        return (expression: string) =>
          inspector.evaluate("Debugger.evaluateOnCallFrame", {
            callFrameId: paused.callFrames[0]!.callFrameId,
            expression,
            includeCommandLineAPI: true,
            returnByValue: true,
          });
      };
      await inspector.send("Runtime.enable");
      await inspector.send("Debugger.enable");
      await inspector.send("Runtime.runIfWaitingForDebugger");

      const evaluateOnFirstLine = await waitForPause();
      pid = (await evaluateOnFirstLine("process.pid")) as number;
      const options = { theme, pageScript: OBSERVE_PRESENTED_FRAME };
      await evaluateOnFirstLine(
        `(${prepareLaunch.toString()})(require("electron"), ${JSON.stringify(options)})`,
      );
      await inspector.send("Debugger.resume");

      // Main stops next where `prepareLaunch` stops it: the window has just
      // been created, hidden, and `window` is the window.
      const evaluateInNewWindow = await waitForPause();
      const created = (await evaluateInNewWindow(
        "({ sourceId: window.getMediaSourceId(), bounds: window.getBounds() })",
      )) as { readonly sourceId: string; readonly bounds: Electron.Rectangle };
      const windowId = /^window:(\d+):/.exec(created.sourceId)?.[1];
      if (windowId === undefined) {
        throw new Error(
          `main gave the window a media source ID the recorder cannot use: ${created.sourceId}`,
        );
      }
      const { width, height } = created.bounds;
      started = startRecorder(recorder, { id: Number(windowId), width, height }, folder);
      await started.ready;
      await inspector.send("Debugger.resume");
    } finally {
      inspector.close();
    }

    const recording = await started.finished;
    const inApp = (await evaluateInMain(
      inspectorUrl,
      `(async () => {
        const { BrowserWindow } = require("electron");
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        const page = await contents.executeJavaScript("globalThis.firstFrameRecord ?? null");
        return { page, ...globalThis.firstFrameMainRecord };
      })()`,
    )) as MainRecord & { readonly page: PageRecord | null };
    read = { ...inApp, recording };
  } finally {
    if (started !== null && started.process.exitCode === null) started.process.kill();
    if (pid !== null) await stopApp(pid);
  }
  return { ...read, mainOutput: readIfPresent(stdout) + readIfPresent(stderr) };
}

/** Reads the pixels of a frame the recorder wrote into `folder`. */
function readFrame(folder: string, frame: RecordedFrame): Bitmap {
  return {
    width: frame.width,
    height: frame.height,
    pixels: readFileSync(join(folder, `${frame.file}.bgra`)),
  };
}

/** The outcome of one launch, as the table shows it. */
interface Verdict {
  /** The table's cells for the launch, after its name. */
  readonly cells: ReadonlyArray<string>;
  /** What went wrong, empty when the launch passed. */
  readonly problems: ReadonlyArray<string>;
}

/** Formats a time as milliseconds after `start`, or a dash when there is none. */
const formatSince = (time: number | null | undefined, start: number): string =>
  time === null || time === undefined
    ? "-"
    : `${time - start >= 0 ? "+" : ""}${(time - start).toFixed(1)}`;

/**
 * Judges one launch whose frames are in `folder` (see the module's docstring
 * for what passes). `expectsFocusRing` is whether the screen the app opened
 * on focuses a field, as the sign-in screen focuses its Username field.
 */
function judgeLaunch(launch: Launch, folder: string, expectsFocusRing: boolean): Verdict {
  const { page, showCalledAt, caretHiddenAt, recording } = launch;
  const problems: string[] = [];
  if (launch.mainOutput.includes(SHOWN_WITHOUT_FIRST_SCREEN_ERROR)) {
    problems.push(`main showed the window without the page's report: ${launch.mainOutput.trim()}`);
  }
  if (page === null) problems.push("the page never saw its first screen's frame presented");
  if (showCalledAt === null) problems.push("main never called show()");
  if (page !== null && page.registeredAt > page.presentedAt) {
    problems.push(
      `the check's page observer started ${(page.registeredAt - page.presentedAt).toFixed(1)} ms after the frame was presented, so it could not time the page's own observer`,
    );
  }
  if (page !== null && showCalledAt !== null && !(page.observedAt < showCalledAt)) {
    problems.push("main called show() before the page saw its frame presented");
  }
  if (showCalledAt !== null && !(showCalledAt < recording.onScreenAt)) {
    problems.push("macOS reported the window on screen before main called show()");
  }
  if (caretHiddenAt === null)
    problems.push("the style that hides the caret never reached the page");
  if (caretHiddenAt !== null && showCalledAt !== null && !(caretHiddenAt < showCalledAt)) {
    problems.push(
      "the style that hides the caret reached the page only after main called show(), so the frames may differ by the caret",
    );
  }
  if (expectsFocusRing && page !== null && !page.focusRing) {
    problems.push("the screen's focused field showed no focus ring when its frame was presented");
  }

  // ScreenCaptureKit delivers no frame of a window that has never been on
  // screen, so the first frame it delivers is the first the window showed.
  // A frame from before `show()` would mean that no longer holds, and the
  // first frame could be one nobody saw.
  const visible = recording.frames[0];
  const settled = recording.frames.at(-1);
  if (visible === undefined) problems.push("the recorder received no frame of the window");
  if (visible !== undefined && showCalledAt !== null && visible.at < showCalledAt) {
    problems.push(
      `the recorder received a frame (${visible.file}) before main called show(), so it cannot tell which frame the window showed first`,
    );
  }
  let differs = "-";
  if (visible !== undefined && settled !== undefined) {
    const scale = visible.width / recording.widthPt;
    const corner = {
      name: "traffic lights",
      left: 0,
      top: 0,
      width: Math.ceil(LIGHTS_CORNER_PT.width * scale),
      height: Math.ceil(LIGHTS_CORNER_PT.height * scale),
    };
    try {
      const outside = compareBitmaps(readFrame(folder, visible), readFrame(folder, settled), [
        corner,
      ]).find((difference) => difference.cell === OUTSIDE_CELLS);
      differs = String(outside?.pixels ?? 0);
      if (outside !== undefined) {
        const { left, top, right, bottom } = outside.box;
        problems.push(
          `the first frame the window showed (${visible.file}) differs from the settled window (${settled.file}) in ${String(outside.pixels)} pixels, from (${String(left)}, ${String(top)}) to (${String(right)}, ${String(bottom)}) in device pixels`,
        );
      }
    } catch (error) {
      problems.push(`the frames could not be compared: ${(error as Error).message}`);
    }
  }

  const start = page?.presentedAt ?? recording.onScreenAt;
  return {
    cells: [
      formatSince(page?.observedAt, start),
      formatSince(showCalledAt, start),
      formatSince(recording.onScreenAt, start),
      visible === undefined ? "none" : `${formatSince(visible.at, start)} (${visible.file})`,
      differs,
      page === null ? "-" : page.focusRing ? "yes" : "no",
    ],
    problems,
  };
}

/**
 * Parses `--at`'s `<x>,<y>` into the window's saved state: the window with
 * its top-left corner there, at its first-launch size, not full screen.
 * Fails when the text is not two whole numbers.
 */
function parseSavedWindow(text: string): WindowState {
  const found = /^(-?\d+),(-?\d+)$/.exec(text);
  if (found === null) {
    throw new Error(
      `--at takes the window's top-left corner as <x>,<y> in points, such as --at=-2000,59, not "${text}".`,
    );
  }
  return {
    bounds: { x: Number(found[1]), y: Number(found[2]), ...DEFAULT_WINDOW_SIZE },
    fullScreen: false,
  };
}

const { values, positionals } = parseArgs({
  options: { repeat: { type: "string", default: "2" }, at: { type: "string" } },
  allowPositionals: true,
});
const repeat = Number(values.repeat);
if (!Number.isInteger(repeat) || repeat < 1) {
  throw new Error(
    `--repeat takes how many times to launch each case, 1 or more, not "${values.repeat}".`,
  );
}
for (const name of positionals) {
  if (!(name in CASES)) {
    throw new Error(`There is no case "${name}". The cases are ${Object.keys(CASES).join(", ")}.`);
  }
}
const caseNames = (positionals.length === 0 ? Object.keys(CASES) : positionals) as CaseName[];
const savedWindow = values.at === undefined ? null : parseSavedWindow(values.at);
findPackagedApp("test");

// The frames of a failed launch stay in `framesFolder`; everything in
// `workFolder` is deleted at the end.
const workFolder = mkdtempSync(join(tmpdir(), "hercule-desktop-first-frame-work-"));
const framesFolder = mkdtempSync(join(tmpdir(), "hercule-desktop-first-frame-"));
const rows: string[][] = [];
const failures: string[] = [];
try {
  const recorder = join(workFolder, "first-frame-recorder");
  try {
    const source = join(import.meta.dirname, "first-frame-recorder.swift");
    execFileSync("swiftc", ["-O", "-o", recorder, source], { stdio: "inherit" });
  } catch (error) {
    throw new Error(
      "could not compile the recorder with swiftc, which comes with Xcode's command line tools (xcode-select --install)",
      { cause: error },
    );
  }

  await runWithScratchController(async (controllerUrl) => {
    // One user data directory per screen, used by every launch of it, as a
    // user's is.
    const userDataDirs = {
      signedOut: join(workFolder, "signed-out"),
      signedIn: join(workFolder, "signed-in"),
    };
    for (const dir of Object.values(userDataDirs)) {
      mkdirSync(dir);
      writeSettings(
        dir,
        savedWindow === null ? { controllerUrl } : { controllerUrl, window: savedWindow },
      );
    }
    if (caseNames.some((name) => CASES[name].signedIn)) {
      await waitUntilIdle();
      await signInOnce(userDataDirs.signedIn);
    }

    for (let round = 1; round <= repeat; round++) {
      for (const name of caseNames) {
        const { signedIn, theme } = CASES[name];
        const userDataDir = signedIn ? userDataDirs.signedIn : userDataDirs.signedOut;
        const label = `${name} #${String(round)}`;
        const folder = join(framesFolder, `${name}-${String(round)}`);
        mkdirSync(folder);
        // The sign-in screen focuses its Username field; the shell focuses nothing.
        const { cells, problems } = judgeLaunch(
          await recordLaunch(recorder, userDataDir, theme, folder),
          folder,
          !signedIn,
        );
        rows.push([label, ...cells, problems.length === 0 ? "pass" : "FAIL"]);
        console.log(
          `${label}: ${problems.length === 0 ? "pass" : `FAIL\n  ${problems.join("\n  ")}`}`,
        );
        if (problems.length === 0) {
          rmSync(folder, { recursive: true, force: true });
        } else {
          failures.push(`${label}: ${problems.join("; ")} (frames in ${folder})`);
        }
      }
    }
  });
} finally {
  rmSync(workFolder, { recursive: true, force: true });
  if (failures.length === 0) rmSync(framesFolder, { recursive: true, force: true });
}

console.log();
console.log(
  "Times in ms from the moment the page's first screen was presented (its Element Timing renderTime):",
);
console.log(
  formatTable(
    [
      "Launch",
      "Page saw it",
      "show() called",
      "On screen",
      "First frame composited",
      "Pixels differing from settled",
      "Focus ring",
      "Result",
    ],
    rows,
  ),
);
if (failures.length > 0) {
  console.log(
    `\n${String(failures.length)} of ${String(rows.length)} launches failed:\n${failures.join("\n")}`,
  );
  process.exitCode = 1;
}
