/**
 * The desktop end-to-end harness: the packaged app, started and driven with
 * Playwright's Electron driver.
 *
 * Nothing here imports the app's code, only the bridge's type. The tests run
 * what `pnpm build:desktop` packaged, and read everything they check from
 * outside: from main through `app.evaluate`, and from the page through
 * `page.evaluate`.
 *
 * They run the test package, which differs from the release package in one
 * fuse: `EnableNodeCliInspectArguments` is on, because Playwright connects to
 * main through `--inspect`. The app is found, started and quit by
 * `apps/desktop/scripts/packaged-app.ts`, which the perf script uses too.
 *
 * A test that connects or signs in reaches a real controller: the compiled
 * binary, `./hercule`, started in a scratch Hercule Home by
 * `scripts/controller-process.ts`. Run `pnpm build:binary` first as well.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ElectronApplication, Page } from "playwright";
import { expect, onTestFinished } from "vitest";
import type { Bridge } from "../../apps/desktop/src/ipc/bridge";
import { createClient, type HerculeClient } from "../../packages/client-core/src/index";
import {
  IDENTITY_PORT,
  IDENTITY_PORT_COUNT,
  type Assistant,
  type Session,
} from "../../packages/contract/src/index";
import { connectFleet, type Fleet } from "../../apps/desktop/scripts/fleet";
import type { MessagePause, ScriptStep } from "../../apps/desktop/scripts/scripted-runner";
import {
  assertExitedCleanly,
  buildAppArgs,
  evaluateInMain,
  findExecutable,
  isWindowVisible,
  launchPlainApp,
  launchTestPackage,
  quitApp,
  signIn,
  signInOnce,
  stopPlainApp,
  waitForExitOrKill,
  writeSettings,
  type PackageKind,
} from "../../apps/desktop/scripts/packaged-app";
import { pollUntil } from "../../apps/desktop/scripts/poll";
import { buildAppEnv } from "../../apps/desktop/scripts/processes";
import {
  findCompiledBinary,
  PASSWORD,
  startController,
  startSetUpController,
  USERNAME,
  type Controller,
} from "../../scripts/controller-process";
import { createTemporaryHome } from "../harness";

/**
 * The page's global object, with the bridge the preload exposes on it as
 * `window.bridge`. A function passed to `page.evaluate` reads the bridge
 * through `globalThis as PageGlobal`.
 */
export type PageGlobal = typeof globalThis & { readonly bridge: Bridge };

/**
 * Creates an empty user data directory in the system's temporary folder, and
 * deletes it when the current test finishes. A test that starts the app twice
 * on the same directory creates it with this and passes it to each launch.
 */
export function createUserDataDirForTest(): string {
  const userDataDir = mkdtempSync(join(tmpdir(), "hercule-desktop-e2e-"));
  onTestFinished(() => rmSync(userDataDir, { recursive: true, force: true }));
  return userDataDir;
}

/** A running test package, with its one window. */
export interface LaunchedApp {
  readonly app: ElectronApplication;
  /** The page in the app's first window, once it has loaded. */
  readonly page: Page;
  /** The user data directory the app was started with. */
  readonly userDataDir: string;
  /**
   * Returns everything main has written to its standard output and standard
   * error since the app started, where main's log goes.
   */
  readonly readMainOutput: () => string;
  /**
   * Quits the app; see `quitApp`. Calling it again returns the first call's
   * promise, so a test can quit the app early and still have it quit when
   * the test finishes.
   */
  readonly close: () => Promise<void>;
}

/**
 * Starts the test package for the current test, waits for its first window to
 * load and to be on screen for 200 ms, and quits the app when the test
 * finishes. Without a `userDataDir`, the app gets a fresh one. Fails if the
 * window is not on screen within the poll timeout.
 *
 * The page loads while the window is still hidden: main shows the window once
 * the page reports that its first screen has reached the window, or 3 seconds
 * after the page first painted if no report comes. So a test cannot check the
 * window right after the page loads; it waits here until main has shown it.
 *
 * `prepareFirstWindow`, when given, runs as soon as the first window exists,
 * before the wait for its page to load. A test that must act before the
 * window shows does it there; the window can still show while it runs.
 *
 * The app shows no notification of a thread or an assistant waiting on the
 * user: main's are only recorded, for `readWaitingNotifications`, so that a test run puts no banner on the
 * developer's screen. The first run on a Mac that signs in still has macOS
 * ask, once, whether the app may notify.
 *
 * The 200 ms keep the tests on the path users take: no user quits within
 * 200 ms of the window appearing, while macOS may still be placing it. A quit
 * that early is also one of the two things that must happen together for
 * Electron 44.4.5 to crash with SIGSEGV while quitting, on macOS 15 with
 * Stage Manager on. `quitApp` describes the crash and avoids the other one.
 * The crash is not yet reported upstream.
 *
 * The test fails if the app does not quit cleanly: vitest runs a test's
 * finishing callbacks last registered first, so the app has quit before its
 * user data directory is deleted.
 */
