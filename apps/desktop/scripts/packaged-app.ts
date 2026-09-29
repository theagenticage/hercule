/**
 * Finds, starts and quits the packaged desktop app that `pnpm build:desktop`
 * builds. The perf script (`./perf.ts`) and the end-to-end suite
 * (`e2e/desktop/`) both start the app through this module, so they run it the
 * same way.
 *
 * The perf script runs on plain Node and imports this module by its `.ts`
 * path, so the module uses only TypeScript that Node can strip, and imports
 * no other file of the repository.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { _electron, type ElectronApplication } from "playwright";

/**
 * The folder electron-builder writes the `.app` into for this machine:
 * `mac-arm64` on Apple silicon, `mac` on Intel.
 */
const MAC_FOLDER = process.arch === "arm64" ? "mac-arm64" : "mac";

/**
 * The two packages `pnpm build:desktop` builds: `release` is what ships, and
 * `test` is the same app with the one fuse Playwright needs turned on,
 * `EnableNodeCliInspectArguments`.
 */
export type PackageKind = "release" | "test";

/**
 * Returns the path of the packaged `Hercule.app` of the given kind.
 *
 * Fails when it has not been built, saying how to build it: the perf script
 * and the end-to-end tests run an existing package rather than building one.
 */
export function findPackagedApp(kind: PackageKind): string {
  const app = join(import.meta.dirname, "../dist", kind, MAC_FOLDER, "Hercule.app");
  if (!existsSync(app)) {
    throw new Error(`no packaged app at ${app}: run \`pnpm build:desktop\` first.`);
  }
  return app;
}

/** Returns the path of the executable inside the packaged app of the given kind. */
export function findExecutable(kind: PackageKind): string {
  return join(findPackagedApp(kind), "Contents/MacOS/Hercule");
}

/**
 * Builds the environment the app is started with: this process's environment
 * without `ELECTRON_RUN_AS_NODE` and without any `HERCULE_` variable.
 *
 * - `ELECTRON_RUN_AS_NODE` would make an Electron binary run as plain Node.
 *   The packaged app ignores it (its `RunAsNode` fuse is off), but a shell
 *   that exports it must not decide how the app runs.
 * - A `HERCULE_` variable in the developer's shell must not change the app's
 *   behaviour either.
 */
export function buildAppEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        entry[0] !== "ELECTRON_RUN_AS_NODE" &&
        !entry[0].startsWith("HERCULE_"),
    ),
  );
}

/**
 * Builds the arguments every launch of a packaged app gets.
 *
 * - `--user-data-dir` keeps the app's settings file and its single-instance
 *   lock apart from the real app's and from every other launch's.
 * - `-ApplePersistenceIgnoreState YES` sets that macOS user default for this
 *   launch only. After an app crashes, macOS shows an alert at its next
 *   launch, offering to reopen its windows, and the app's main thread waits
 *   until someone answers it. macOS ties the alert to the bundle identifier,
 *   not to the user data directory, so a run in which the app crashed would
 *   leave the next run's first launch hanging on the alert, and that test
 *   would fail for a crash it did not cause. The crash itself still fails the
 *   test that caused it (see `quitApp`). The app does not use macOS's window
 *   restoring: it places its window from its own settings file.
 */
export function buildAppArgs(userDataDir: string): string[] {
  return ["-ApplePersistenceIgnoreState", "YES", `--user-data-dir=${userDataDir}`];
}

/**
 * Starts the test package with Playwright's Electron driver, on the given
 * user data directory, and returns Playwright's handle on it.
 *
 * Given an `executablePath`, Playwright passes only `--inspect=0` and
 * `--remote-debugging-port=0` before the app's own arguments. It does not
 * load its own startup script into main, so the app starts as it does for a
 * user.
 */
export function launchTestPackage(userDataDir: string): Promise<ElectronApplication> {
  return _electron.launch({
    executablePath: findExecutable("test"),
    args: buildAppArgs(userDataDir),
    env: buildAppEnv(),
    // Playwright otherwise makes every page match `prefers-color-scheme:
    // light`, whatever the macOS appearance, and the page's theme follows
    // that media query.
    colorScheme: null,
  });
}

/**
 * Quits the app the way the Quit menu item does, through `app.quit()`, and
 * waits for its process to exit. Fails if the process exits other than with
 * code 0, such as on a crash.
 *
 * Closing the window only hides it, so a mistake in that handler can keep
 * `app.quit()` from finishing. After 10 seconds the process is killed, by the
 * PID Playwright started, and this fails saying so: nothing is left running.
 *
 * A crash while quitting is checked here because nothing else would notice
 * it: the test or the measurement is already done, and only the crash report
 * in `~/Library/Logs/DiagnosticReports` would record it.
 */
export async function quitApp(app: ElectronApplication): Promise<void> {
  // Playwright's handle on the process is gone once the app has closed.
  const child = app.process();
  const quit = app.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<true>((resolve) => {
    timer = setTimeout(() => resolve(true), 10_000);
  });
  const outcome = await Promise.race([quit.then(() => false as const), timedOut]);
  clearTimeout(timer);
  if (outcome) {
    child.kill("SIGKILL");
    await quit.catch(() => undefined);
    throw new Error("the app was still running 10 s after app.quit(), so it was killed");
  }
  if (child.exitCode !== 0) {
    const ending = child.signalCode ?? `code ${String(child.exitCode)}`;
    throw new Error(`the app did not quit cleanly: its process ended with ${ending}`);
  }
}

/** Checks whether the app's one window is on screen. */
export function isWindowVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible());
}
