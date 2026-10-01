/**
 * Finds, starts, signs in and quits the packaged desktop app that
 * `pnpm build:desktop` builds, and starts the scratch controller it signs in
 * to. The perf script (`./perf.ts`), the first-frame check
 * (`./first-frame.ts`) and the end-to-end suite (`e2e/desktop/`) all run the
 * app through this module, so they run it the same way.
 *
 * It also holds what the perf script and the first-frame check share beyond
 * that: the connection to main's Node inspector, stopping the app by its
 * process ID, and the Markdown table each prints. The perf script and two
 * end-to-end tests also start the app as a plain process, with no Playwright
 * attached (see `launchPlainApp`).
 *
 * The scripts run on plain Node and import this module by its `.ts` path, so
 * the module uses only TypeScript that Node can strip, and imports its
 * neighbours by their full file names too.
 */
import { spawn, type ChildProcess, type ChildProcessByStdio } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { _electron, type ElectronApplication, type Page } from "playwright";
import {
  deleteMasterKeyItem,
  PASSWORD,
  startSetUpController,
  USERNAME,
} from "../../../scripts/controller-process.ts";
import { pollUntil } from "./poll.ts";
import { buildAppEnv } from "./processes.ts";
import type { WindowState } from "../src/main/app-settings.ts";

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
 * Writes the settings file in `userDataDir`, replacing any settings already
 * there. Call it before the app starts: main reads the settings file only
 * once, at start.
 *
 * - `controllerUrl` is the saved controller, as main saves one after a
 *   successful check, so the app starts connected to it.
 * - `window`, when given, is the window's saved state, so the window opens
 *   where it says.
 */
export function writeSettings(
  userDataDir: string,
  settings: { readonly controllerUrl: string; readonly window?: WindowState },
): void {
  writeFileSync(join(userDataDir, "settings.json"), JSON.stringify(settings));
}

/**
 * Reads the settings file in `userDataDir` and returns the JSON object it
 * holds, or an empty object when main has not written the file yet.
 */