export async function launchForTest(
  userDataDir = createUserDataDirForTest(),
  prepareFirstWindow?: (app: ElectronApplication, page: Page) => Promise<void>,
  recordVideo?: Parameters<typeof launchTestPackage>[1],
): Promise<LaunchedApp> {
  const app = await launchTestPackage(userDataDir, recordVideo);
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= quitApp(app));
  onTestFinished(close);

  // Playwright reads main's output from the start and passes on only what
  // arrives after a listener is added, so the listeners go on before any wait.
  let mainOutput = "";
  const appendMainOutput = (chunk: Buffer) => (mainOutput += chunk.toString());
  app.process().stdout?.on("data", appendMainOutput);
  app.process().stderr?.on("data", appendMainOutput);

  await recordWaitingNotifications(app);

  const page = await app.firstWindow();
  await prepareFirstWindow?.(app, page);
  await page.waitForLoadState("load");
  await expect.poll(() => isWindowVisible(app), { message: "the window did not show" }).toBe(true);
  await sleep(200);
  return { app, page, userDataDir, readMainOutput: () => mainOutput, close };
}

/**
 * Starts the app for the current test with `url` already saved as its
 * controller (see `writeSettings`), on a fresh user data directory.
 */
export async function launchWithSavedController(url: string): Promise<LaunchedApp> {
  const userDataDir = createUserDataDirForTest();
  writeSettings(userDataDir, { controllerUrl: url });
  return launchForTest(userDataDir);
}

/**
 * Connects an app with no saved controller to `url`, as a user on a fresh Mac
 * does: on the first run's welcome it presses Connect to it, types `url` into
 * the remote screen's address field and presses Continue. Returns once the
 * button is pressed; the caller waits for the outcome it expects. On success
 * main saves the URL and reloads the window.
 *
 * The remote screen runs the same check in main as the connect screen, which
 * an app with a saved controller opens on when that controller is down.
 */
export async function connectTo(page: Page, url: string): Promise<void> {
  await page.getByRole("button", { name: "Connect to it" }).click();
  await page.getByRole("textbox", { name: "Address", exact: true }).fill(url);
  await page.getByRole("button", { name: "Continue" }).click();
}

/**
 * Waits for the line the connect screen, the first run's remote screen or the
 * sign-in screen shows under its form, and returns its text. Fails when no
 * line shows within Playwright's timeout.
 */
export async function readAlertText(page: Page): Promise<string | null> {
  const alert = page.getByRole("alert");
  await alert.waitFor();
  return alert.textContent();
}

/**
 * Signs in on the sign-in screen as `username`, and returns the token the
 * controller at `controllerUrl` issued, read from the `auth.login` response
 * the page received. Returns once the response has arrived; the caller waits
 * for the screen it expects next.
 */
export async function signInAndReadToken(
  page: Page,
  controllerUrl: string,
  username: string = USERNAME,
): Promise<string> {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url() === `${controllerUrl}/api/v1/auth/login` &&
      candidate.request().method() === "POST",
  );
  await signIn(page, { username, password: PASSWORD });
  const { token } = (await (await response).json()) as { token: string };
  return token;
}

/**
 * Starts a controller for the current test from the compiled binary,
 * `./hercule`, in a scratch Hercule Home, never the user's own. With
 * `setUp: true`, it also completes first-run setup as `username`, or as
 * `USERNAME` when it is not given, so the app can sign in; otherwise setup
 * is still pending. Returns the controller with the path of its home.
 *
 * The controller is stopped, and its home deleted, when the test finishes.
 * Fails when the binary has not been built, when the controller does not
 * start, or when setup fails.
 */
export async function startControllerForTest(options: {
  readonly setUp: boolean;
  readonly username?: string | undefined;
}): Promise<Controller & { readonly home: string }> {
  const { home, remove } = createTemporaryHome();
  onTestFinished(remove);
  const controller = options.setUp
    ? await startSetUpController({ home, username: options.username })
    : await startController({ home, binary: findCompiledBinary() });
  onTestFinished(async () => {
    await controller.stop();
  });
  return { ...controller, home };
}

