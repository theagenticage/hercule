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
 * The launch uses the same environment as the tests (the `HOME` the cache
 * lives under included), a new user data directory and the mock keychain, and
 * saves no controller, so the app opens on its first-run welcome.
 *
 * Does nothing on macOS, which has no such driver.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHOWN_WITHOUT_FIRST_SCREEN_ERROR } from "../../apps/desktop/src/main/window-visibility";
import { launchTestPackage, quitApp, RUNS_ON_MAC } from "../../apps/desktop/scripts/packaged-app";

/**
 * How long the page may take to present its first frame on a machine with a
 * cold cache. It is the time it takes when something is wrong, not what is
 * expected: a healthy launch needs seconds at most.
 */
const FIRST_FRAME_LIMIT_MS = 60_000;

/**
 * Launches the test package on a new user data directory, waits until its page
 * has presented its first screen, and quits it. Fails, with the timings and
 * main's output, when the app does not present a frame within
 * `FIRST_FRAME_LIMIT_MS`, when main shows the window on its time limit
 * instead of on the page's report, or when the app does not quit cleanly. A
 * run whose app cannot start would fail every test, and this names the cause.
 * `launch.test.ts` checks the same report on every launch after this one.
 */
export default async function warmUpGraphicsCache(): Promise<void> {
  if (RUNS_ON_MAC) return;
  const userDataDir = mkdtempSync(join(tmpdir(), "hercule-desktop-warm-up-"));
  try {
    const startedAt = Date.now();
    const app = await launchTestPackage(userDataDir);
    let mainOutput = "";
    const appendMainOutput = (chunk: Buffer) => (mainOutput += chunk.toString());
    app.process().stdout?.on("data", appendMainOutput);
    app.process().stderr?.on("data", appendMainOutput);
    let timings = "no timings yet";
    try {
      const page = await app.firstWindow();
      // The page sets `first-screen` once the frame that draws its first
      // screen has been presented, which is the work the cache speeds up.
      await page.waitForFunction(() => performance.getEntriesByName("first-screen").length > 0, {
        timeout: FIRST_FRAME_LIMIT_MS,
      });
      timings = `the first frame was presented ${String(Date.now() - startedAt)} ms after the launch`;
      // Main logs this error just before it shows the window, which is before
      // the page presents the frame it waited for, so it would be here by now.
      if (mainOutput.includes(SHOWN_WITHOUT_FIRST_SCREEN_ERROR)) {
        throw new Error("main showed the window on its time limit, not on the page's report");
      }
    } catch (error) {
      throw new Error(
        `the first launch of the test package failed (${timings}): ${String(error)}\nmain's output:\n${mainOutput}`,
        { cause: error },
      );
    } finally {
      await quitApp(app);
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
}
