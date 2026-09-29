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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { ElectronApplication, Page } from "playwright";
import { expect, onTestFinished } from "vitest";
import type { Bridge } from "../../apps/desktop/src/ipc/bridge";
import {
  buildAppArgs,
  buildAppEnv,
  findExecutable,
  isWindowVisible,
  launchTestPackage,
  quitApp,
  signIn,
  writeControllerUrl,
  type PackageKind,
} from "../../apps/desktop/scripts/packaged-app";
import {
  completeSetup,
  PASSWORD,
  ROOT,
  startController,
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
 * The 200 ms keep the tests clear of a crash in Electron 44.4.5 on macOS 15
 * with Stage Manager on: the app crashes with SIGSEGV when a window is
 * destroyed within about 100 ms of first appearing, while Stage Manager is
 * still placing it. A test that quits right after the page loads hits that
 * window of time; no user can quit that fast, so the wait keeps the tests on
 * the path users take. The crash is not yet reported upstream.
 *
 * The test fails if the app does not quit cleanly: vitest runs a test's
 * finishing callbacks last registered first, so the app has quit before its
 * user data directory is deleted.
 */
export async function launchForTest(
  userDataDir = createUserDataDirForTest(),
): Promise<LaunchedApp> {
  const app = await launchTestPackage(userDataDir);
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= quitApp(app));
  onTestFinished(close);

  const page = await app.firstWindow();
  await page.waitForLoadState("load");
  await expect.poll(() => isWindowVisible(app), { message: "the window did not show" }).toBe(true);
  await sleep(200);
  return { app, page, userDataDir, close };
}

/**
 * Starts the app for the current test with `url` already saved as its
 * controller (see `writeControllerUrl`), on a fresh user data directory.
 */
export async function launchWithSavedController(url: string): Promise<LaunchedApp> {
  const userDataDir = createUserDataDirForTest();
  writeControllerUrl(userDataDir, url);
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
 * Fails when the binary has not been built, or setup fails.
 */
export async function startControllerForTest(options: {
  readonly setUp: boolean;
}): Promise<Controller> {
  const binary = join(ROOT, "hercule");
  if (!existsSync(binary)) {
    throw new Error(`no compiled controller at ${binary}: run \`pnpm build:binary\` first.`);
  }
  const { home, remove } = createTemporaryHome();
  onTestFinished(remove);
  const controller = await startController({ home, binary });
  onTestFinished(async () => {
    await controller.stop();
  });
  if (options.setUp) {
    const ran = await completeSetup({ home, url: controller.url, binary });
    if (ran.code !== 0)
      throw new Error(`setup failed with code ${String(ran.code)}:\n${ran.stderr}`);
  }
  return controller;
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
 * Waits for `child` to exit, and returns how it ended: its exit code, or the
 * signal that ended it. Fails if it is still running after 10 seconds, and
 * kills it by its PID; `name` says in that error which process it was.
 */
export async function waitForExit(
  child: ChildProcess,
  name: string,
): Promise<number | NodeJS.Signals> {
  if (child.exitCode !== null) return child.exitCode;
  if (child.signalCode !== null) return child.signalCode;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<number | NodeJS.Signals>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? signal!));
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${name} was still running after 10 s, so it was killed`));
      }, 10_000);
    });
  } finally {
    clearTimeout(timer);
  }
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