/** A scratch controller that is set up, a fleet signed in to it, and a client for reading it back. */
export interface ArrangedFleet {
  readonly url: string;
  /**
   * The controller's scratch Hercule Home, for the CLI a test runs and for
   * the rare arrangement no operation can make.
   */
  readonly home: string;
  /**
   * Stops the controller, calls `whileStopped`, and starts it again on the
   * same port and home. The controller holds its database locked while it
   * runs, so this is the way to write to it directly. Call it at most once
   * per test. Fails when the controller does not start again.
   */
  readonly restartController: (whileStopped: () => void) => Promise<void>;
  readonly fleet: Fleet;
  readonly client: HerculeClient;
  /** Waits until the thread's status is `status`, read through the API. */
  readonly waitForStatus: (sessionId: string, status: Session["status"]) => Promise<void>;
}

/**
 * Starts a controller for the current test that is set up, and connects a
 * fleet to it, with no runners yet. The controller is stopped and the
 * runners disconnected when the test finishes.
 *
 * The controller starts a runner of its own on this machine, which may be
 * logged in to a real provider. It is retired before this returns, so no
 * thread can land on it, and the app's probe for the runner on this machine
 * cannot find it: a test that wants that probe to find a runner enlists a
 * scripted one and serves its identity (see `startIdentityServerForTest`).
 * Fails when that runner does not come online, or its retirement is refused.
 */
export async function arrangeFleet(): Promise<ArrangedFleet> {
  const controller = await startControllerForTest({ setUp: true });
  const fleet = await connectFleet(controller.url);
  onTestFinished(fleet.disconnectRunners);
  const client = createClient({ baseUrl: controller.url, token: fleet.token });
  const readRunners = async () => (await client.runner.query({ query: { limit: 10 } })).items;
  await expect
    .poll(async () => (await readRunners()).map((runner) => runner.connectivity), {
      message: "the controller's own runner did not come online",
    })
    .toEqual(["online"]);
  const [own] = await readRunners();
  await client.runner.retire({ params: { id: own!.id }, payload: {} });
  return {
    url: controller.url,
    home: controller.home,
    restartController: async (whileStopped) => {
      await controller.stop();
      whileStopped();
      const restarted = await startController({
        home: controller.home,
        binary: findCompiledBinary(),
        port: controller.port,
      });
      onTestFinished(async () => {
        await restarted.stop();
      });
    },
    fleet,
    client,
    waitForStatus: async (sessionId, status) => {
      await expect
        .poll(async () => (await client.session.read({ params: { id: sessionId } })).status)
        .toBe(status);
    },
  };
}

/**
 * Starts the app with the controller at `url` saved, signs in as `username`,
 * and returns the app once the sidebar's thread list is on screen.
 */
export async function openSignedIn(url: string, username: string = USERNAME): Promise<LaunchedApp> {
  const launched = await launchWithSavedController(url);
  await signInAndReadToken(launched.page, url, username);
  await launched.page.getByRole("navigation", { name: "Threads", exact: true }).waitFor();
  return launched;
}

/**
 * Keeps the app's window above the windows of the tests that run in other
 * files at the same time. macOS draws no frames for a window that another
 * window covers, and the page does some work only when a frame is drawn: it
 * writes the streaming tail, handles scrolls and measures sizes. A test that
 * depends on that work keeps its window on top.
 */
export async function keepWindowOnTop(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setAlwaysOnTop(true);
  });
}

/** Clicks the sidebar row of the thread titled `title`, and waits for its transcript. */
export async function openThread(page: Page, title: string): Promise<void> {
  await page
    .getByRole("navigation", { name: "Threads", exact: true })
    .locator("a.side-row", { hasText: title })
    .first()
    .click();
  await page.locator('section[aria-label="Transcript"]').waitFor();
}

/**
 * Returns the title of the thread the sidebar marks as open, or null when no
 * thread is open. A thread that waits has two rows, both marked, with the
 * same title.
 */
export async function readOpenThreadTitle(page: Page): Promise<string | null> {
  const open = page.locator('nav[aria-label="Threads"] a.side-row[aria-current="page"] .side-name');
  return (await open.count()) === 0 ? null : open.first().textContent();
}

/**
 * Replaces `shell.openExternal` in main with a function that only records the
 * URL, so a test can check what the app would open without opening the
 * developer's browser. Returns a function that reads the recorded URLs.
 *
 * The recorded URLs are kept on main's `globalThis`, because a function handed
 * to `app.evaluate` cannot close over anything in this file.
 */
