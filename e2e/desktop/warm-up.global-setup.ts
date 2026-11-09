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
import { setTimeout as sleep } from "node:timers/promises";
import { SHOWN_WITHOUT_FIRST_SCREEN_ERROR } from "../../apps/desktop/src/main/window-visibility";
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
 * How long to wait, after the app has exited, for the pipes that carry its
 * output to reach their end. A process the app started that outlives it can
 * hold a pipe open, and the check then reads what has arrived.
 */
const OUTPUT_DRAIN_LIMIT_MS = 5_000;

/**
 * Returns true when the app's page has set its `first-screen` mark, which
 * means the frame that draws its first screen has been presented, and false
 * before that. Fails when the app has exited. Reaches the page through main's
 * inspector, so it has no limit of its own: the caller bounds it.
 */
async function hasPresentedFirstScreen(app: PlainApp): Promise<boolean> {
  if (app.process.exitCode !== null || app.process.signalCode !== null) {
    throw new Error("the app exited before its page presented a frame");
  }
  const presented = await evaluateInMain(
    app.inspectorUrl,
    `(async () => {
      const [window] = require("electron").BrowserWindow.getAllWindows();
      if (window === undefined) return false;
      return window.webContents.executeJavaScript(
        'performance.getEntriesByName("first-screen").length > 0',
      );
    })()`,
  );
  return presented === true;
}

/**
 * Waits until the page has presented its first screen, and returns how many
 * milliseconds after `startedAt` that was. Fails when the app exits first, and
 * when `FIRST_FRAME_LIMIT_MS` has passed, however the app and its inspector
 * behave: the limit is a timer of its own, so an inspector that never answers
 * cannot hold the wait. The reads that are then still pending end when the
 * caller stops the app.
 */
async function waitForFirstFrame(app: PlainApp, startedAt: number): Promise<number> {
  const reading = pollUntil(
    async () => ((await hasPresentedFirstScreen(app)) ? Date.now() - startedAt : undefined),
    {
      timeoutMs: FIRST_FRAME_LIMIT_MS,
      intervalMs: 100,
      timeoutMessage: `the page presented no first frame within ${String(FIRST_FRAME_LIMIT_MS)} ms`,
    },
  );
  // After the limit passes nobody awaits the reads, and their late failure
  // must not become an unhandled rejection. The timers are not ref'd, so a
  // wait that has ended does not keep the process alive.
  reading.catch(() => undefined);
  return Promise.race([
    reading,
    sleep(FIRST_FRAME_LIMIT_MS + 1_000, undefined, { ref: false }).then(() => {
      throw new Error(
        `the app did not answer within ${String(FIRST_FRAME_LIMIT_MS)} ms, so its page cannot be asked for a first frame`,
      );
    }),
  ]);
}

/**
 * Launches the test package on a new user data directory, waits until its page
 * has presented its first screen, and quits it. Fails, with the timings and
 * main's complete output, when the app does not present a frame within
 * `FIRST_FRAME_LIMIT_MS`, when it stops answering, when main logged that it
 * showed the window on its time limit instead of on the page's report, or when
 * it does not quit cleanly. A run whose app cannot start would fail every test,
 * and this names the cause.
 *
 * The app is stopped on every path, through its own process (`stopPlainApp`
 * kills it when it does not quit in time), never through anything that has
 * to answer. Main's output is read only after the process has ended and its
 * pipes have been read to the end.
 */
export default async function warmUpGraphicsCache(): Promise<void> {
  if (RUNS_ON_MAC) return;
  const userDataDir = mkdtempSync(join(tmpdir(), "hercule-desktop-warm-up-"));
  try {
    const startedAt = Date.now();
    const app = await launchPlainApp(userDataDir);
    const outputEnded = new Promise<void>((resolve) => app.process.once("close", () => resolve()));
    let failure: Error | undefined;
    let timings = "no first frame";
    const fail = (error: unknown) => {
      failure ??= error instanceof Error ? error : new Error(String(error));
    };
    try {
      timings = `the first frame was presented ${String(await waitForFirstFrame(app, startedAt))} ms after the launch`;
    } catch (error) {
      fail(error);
    }
    try {
      await stopPlainApp(app);
      assertExitedCleanly(app.process);
    } catch (error) {
      fail(error);
    }
    await Promise.race([outputEnded, sleep(OUTPUT_DRAIN_LIMIT_MS, undefined, { ref: false })]);
    // The error is logged just before main shows the window on its time limit,
    // and a normal show, on the page's report, logs nothing.
    if (app.readMainOutput().includes(SHOWN_WITHOUT_FIRST_SCREEN_ERROR)) {
      fail(new Error("main showed the window on its time limit, not on the page's report"));
    }
    if (failure !== undefined) {
      throw new Error(
        `the first launch of the test package failed (${timings}): ${failure.message}\nmain's output:\n${app.readMainOutput()}`,
        { cause: failure },
      );
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
}
