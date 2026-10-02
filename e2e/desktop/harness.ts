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
  type Session,
} from "../../packages/contract/src/index";
import { connectFleet, type Fleet } from "../../apps/desktop/scripts/fleet";
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
 * The app shows no thread notification: main's are only recorded, for
 * `readThreadNotifications`, so that a test run puts no banner on the
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
): Promise<LaunchedApp> {
  const app = await launchTestPackage(userDataDir);
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= quitApp(app));
  onTestFinished(close);

  // Playwright reads main's output from the start and passes on only what
  // arrives after a listener is added, so the listeners go on before any wait.
  let mainOutput = "";
  const appendMainOutput = (chunk: Buffer) => (mainOutput += chunk.toString());
  app.process().stdout?.on("data", appendMainOutput);
  app.process().stderr?.on("data", appendMainOutput);

  await recordThreadNotifications(app);

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
 * Types `url` into the connect screen's address field and presses Connect.
 * Returns once the button is pressed; the caller waits for the outcome it
 * expects. On success main saves the URL and reloads the window.
 */
export async function connectTo(page: Page, url: string): Promise<void> {
  await page.getByRole("textbox", { name: "Controller address" }).fill(url);
  await page.getByRole("button", { name: "Connect" }).click();
}

/**
 * Waits for the line the connect or sign-in screen shows under its form, and
 * returns its text. Fails when no line shows within Playwright's timeout.
 */
export async function readAlertText(page: Page): Promise<string | null> {
  const alert = page.getByRole("alert");
  await alert.waitFor();
  return alert.textContent();
}

/**
 * Signs in on the sign-in screen as `USERNAME`, and returns the token the
 * controller at `controllerUrl` issued, read from the `auth.login` response
 * the page received. Returns once the response has arrived; the caller waits
 * for the screen it expects next.
 */
export async function signInAndReadToken(page: Page, controllerUrl: string): Promise<string> {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.url() === `${controllerUrl}/api/v1/auth/login` &&
      candidate.request().method() === "POST",
  );
  await signIn(page, { username: USERNAME, password: PASSWORD });
  const { token } = (await (await response).json()) as { token: string };
  return token;
}

/**
 * Starts a controller for the current test from the compiled binary,
 * `./hercule`, in a scratch Hercule Home, never the user's own. With
 * `setUp: true`, it also completes first-run setup as `USERNAME`, so the app
 * can sign in; otherwise setup is still pending.
 *
 * The controller is stopped, and its home deleted, when the test finishes.
 * Fails when the binary has not been built, when the controller does not
 * start, or when setup fails.
 */
export async function startControllerForTest(options: {
  readonly setUp: boolean;
}): Promise<Controller> {
  const { home, remove } = createTemporaryHome();
  onTestFinished(remove);
  const controller = options.setUp
    ? await startSetUpController({ home })
    : await startController({ home, binary: findCompiledBinary() });
  onTestFinished(async () => {
    await controller.stop();
  });
  return controller;
}

/** A scratch controller that is set up, a fleet signed in to it, and a client for reading it back. */
export interface ArrangedFleet {
  readonly url: string;
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
 * Starts the app with the controller at `url` saved, signs in, and returns
 * the app once the sidebar's thread list is on screen.
 */
export async function openSignedIn(url: string): Promise<LaunchedApp> {
  const launched = await launchWithSavedController(url);
  await signInAndReadToken(launched.page, url);
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

/** A thread notification main made, as `readThreadNotifications` returns it. */
export interface RecordedThreadNotification {
  readonly title: string;
  readonly body: string;
  /** "shown" once main has shown it, and "closed" once main has removed it. */
  readonly state: "shown" | "closed";
}

/**
 * Replaces `show` and `close` on Electron's notifications with functions that
 * only record what main did, and keeps each notification main shows on
 * main's `globalThis`, as a function handed to `app.evaluate` cannot close
 * over anything in this file. Main makes its thread notifications from
 * Electron's own class, whose methods live on its prototype, so the
 * replacements apply to every notification main makes from now on.
 */
async function recordThreadNotifications(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    const shown: Array<Electron.Notification & { closedForTest?: true }> = [];
    (globalThis as { shownThreadNotifications?: typeof shown }).shownThreadNotifications = shown;
    Notification.prototype.show = function (this: (typeof shown)[number]) {
      shown.push(this);
    };
    Notification.prototype.close = function (this: (typeof shown)[number]) {
      this.closedForTest = true;
    };
  });
}

/** Returns every thread notification main has shown since the app started, oldest first. */
export function readThreadNotifications(
  app: ElectronApplication,
): Promise<RecordedThreadNotification[]> {
  return app.evaluate(() =>
    (
      (
        globalThis as {
          shownThreadNotifications?: Array<Electron.Notification & { closedForTest?: true }>;
        }
      ).shownThreadNotifications ?? []
    ).map(({ title, body, closedForTest }) => ({
      title,
      body,
      state: closedForTest === true ? ("closed" as const) : ("shown" as const),
    })),
  );
}

/**
 * Clicks the thread notification main showed at `index`, counting from the
 * oldest, as the user does. Fails when main has shown no notification at
 * `index`.
 */
export async function clickThreadNotification(
  app: ElectronApplication,
  index: number,
): Promise<void> {
  const clicked = await app.evaluate((_electron, at) => {
    const shown = (globalThis as { shownThreadNotifications?: Electron.Notification[] })
      .shownThreadNotifications;
    return shown?.[at]?.emit("click") ?? false;
  }, index);
  if (!clicked) throw new Error(`main has shown no thread notification at ${String(index)}`);
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
 * Fails when all of them are taken.
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
      const refuse = (): void => resolve(false);
      server.once("error", refuse);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", refuse);
        resolve(true);
      });
    });
  for (let port = IDENTITY_PORT; port < IDENTITY_PORT + IDENTITY_PORT_COUNT; port += 1) {
    if (await listen(port)) {
      onTestFinished(describeLoopbackServer(server).close);
      return port;
    }
  }
  throw new Error(
    `none of the ${String(IDENTITY_PORT_COUNT)} identity ports from ${String(IDENTITY_PORT)} was free`,
  );
}

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