export async function recordExternalOpens(
  app: ElectronApplication,
): Promise<() => Promise<string[]>> {
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { openedExternally?: string[] }).openedExternally = opened;
    shell.openExternal = (url: string) => {
      opened.push(url);
      return Promise.resolve();
    };
  });
  return () =>
    app.evaluate(() => (globalThis as { openedExternally?: string[] }).openedExternally ?? []);
}

/**
 * A notification main made about a thread or an assistant waiting on the
 * user, as `readWaitingNotifications` returns it.
 */
export interface RecordedWaitingNotification {
  readonly title: string;
  readonly body: string;
  /** "shown" once main has shown it, and "closed" once main has removed it. */
  readonly state: "shown" | "closed";
}

/**
 * Replaces `show` and `close` on Electron's notifications with functions that
 * only record what main did, and keeps each notification main shows on
 * main's `globalThis`, as a function handed to `app.evaluate` cannot close
 * over anything in this file. Main makes these notifications from
 * Electron's own class, whose methods live on its prototype, so the
 * replacements apply to every notification main makes from now on.
 */
async function recordWaitingNotifications(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    const shown: Array<Electron.Notification & { closedForTest?: true }> = [];
    (globalThis as { shownWaitingNotifications?: typeof shown }).shownWaitingNotifications = shown;
    Notification.prototype.show = function (this: (typeof shown)[number]) {
      shown.push(this);
    };
    Notification.prototype.close = function (this: (typeof shown)[number]) {
      this.closedForTest = true;
    };
  });
}

/**
 * Returns every notification main has shown since the app started about a
 * thread or an assistant waiting on the user, oldest first.
 */
export function readWaitingNotifications(
  app: ElectronApplication,
): Promise<RecordedWaitingNotification[]> {
  return app.evaluate(() =>
    (
      (
        globalThis as {
          shownWaitingNotifications?: Array<Electron.Notification & { closedForTest?: true }>;
        }
      ).shownWaitingNotifications ?? []
    ).map(({ title, body, closedForTest }) => ({
      title,
      body,
      state: closedForTest === true ? ("closed" as const) : ("shown" as const),
    })),
  );
}

/**
 * Clicks the notification main showed at `index`, counting from the
 * oldest, as the user does. Fails when main has shown no notification at
 * `index`.
 */
export async function clickWaitingNotification(
  app: ElectronApplication,
  index: number,
): Promise<void> {
  const clicked = await app.evaluate((_electron, at) => {
    const shown = (globalThis as { shownWaitingNotifications?: Electron.Notification[] })
      .shownWaitingNotifications;
    return shown?.[at]?.emit("click") ?? false;
  }, index);
  if (!clicked) throw new Error(`main has shown no notification at ${String(index)}`);
}

/** Returns the count on the dock badge; 0 when the badge is hidden. */
export function readBadgeCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ app: electronApp }) => electronApp.getBadgeCount());
}

/** Hides the app's window, as ⌘W does. The window is then no longer focused. */
export async function hideWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.hide();
  });
}

/** An item of the menu bar, as `readMenuItems` returns it. */
export interface MenuItemState {
  readonly label: string;
  readonly accelerator: string | null;
  readonly enabled: boolean;
}

/** Returns the labels of the menu bar's menus, left to right. */
export function readMenuLabels(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).map((menu) => menu.label),
  );
}

/** Returns the items of the menu labelled `menuLabel`, top to bottom, separators left out. */
export function readMenuItems(
  app: ElectronApplication,
  menuLabel: string,
): Promise<MenuItemState[]> {
  return app.evaluate(({ Menu }, label) => {
    const menu = Menu.getApplicationMenu()?.items.find((item) => item.label === label);
    return (menu?.submenu?.items ?? [])
      .filter((item) => item.type !== "separator")
      .map((item) => ({
        label: item.label,
        accelerator: item.accelerator ?? null,
        enabled: item.enabled,
      }));
  }, menuLabel);
}

/**
 * Chooses the item labelled `itemLabel` in the menu labelled `menuLabel`, as
 * a click with the mouse does. Fails when the menu bar has no such item.
 */
export async function chooseMenuItem(
  app: ElectronApplication,
  menuLabel: string,
  itemLabel: string,
): Promise<void> {
  const found = await app.evaluate(
    ({ Menu }, [menu, item]) => {
      const chosen = Menu.getApplicationMenu()
        ?.items.find((each) => each.label === menu)
        ?.submenu?.items.find((each) => each.label === item);
      if (chosen === undefined) return false;
      // Electron types `click` as a bare `Function`. Called with no
      // arguments, it runs the item's handler as a click with the mouse does.
      (chosen.click as () => void)();
      return true;
    },
    [menuLabel, itemLabel] as const,
  );
  if (!found) throw new Error(`the menu bar has no item "${itemLabel}" in "${menuLabel}"`);
}