export function readSettings(userDataDir: string): Record<string, unknown> {
  const file = join(userDataDir, "settings.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

/**
 * Signs in on the app's sign-in screen the way a user does: types the
 * username and the password, and presses "Sign in". Returns once the button
 * is pressed; the caller waits for whatever screen it expects next.
 *
 * Fails, before pressing the button, when a field does not hold exactly what
 * was typed. The window takes the keyboard focus when it shows, so a key the
 * person at the machine presses then lands in a field, and the controller
 * would refuse the sign-in with no hint why. Both fields are read after both
 * are filled, because a stray key can land in either while the other fills.
 */
export async function signIn(
  page: Page,
  credentials: { readonly username: string; readonly password: string },
): Promise<void> {
  const fields = [
    {
      name: "Username",
      field: page.getByRole("textbox", { name: "Username" }),
      typed: credentials.username,
    },
    { name: "Password", field: page.getByLabel("Password"), typed: credentials.password },
  ];
  for (const { field, typed } of fields) await field.fill(typed);
  for (const { name, field, typed } of fields) {
    const held = await field.inputValue();
    // The message gives lengths, not the text: a stray key can be part of
    // something private the person was typing in another app.
    if (held !== typed) {
      throw new Error(
        `The ${name} field holds other text than was typed (${String(held.length)} characters, where ${String(typed.length)} were typed), so the sign-in would fail. A key pressed while the app started probably reached its window. Run again without typing while the app starts.`,
      );
    }
  }
  await page.getByRole("button", { name: "Sign in" }).click();
}

/**
 * The switch that makes the app encrypt its sign-in with a fixed key instead
 * of one kept in the macOS Keychain, so no test and no perf run reads or
 * writes the real Keychain, and none can meet its access prompt.
 *
 * While its Node inspector is closed, a packaged app refuses every argument
 * except those `buildAppArgs` passes, this one included: anyone could read a
 * token saved under the fixed key. Playwright always opens the inspector. A
 * launch that spawns the app itself, and passes any other argument, passes
 * `--inspect=0` as well; the test package's fuses allow it.
 */
export const MOCK_KEYCHAIN_SWITCH = "--use-mock-keychain";

/**
 * Starts the test package with Playwright's Electron driver, on the given
 * user data directory, and returns Playwright's handle on it. The app runs on
 * the mock keychain (see `MOCK_KEYCHAIN_SWITCH`).
 *
 * Given an `executablePath`, Playwright passes only `--inspect=0` and
 * `--remote-debugging-port=0` before the app's own arguments. It does not
 * load its own startup script into main, so the app starts as it does for a
 * user.
 */
export function launchTestPackage(userDataDir: string): Promise<ElectronApplication> {
  return _electron.launch({
    executablePath: findExecutable("test"),
    args: [...buildAppArgs(userDataDir), MOCK_KEYCHAIN_SWITCH],
    env: buildAppEnv(),
    // Playwright otherwise makes every page match `prefers-color-scheme:
    // light`, whatever the macOS appearance, and the page's theme follows
    // that media query.
    colorScheme: null,
  });
}

/** The test package, started as a plain process by `launchPlainApp`. */
export interface PlainApp {
  readonly process: ChildProcessByStdio<null, Readable, Readable>;
  /** Main's Node inspector, as `ws://127.0.0.1:<port>/<id>`. */
  readonly inspectorUrl: string;
  /** Chromium's DevTools endpoint, as `ws://127.0.0.1:<port>/devtools/browser/<id>`. */
  readonly endpoint: string;
  /** Returns everything main has written to its standard output and error so far. */
  readonly readMainOutput: () => string;
}

/**
 * Starts the test package on `userDataDir` as a plain process, on the mock
 * keychain, with main's Node inspector and Chromium's DevTools endpoint open.
 * Returns once the app has printed both addresses. Fails when the app cannot
 * start or exits before that. Fails and stops the app when it has not printed
 * them within 30 s.
 *
 * Nothing attaches to the app until the caller does. Playwright is not used,
 * for two reasons:
 *
 * - it slows the launch down: it holds each new renderer paused until it has
 *   attached to it;
 * - it turns on the DevTools protocol's focus emulation for every page, and a
 *   page under focus emulation reports `document.visibilityState` as
 *   "visible" even while its window is hidden, so it never runs as a hidden
 *   page does.
 *
 * The app prints both addresses on stderr: the inspector as `Debugger
 * listening on ws://...`, and the DevTools endpoint as `DevTools listening
 * on ws://...`. Main's output is kept whole, and reading both streams to the
 * end keeps a full pipe from blocking the app.
 */
export async function launchPlainApp(userDataDir: string): Promise<PlainApp> {
  const child = spawn(
    findExecutable("test"),
    [
      ...buildAppArgs(userDataDir),
      MOCK_KEYCHAIN_SWITCH,
      "--inspect=0",
      "--remote-debugging-port=0",
    ],
    { env: buildAppEnv(), stdio: ["ignore", "pipe", "pipe"] },
  );
  let mainOutput = "";
  const appendMainOutput = (chunk: string) => (mainOutput += chunk);
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", appendMainOutput);
  child.stderr.on("data", appendMainOutput);
  let timer: NodeJS.Timeout | undefined;
  try {
    const addresses = await new Promise<{ inspectorUrl: string; endpoint: string }>(
      (resolve, reject) => {
        const findAddresses = () => {
          const inspector = /Debugger listening on (ws:\/\/\S+)/.exec(mainOutput);
          const devTools = /DevTools listening on (ws:\/\/\S+)/.exec(mainOutput);
          if (inspector === null || devTools === null) return;
          child.stderr.off("data", findAddresses);
          resolve({ inspectorUrl: inspector[1]!, endpoint: devTools[1]! });
        };
        child.stderr.on("data", findAddresses);
        child.once("error", reject);
        child.once("exit", () =>
          reject(new Error("the app exited before it opened its inspector and DevTools endpoint")),
        );
        // An app whose main thread is blocked, such as by a macOS alert, never
        // prints the addresses, and the caller would wait forever.
        timer = setTimeout(
          () =>
            reject(
              new Error("the app did not open its inspector and DevTools endpoint within 30 s"),
            ),
          30_000,
        );
      },
    );
    return { process: child, ...addresses, readMainOutput: () => mainOutput };
  } catch (error) {
    // A process that failed to start has no PID, and the PID of one that has
    // exited may belong to another process by now.
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      await stopApp(child.pid);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Quits the app the way the Quit menu item does, through `app.quit()`, and
 * waits for its process to exit. Fails if the process exits other than with
 * code 0, such as on a crash.
 *
 * `app.quit()` runs from a timer in main, as an ordinary task on main's event
 * loop, which is also how it runs when the user picks Quit. It does not run
 * inside the call that reaches main through its Node inspector, which is how
 * Playwright's own `close()` quits the app. Quitting from inside that call
 * sometimes makes Electron 44.4.5 crash with SIGSEGV on macOS 15 with Stage
 * Manager on. The crash happens when macOS is still moving the window, as it
 * does right after the window shows or moves: macOS sends the window a
 * notification after Electron has already freed it. The same quit from a
 * timer did not crash in about 400 runs of a standalone repro
 * (`docs/plans/electron-upstream-bugs.md` §1).
 *
 * Closing the window only hides it, so a mistake in that handler can keep
 * `app.quit()` from finishing. After 10 seconds the process is killed, by the
 * PID Playwright started, and this fails saying so: nothing is left running
 * (see `waitForExitOrKill`).
 *
 * A crash while quitting is checked here because nothing else would notice
 * it: the test or the measurement is already done, and only the crash report
 * in `~/Library/Logs/DiagnosticReports` would record it.
 */
export async function quitApp(app: ElectronApplication): Promise<void> {
  // Playwright's handle on the process is gone once the app has closed.
  const child = app.process();
  // Playwright emits `close` once the process has exited and Playwright has
  // finished with it.
  const closed = new Promise<void>((resolve) => app.once("close", () => resolve()));
  await app.evaluate(({ app }) => {
    setTimeout(() => app.quit(), 0);
  });
  try {
    await waitForExitOrKill(child.pid!, "the app", "app.quit()");
  } finally {
    await closed;
  }
  assertExitedCleanly(child);
}

/**
 * Checks that the app's process, which has ended, exited with code 0. Fails
 * saying how it ended otherwise, such as on a crash while quitting: nothing
 * else would notice that crash once the test or the measurement is done.
 */
export function assertExitedCleanly(child: ChildProcess): void {
  if (child.exitCode !== 0) {
    const ending = child.signalCode ?? `code ${String(child.exitCode)}`;
    throw new Error(`the app did not quit cleanly: its process ended with ${ending}`);
  }
}

/** Checks whether the app's one window is on screen. */
export function isWindowVisible(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isVisible());
}

/**
 * Starts a controller from the compiled binary in a scratch Hercule Home,
 * never the user's own, and completes its setup. Runs `use` with the
 * controller's URL, then stops the controller and deletes the home. Fails
 * when the binary has not been built, or setup fails.
 */
export async function runWithScratchController<T>(use: (url: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "hercule-desktop-home-"));
  try {
    const controller = await startSetUpController({ home });
    try {
      return await use(controller.url);
    } finally {
      await controller.stop();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
    deleteMasterKeyItem(home);
  }
}

/**
 * Waits until main has saved a token in the settings file in `userDataDir`.
 * The page saves the token without waiting for main, so it can land just
 * after the shell shows. Fails after 5 s.
 */
async function waitForSavedToken(userDataDir: string): Promise<void> {
  await pollUntil(
    () => (typeof readSettings(userDataDir)["token"] === "string" ? true : undefined),
    {
      timeoutMs: 5_000,
      intervalMs: 50,
      timeoutMessage: "main did not save the token within 5 s of signing in",
    },
  );
}

/**
 * Starts the app on `userDataDir`, which already holds a saved controller,
 * signs in on the sign-in screen, waits for the shell and the saved token,
 * and quits.
 */
export async function signInOnce(userDataDir: string): Promise<void> {
  const app = await launchTestPackage(userDataDir);
  try {
    const page = await app.firstWindow();
    await signIn(page, { username: USERNAME, password: PASSWORD });
    await page.getByRole("main").waitFor();
    await waitForSavedToken(userDataDir);
  } finally {
    await quitApp(app);
  }
}

/** A connection to the Node inspector of the app's main process. */
export interface Inspector {
  /** Sends a request and returns its result. Fails when the inspector refuses the request. */
  readonly send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  /**
   * Sends a request that evaluates code, such as `Runtime.evaluate`, and
   * returns the value the code evaluates to. Fails when the inspector refuses
   * the request, or when the code throws.
   */
  readonly evaluate: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /**
   * Returns the parameters of the oldest event called `method` that no
   * earlier call returned, waiting for one when there is none yet.
   */
  readonly waitForEvent: (method: string) => Promise<unknown>;
  readonly close: () => void;
}

/** A message from the inspector: a reply to a request when it has an `id`, an event otherwise. */
interface InspectorMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: {
    readonly result?: { readonly value?: unknown };
    readonly exceptionDetails?: {
      readonly text: string;
      readonly exception?: { readonly description?: string };
    };
  };
  readonly error?: { readonly message: string };
}

/** Connects to main's Node inspector at `url`. Fails when the inspector refuses the connection. */
export async function connectInspector(url: string): Promise<Inspector> {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error(`could not connect to main's inspector at ${url}`)),
      { once: true },
    );
  });
  let lastId = 0;
  const replies = new Map<number, (message: InspectorMessage) => void>();
  const events: InspectorMessage[] = [];
  const eventWaiters: Array<() => void> = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as InspectorMessage;
    if (message.id === undefined) {
      events.push(message);
      for (const wake of eventWaiters.splice(0)) wake();
      return;
    }
    replies.get(message.id)?.(message);
  });

  const request = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<InspectorMessage>((resolve, reject) => {
      const id = ++lastId;
      replies.set(id, (message) => {
        replies.delete(id);
        if (message.error === undefined) resolve(message);
        else reject(new Error(`main's inspector refused ${method}: ${message.error.message}`));
      });
      socket.send(JSON.stringify({ id, method, params }));
    });

  return {
    send: async (method, params) => (await request(method, params)).result,
    evaluate: async (method, params) => {
      const { result } = await request(method, params);
      const thrown = result?.exceptionDetails;
      if (thrown !== undefined) {
        throw new Error(`main threw: ${thrown.exception?.description ?? thrown.text}`);
      }
      return result?.result?.value;
    },
    waitForEvent: async (method) => {
      for (;;) {
        const index = events.findIndex((event) => event.method === method);
        if (index !== -1) return events.splice(index, 1)[0]!.params;
        await new Promise<void>((wake) => eventWaiters.push(wake));
      }
    },
    close: () => socket.close(),
  };
}

