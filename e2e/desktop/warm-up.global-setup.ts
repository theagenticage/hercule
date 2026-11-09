/**
 * The vitest global setup of the desktop project: launches the packaged app
 * once, before any test, as a user's first launch on this machine, and checks
 * that the launch works. Every test after it then starts the app with a warm
 * graphics shader cache, as a user does from the second launch on.
 *
 * On Linux, Chromium draws with Mesa's llvmpipe, a software OpenGL driver
 * that compiles shaders with LLVM the first time it is used and keeps the
 * result in `~/.cache/mesa_shader_cache`. A launch with no such cache
 * presents its first frame about 1.4 seconds late on a free machine, and
 * several seconds late when other apps start at the same time. In a fresh
 * container the cache is empty, so the first test of every worker would pay
 * for it at the same moment, and a test that waits for the page's first frame
 * (see `launch.test.ts`) could run out of time. Here the cost is paid once,
 * by this launch, and this launch is the one cold start the suite checks.
 *
 * The launch is a plain process, as `launchPlainApp` starts it, so that main's
 * output is kept from the first byte: Playwright would attach to the app only
 * after it had started, and the line main logs when it shows the window on
 * its time limit could come before that. It uses the same environment as the
 * tests (the `HOME` the cache lives under included), a new user data
 * directory and the mock keychain, and saves no controller, so the app opens
 * on its first-run welcome.
 *
 * Does nothing on macOS, which has no such driver.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIRST_SCREEN_TIMEOUT_MS,
  SHOWN_WITHOUT_FIRST_SCREEN_ERROR,
} from "../../apps/desktop/src/main/window-visibility";
import {
  assertExitedCleanly,
  evaluateInMain,
  launchPlainApp,
  RUNS_ON_MAC,
  stopPlainApp,
  type PlainApp,
} from "../../apps/desktop/scripts/packaged-app";
import { pollUntil } from "../../apps/desktop/scripts/poll";

/**
 * How long the page may take to present its first frame on a machine with a
 * cold cache. It is the time it takes when something is wrong, not what is
 * expected: a healthy launch needs seconds at most.
 */
const FIRST_FRAME_LIMIT_MS = 60_000;

/**
 * How long to wait, after the first frame, for main's output to arrive. Main
 * logs its error just before it shows the window, but the output travels
 * through a pipe the setup reads on its own schedule.
 */
const OUTPUT_SETTLE_MS = 200;

/** When main showed the window and the page reached its first paint and first screen, in ms since the epoch. */
interface LaunchTimes {
  readonly windowShownAt: number;
  readonly firstPaintAt: number;
  readonly firstScreenAt: number;
}

/**
 * Asks the app for `LaunchTimes`, through main's inspector. Returns undefined
 * until the window exists and has recorded all three, and fails when the app
 * has exited.
 */
async function readLaunchTimes(app: PlainApp): Promise<LaunchTimes | undefined> {
  if (app.process.exitCode !== null || app.process.signalCode !== null) {
    throw new Error("the app exited before its page presented a frame");
  }
  const readPageTimes = `(() => {
    const read = (name) => {
      const [entry] = performance.getEntriesByName(name);
      return entry === undefined ? null : performance.timeOrigin + entry.startTime;
    };
    return { firstPaintAt: read("first-paint"), firstScreenAt: read("first-screen") };
  })()`;
  const times = (await evaluateInMain(
    app.inspectorUrl,
    `(async () => {
      const [window] = require("electron").BrowserWindow.getAllWindows();
      if (window === undefined) return null;
      const [shown] = performance.getEntriesByName("window-shown");
      return {
        windowShownAt: shown === undefined ? null : performance.timeOrigin + shown.startTime,
        ...(await window.webContents.executeJavaScript(${JSON.stringify(readPageTimes)})),
      };
    })()`,
  ).catch((error: unknown) => {
    // An app that exited while the call was in flight refuses the connection.
    if (app.process.exitCode !== null || app.process.signalCode !== null) {
      throw new Error("the app exited before its page presented a frame", { cause: error });
    }
    throw error;
  })) as {
    windowShownAt: number | null;
    firstPaintAt: number | null;
    firstScreenAt: number | null;
  } | null;
  if (times === null) return undefined;
  const { windowShownAt, firstPaintAt, firstScreenAt } = times;
  if (windowShownAt === null || firstPaintAt === null || firstScreenAt === null) return undefined;
  return { windowShownAt, firstPaintAt, firstScreenAt };
}

/**
 * Checks, from the times and from main's output, that main showed the window
 * because the page reported its first screen, not because its time limit ran
 * out. These are the checks of `launch.test.ts`, and the fallback's log line.
 * Returns the reason it did not, or undefined when it did.
 */
function findFallbackShow(times: LaunchTimes, mainOutput: string): string | undefined {
  if (mainOutput.includes(SHOWN_WITHOUT_FIRST_SCREEN_ERROR)) {
    return "main logged that it showed the window without waiting for the first screen";
  }
  // A hidden window under X11 presents no frame, so the frame the page marks
  // is the one that showing the window caused.
  if (times.firstScreenAt - times.windowShownAt <= 0) {
    return "the first screen was marked as presented before the window was shown";
  }
  if (times.windowShownAt - times.firstPaintAt >= FIRST_SCREEN_TIMEOUT_MS) {
    return "the window was shown by main's time limit, not by the page's report";
  }
  return undefined;
}

/**
 * Launches the test package on a new user data directory, waits until its page
 * has presented its first screen, and quits it. Fails, with the timings and
 * main's output, when the app does not present a frame within
 * `FIRST_FRAME_LIMIT_MS`, when main shows the window on its time limit
 * instead of on the page's report, when the app exits early, or when it does
 * not quit cleanly. A run whose app cannot start would fail every test, and
 * this names the cause.
 */
export default async function warmUpGraphicsCache(): Promise<void> {
  if (RUNS_ON_MAC) return;
  const userDataDir = mkdtempSync(join(tmpdir(), "hercule-desktop-warm-up-"));
  try {
    const startedAt = Date.now();
    const app = await launchPlainApp(userDataDir);
    let failure: Error | undefined;
    let timings: string | undefined;
    try {
      const times = await pollUntil(() => readLaunchTimes(app), {
        timeoutMs: FIRST_FRAME_LIMIT_MS,
        intervalMs: 100,
        timeoutMessage: () =>
          `the page presented no first frame within ${String(FIRST_FRAME_LIMIT_MS)} ms`,
      });
      timings = `the first frame was presented ${String(Math.round(times.firstScreenAt - startedAt))} ms after the launch`;
      await new Promise((resolve) => setTimeout(resolve, OUTPUT_SETTLE_MS));
      const fallback = findFallbackShow(times, app.readMainOutput());
      if (fallback !== undefined) throw new Error(fallback);
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    // The app is stopped on every path, and a failure to stop it never hides
    // why the launch failed.
    try {
      await stopPlainApp(app);
      assertExitedCleanly(app.process);
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
    }
    if (failure !== undefined) {
      throw new Error(
        `the first launch of the test package failed (${timings ?? `no first frame ${String(Date.now() - startedAt)} ms after the launch`}): ${failure.message}\nmain's output:\n${app.readMainOutput()}`,
        { cause: failure },
      );
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
}