/**
 * Waits for `child` to exit, and returns how it ended: its exit code, or the
 * signal that ended it. Fails at once when `child` did not start. Fails if it
 * is still running after 10 seconds, and kills it by its PID; `name` says in
 * that error which process it was (see `waitForExitOrKill`).
 */
export async function waitForExit(
  child: ChildProcess,
  name: string,
): Promise<number | NodeJS.Signals> {
  if (child.pid === undefined) throw new Error(`${name} did not start`);
  // The PID of a process that has already exited may belong to another
  // process by now, so only a running child is waited for by its PID.
  if (child.exitCode === null && child.signalCode === null) {
    await waitForExitOrKill(child.pid, name, "the test began to wait for it");
  }
  return child.exitCode ?? child.signalCode!;
}

/**
 * Starts a second copy of the packaged app of the given kind on the same user
 * data directory as a running one, and returns how it ended (see
 * `waitForExit`).
 *
 * It is started with `child_process` rather than Playwright: Playwright waits
 * for the new process to open DevTools, which a second instance never does,
 * because it hands over to the first one and exits. The suite runs on Node,
 * not Bun, so `Bun.spawn` is not available.
 */
export function runSecondInstance(
  kind: PackageKind,
  userDataDir: string,
): Promise<number | NodeJS.Signals> {
  const child = spawn(findExecutable(kind), buildAppArgs(userDataDir), {
    env: buildAppEnv(),
    stdio: "ignore",
  });
  return waitForExit(child, "the second instance");
}

/** The test package, started as a plain process by `launchPlainAppForTest`. */
export interface PlainAppForTest {
  /**
   * Evaluates `expression` in the page of the app's one window, and returns
   * the value it evaluates to, awaited when it is a promise. Fails when the
   * expression throws.
   */
  readonly evaluateInPage: (expression: string) => Promise<unknown>;
  /**
   * Calls the method `method` of the app's one `BrowserWindow` in main, with
   * `args`, and returns what the method returns. Fails when the call throws.
   */
  readonly callWindowMethod: (method: string, ...args: ReadonlyArray<unknown>) => Promise<unknown>;
}

/**
 * Starts the test package for the current test as a plain process, signed in
 * to the controller at `url`, on a fresh user data directory (see
 * `launchPlainApp` and `signInOnce`). The app is stopped when the test
 * finishes, and the test fails if the app did not quit cleanly.
 *
 * Nothing attaches to the page: the returned functions reach it through
 * main's Node inspector, one connection per call. A test uses this app where
 * Playwright would change what it checks, such as how the page runs while
 * its window is hidden.
 */
export async function launchPlainAppForTest(url: string): Promise<PlainAppForTest> {
  const userDataDir = createUserDataDirForTest();
  writeSettings(userDataDir, { controllerUrl: url });
  await signInOnce(userDataDir);
  const app = await launchPlainApp(userDataDir);
  onTestFinished(async () => {
    await stopPlainApp(app);
    assertExitedCleanly(app.process);
  });
  const window = `require("electron").BrowserWindow.getAllWindows()[0]`;
  return {
    evaluateInPage: (expression) =>
      evaluateInMain(
        app.inspectorUrl,
        `${window}.webContents.executeJavaScript(${JSON.stringify(expression)})`,
      ),
    callWindowMethod: (method, ...args) =>
      evaluateInMain(
        app.inspectorUrl,
        `${window}.${method}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`,
      ),
  };
}