/**
 * Evaluates `expression` in the app's main process, through the Node
 * inspector at `inspectorUrl`, and returns the value it evaluates to, awaited
 * when it is a promise. Fails when the expression throws.
 *
 * The connection lasts only for the call, so nothing stays attached to the
 * app in between. `require` is not a global in main; the inspector's command
 * line API supplies it to the expression.
 */
export async function evaluateInMain(inspectorUrl: string, expression: string): Promise<unknown> {
  const inspector = await connectInspector(inspectorUrl);
  try {
    return await inspector.evaluate("Runtime.evaluate", {
      expression,
      includeCommandLineAPI: true,
      awaitPromise: true,
      returnByValue: true,
    });
  } finally {
    inspector.close();
  }
}

/** Checks whether the process `pid` is still running. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits up to 10 s for the process `pid` to end. Kills it when it is still
 * running then, and fails saying that `name` was still running 10 s after
 * `since`, so nothing is left running.
 *
 * For a child of this process, the exit code is known once this returns:
 * Node reads it as it reaps the child, and a child that has not been reaped
 * still counts as running.
 */
export async function waitForExitOrKill(pid: number, name: string, since: string): Promise<void> {
  try {
    await pollUntil(() => (isRunning(pid) ? undefined : true), {
      timeoutMs: 10_000,
      intervalMs: 50,
      timeoutMessage: `${name} was still running 10 s after ${since}, so it was killed`,
    });
  } catch (error) {
    // The wait fails only once the 10 s are up, and the message says the
    // process was killed, so it is killed before the failure goes on.
    process.kill(pid, "SIGKILL");
    throw error;
  }
}

/**
 * Stops the app's process `pid`: sends it SIGTERM, which quits the app as
 * `app.quit()` does, and waits until the process has ended (see
 * `waitForExitOrKill`).
 *
 * It needs only the process ID, so it also stops an app started through
 * LaunchServices, which is not a child of the script. A caller that spawned
 * the app itself can read the app's exit code from its child process
 * afterwards.
 */
export async function stopApp(pid: number): Promise<void> {
  if (!isRunning(pid)) return;
  process.kill(pid, "SIGTERM");
  await waitForExitOrKill(pid, `the app (process ${String(pid)})`, "SIGTERM");
}

/**
 * Stops an app started by `launchPlainApp` if it is still running (see
 * `stopApp`). The PID of a process that has already exited may belong to
 * another process by now, so an app that has exited is left alone.
 */
export async function stopPlainApp(app: PlainApp): Promise<void> {
  const child = app.process;
  if (child.exitCode === null && child.signalCode === null) await stopApp(child.pid!);
}

/** Formats a Markdown table. */
export function formatTable(
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  return [header, header.map(() => "---"), ...rows]
    .map((cells) => `| ${cells.join(" | ")} |`)
    .join("\n");
}