/** A plain HTTP server on loopback that a test controls. */
export interface LoopbackServer {
  /** The server's origin, such as `http://127.0.0.1:52001`. */
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * Starts an HTTP server on 127.0.0.1, on a port the kernel picks, that answers
 * every request with `handle`.
 *
 * The tests use it as a page from another origin, and as a stand-in for a
 * controller the app can reach on loopback.
 */
export async function startLoopbackServer(
  handle: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<LoopbackServer> {
  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return describeLoopbackServer(server);
}

/**
 * Returns the address of a loopback port that nothing listens on: the port of
 * a server that has just stopped. Another process could bind the port in
 * between, but that is unlikely enough for a test.
 */
export async function findUnusedLoopbackUrl(): Promise<string> {
  const server = await startLoopbackServer((_request, response) => response.end());
  await server.close();
  return server.url;
}

/** Returns the origin of `server`, which listens on 127.0.0.1, and a function that stops it. */
function describeLoopbackServer(server: Server): LoopbackServer {
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/**
 * Starts a server for the current test that answers a runner's identity
 * request, `GET /identity`, with the runner id `readRunnerId` returns, and
 * stops it when the test finishes. Returns the port it listens on.
 *
 * The app asks only the ports a runner's identity endpoint can listen on, so
 * the server takes the first of them that is free, as a runner does. A
 * runner already on this Mac, the controller's own or the user's, holds one.
 * Fails when all of them stay taken for `IDENTITY_PORT_WAIT_MS`.
 *
 * All of them can be taken for a moment. Every controller a test starts
 * runs a runner of its own, which the harness retires. The controller then
 * starts that runner again and again, and each start holds a port until the
 * controller refuses it. With the test files running in parallel, and other
 * suites on this Mac, ten such starts can overlap, so the server waits for a
 * port to come free.
 */
export async function startIdentityServerForTest(readRunnerId: () => string): Promise<number> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/identity") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ runnerId: readRunnerId() }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  const listen = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const refuse = (): void => {
        server.off("listening", ready);
        resolve(false);
      };
      const ready = (): void => {
        server.off("error", refuse);
        resolve(true);
      };
      server.once("error", refuse);
      server.once("listening", ready);
      server.listen(port, "127.0.0.1");
    });
  const listenOnFreePort = async (): Promise<number | undefined> => {
    for (let port = IDENTITY_PORT; port < IDENTITY_PORT + IDENTITY_PORT_COUNT; port += 1) {
      if (await listen(port)) return port;
    }
    return undefined;
  };
  const port = await pollUntil(listenOnFreePort, {
    timeoutMs: IDENTITY_PORT_WAIT_MS,
    intervalMs: 100,
    timeoutMessage: `none of the ${String(IDENTITY_PORT_COUNT)} identity ports from ${String(IDENTITY_PORT)} came free in ${String(IDENTITY_PORT_WAIT_MS / 1000)} s`,
  });
  onTestFinished(describeLoopbackServer(server).close);
  return port;
}

/** How long `startIdentityServerForTest` waits for an identity port to come free. */
const IDENTITY_PORT_WAIT_MS = 20_000;

/** Starts a loopback server for the current test, and stops it when the test finishes. */
export async function startServerForTest(
  ...args: Parameters<typeof startLoopbackServer>
): Promise<LoopbackServer> {
  const server = await startLoopbackServer(...args);
  onTestFinished(server.close);
  return server;
}

/**
 * Answers every request with an empty HTML page. A server that does this
 * stands for a page from another origin, or for a server that is not a
 * controller.
 */
export function answerWithEmptyPage(_request: IncomingMessage, response: ServerResponse): void {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end("<!doctype html><title>another origin</title>");
}

/** The page's global object, with the frames `recordFrames` keeps on it. */
type FrameRecordingGlobal = typeof globalThis & {
  sentFrames?: string[];
  receivedFrames?: string[];
};

/**
 * Starts recording the frames the page sends and receives on its WebSockets,
 * as text: every frame sent, in `sentFrames`, and every frame received from
 * then on, in `receivedFrames`, both on the page's global object.
 *
 * It runs in the page, handed over as a function to `page.evaluate` or as
 * source text, so it closes over nothing in this file.
 *
 * The live connection's socket already exists. It sends through the
 * prototype's `send`, so its frames are recorded too, and its first send adds
 * the listener that records what it receives. A reply never arrives before
 * its request is sent, so every reply to a recorded request is recorded.
 */
export function recordFrames(): void {
  const sent: string[] = [];
  const received: string[] = [];
  (globalThis as FrameRecordingGlobal).sentFrames = sent;
  (globalThis as FrameRecordingGlobal).receivedFrames = received;
  const listened = new WeakSet<WebSocket>();
  // The original `send` is kept apart from any socket, and called below with
  // each socket as `this`.
  const send = Reflect.get(WebSocket.prototype, "send");
  WebSocket.prototype.send = function (this: WebSocket, data) {
    if (!listened.has(this)) {
      listened.add(this);
      this.addEventListener("message", (event: MessageEvent<unknown>) => {
        received.push(typeof event.data === "string" ? event.data : "");
      });
    }
    sent.push(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
    send.call(this, data);
  };
}

/**
 * The source of a page function that parses frames `recordFrames` recorded:
 * it takes a list of frames, or `undefined` before any were recorded, and
 * returns every message they carry, in order. A frame that holds a batch
 * gives each of its messages, and a frame that is not JSON gives none.
 */
const PARSE_FRAMES = `(frames) => (frames ?? []).flatMap((frame) => {
  try { return [JSON.parse(frame)].flat(); } catch { return []; }
})`;

/**
 * Returns a page expression that checks, from the frames `recordFrames`
 * recorded, whether the two live subscriptions of the session `sessionId` are in
 * place: an open thread's, or an assistant's current session's. A test waits
 * for both before a message streams:
 *
 * - The page has sent the frame that subscribes to the session's tap. The
 *   controller does not acknowledge a tap subscription, so the frame being
 *   sent is the closest a test can get to knowing it is live. A delta sent
 *   before the controller has the subscription reaches no one.
 * - The page has received the replay of the session's stream: the first reply
 *   to the frame that subscribes to it, which the controller sends even when
 *   there is nothing to replay. A message that starts before the replay
 *   arrives is in the replay, so the page treats it as one that may have
 *   missed deltas: it skips the message's tail, and paints none of its text
 *   until the message's rows land.
 */
export function buildLiveCheck(sessionId: string): string {
  const tap = JSON.stringify(`session:${sessionId}:tap`);
  const stream = JSON.stringify(`session:${sessionId}:stream`);
  return `(() => {
    const parse = ${PARSE_FRAMES};
    const requests = parse(globalThis.sentFrames).filter((message) => message?._tag === "Request");
    const findSubscription = (topic) => requests.findLast((request) => request.payload?.topic === topic);
    const streamRequest = findSubscription(${stream});
    return findSubscription(${tap}) !== undefined && streamRequest !== undefined &&
      parse(globalThis.receivedFrames).some(
        (message) => message?._tag === "Chunk" && message.requestId === streamRequest.id,
      );
  })()`;
}

/** The tap subscriptions of one session the page has made, as `buildTapCheck` reads them. */
export interface TapSubscriptions {
  /** How many frames the page has sent that subscribe to the tap. */
  readonly made: number;
  /** How many of them the page has ended, with a frame that interrupts the subscription. */
  readonly ended: number;
}

/**
 * Returns a page expression that reads, from the frames `recordFrames`
 * recorded, the subscriptions the page has made to the tap of the session
 * `sessionId`: a `TapSubscriptions`. The tap is subscribed while `made` is
 * more than `ended`.
 */
export function buildTapCheck(sessionId: string): string {
  const tap = JSON.stringify(`session:${sessionId}:tap`);
  return `(() => {
    const sent = (${PARSE_FRAMES})(globalThis.sentFrames);
    const ids = new Set(
      sent.filter((message) => message?._tag === "Request" && message.payload?.topic === ${tap})
        .map((request) => request.id),
    );
    const ended = sent.filter((message) => message?._tag === "Interrupt" && ids.has(message.requestId));
    return { made: ids.size, ended: ended.length };
  })()`;
}

/** Returns the assistant named `name`, read through the API. Fails when there is none. */
export async function readAssistant(client: HerculeClient, name: string): Promise<Assistant> {
  const { items } = await client.assistant.query({ query: { limit: 50 } });
  const assistant = items.find((each) => each.name === name);
  if (assistant === undefined) throw new Error(`the controller has no assistant named ${name}`);
  return assistant;
}

/** Returns the newest session of the conversation, or null when it has none yet. */
export async function readNewestSession(
  client: HerculeClient,
  conversationId: string,
): Promise<Session | null> {
  const { items } = await client.session.query({
    query: { conversationId, sort: [{ field: "createdAt", direction: "desc" }], limit: 1 },
  });
  return items[0] ?? null;
}

/** What the last agent message on the page showed at one moment, as `recordLastAgentText` records it. */
export interface AgentTextSnapshot {
  /**
   * The text the message draws as markdown, as rendered: everything but its
   * header line and the paragraph being written. While the message streams,
   * that is its finished paragraphs; once it is complete, all of its text.
   */
  readonly text: string;
  /** The paragraph being written, as plain text, or `null` once the message is complete. */
  readonly openParagraph: string | null;
}

/** The page's global object, with the snapshots `recordLastAgentText` keeps on it. */
type AgentTextRecordingGlobal = typeof globalThis & {
  agentTextSnapshots?: AgentTextSnapshot[];
};

/** A page expression that reads the newest snapshot `recordLastAgentText` took, or `undefined` before the first. */
export const READ_LAST_AGENT_TEXT = "globalThis.agentTextSnapshots.at(-1)";

/** A page expression that reads every snapshot `recordLastAgentText` took, oldest first. */
export const READ_AGENT_TEXTS = "globalThis.agentTextSnapshots";

/**
 * Starts recording what the last agent message inside the element
 * `containerSelector` finds shows, each time the page changes it. An agent
 * message is a `.msg` with a `.msg-body`, as a thread's transcript and an
 * assistant's Conversation both draw one. Its header line, the thread's
 * `.msg-meta` or the Conversation's `.msg-name`, is left out of the text.
 *
 * The snapshots collect, oldest first, in `agentTextSnapshots` on the page's
 * global object; a change that leaves the text and the paragraph being
 * written as they were adds none.
 *
 * It runs in the page, handed over as a function to `page.evaluate` or as
 * source text, so it closes over nothing in this file. A `MutationObserver`
 * calls it after each change, once the change's task is done, so it sees the
 * page as a frame would draw it.
 */
export function recordLastAgentText(containerSelector: string): void {
  const snapshots: AgentTextSnapshot[] = [];
  (globalThis as AgentTextRecordingGlobal).agentTextSnapshots = snapshots;
  const container = document.querySelector(containerSelector)!;
  const takeSnapshot = () => {
    const body = [...container.querySelectorAll(".msg > .msg-body")].at(-1);
    if (body === undefined) return;
    const openParagraph = body.querySelector(".streaming")?.textContent ?? null;
    const text = [...body.children]
      .filter((part) => !part.matches(".msg-meta, .msg-name, .streaming"))
      .map((part) => part.textContent)
      .join("");
    const last = snapshots.at(-1);
    if (last?.text === text && last.openParagraph === openParagraph) return;
    snapshots.push({ text, openParagraph });
  };
  new MutationObserver(takeSnapshot).observe(container, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  takeSnapshot();
}

/** Returns the text a snapshot shows: its markdown's text, then the paragraph being written. */
export function joinShownText({ text, openParagraph }: AgentTextSnapshot): string {
  return `${text}${openParagraph ?? ""}`;
}

/**
 * Returns the numbers of the words a snapshot shows, in order, for a message
 * whose words are numbered `w1 w2 w3 …`. A row can end inside a word, and the
 * paragraph being written then holds the word's end, so the snapshot's text
 * is read as it shows, not word by word per part.
 */
export function readWordNumbers(snapshot: AgentTextSnapshot): number[] {
  return [...joinShownText(snapshot).matchAll(/w(\d+)/g)].map((match) => Number(match[1]));
}

/** A scripted message of numbered words that pauses twice, built by `buildCountedMessage`. */
export interface CountedMessage {
  /** The `message` step that streams the words `w1 w2 w3 …`, one every 2 ms. */
  readonly step: ScriptStep;
  /** How many words the message has. */
  readonly wordCount: number;
  /** Lets the message go on from its first pause, which it reaches early on. */
  readonly resumeAfterHide: () => void;
  /** Lets the message go on from its second pause, its last stretch. */
  readonly resumeAfterShow: () => void;
}

/**
 * Builds a message for a test that hides the window while a message streams
 * and shows it again. The message has 3,000 numbered words, about 17 KiB,
 * which the controller writes as rows of 4 KiB and a last one. It pauses
 * twice, so the test's steps never race the stream, however slow the
 * machine:
 *
 * - after 400 words (about 1.8 KiB, before the first row), until the window
 *   is hidden: the paragraph being written shows text and no row has landed;
 * - after 1,800 words (about 9.5 KiB), until the window is shown again: two
 *   rows have landed while the window was hidden, and the message still
 *   streams when it is shown.
 */
export function buildCountedMessage(): CountedMessage {
  const wordCount = 3_000;
  const text = Array.from({ length: wordCount }, (_, index) => `w${index + 1}`).join(" ");
  const hidden = createMessagePause(400);
  const shown = createMessagePause(1_800);
  return {
    step: { kind: "message", text, deltaMs: 2, pauses: [hidden.pause, shown.pause] },
    wordCount,
    resumeAfterHide: hidden.resume,
    resumeAfterShow: shown.resume,
  };
}

/**
 * Creates a pause for a scripted message after `afterWords` of its words,
 * and the function that ends it. The message stops streaming there until
 * `resume` is called.
 */
export function createMessagePause(afterWords: number): {
  readonly pause: MessagePause;
  readonly resume: () => void;
} {
  let resume = () => {};
  const until = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return { pause: { afterWords, until }, resume };
}
