/**
 * Tests the desktop app's security baseline from outside (spec 17, §Security
 * baseline and §Content-Security-Policy): the page's policy, the window's web
 * preferences, navigation, new windows, permissions, the IPC checks, and the
 * stored token's tie to its controller. The refused command-line arguments
 * need the release package, so `refused-arguments.test.ts` tests them.
 *
 * Every test starts the packaged test package with a fresh user data directory.
 * Nothing here opens the developer's browser: a test that could reach
 * `shell.openExternal` replaces it in main first. Run `pnpm build:desktop`
 * first.
 */
import { listPackage } from "@electron/asar";
import { writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { describe, expect, it } from "vitest";
import { findPackagedApp, readSettings } from "../../apps/desktop/scripts/packaged-app";
import {
  answerWithEmptyPage,
  launchForTest,
  launchWithSavedController,
  recordExternalOpens,
  startServerForTest,
  type PageGlobal,
} from "./harness";

/** The one origin the app's page has, and the only one main answers. */
const APP_ORIGIN = "app://hercule";

/**
 * The policy for a page with no saved controller, exactly as spec 17
 * (§Content-Security-Policy) writes it: `connect-src` is `'none'`.
 */
const POLICY_WITHOUT_CONTROLLER =
  "default-src 'self'; script-src 'self'; connect-src 'none'; img-src 'self' data: blob:; font-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'";

/**
 * Makes the page break its own policy with a request `connect-src` refuses,
 * and returns the policy the violation reports. This is the policy the
 * document is actually under, whatever header or tag it came from.
 *
 * Returns null when no violation is reported, as for a page under no policy.
 * Chromium reports the violation just after the refused request fails, so
 * null is returned only 1 s after the request has settled.
 */
function readEnforcedPolicy(page: Page, blockedUrl: string) {
  return page.evaluate(
    (url) =>
      new Promise<{ directive: string; policy: string } | null>((resolve) => {
        document.addEventListener(
          "securitypolicyviolation",
          (event) => resolve({ directive: event.effectiveDirective, policy: event.originalPolicy }),
          { once: true },
        );
        void fetch(url)
          .catch(() => undefined)
          .then(() => setTimeout(() => resolve(null), 1_000));
      }),
    blockedUrl,
  );
}

/**
 * Opens a second, hidden window at `url`, with the app's own preload, runs
 * `script` in its page, and returns what the script's promise resolves to.
 * The window is destroyed before this returns.
 *
 * It stands for any page that is not the app's own: the IPC checks must
 * treat it as a stranger even with the bridge installed.
 */
function runScriptInWindowAt(
  app: ElectronApplication,
  url: string,
  script: string,
): Promise<unknown> {
  return app.evaluate(
    async ({ app, BrowserWindow }, { url, script }) => {
      const stranger = new BrowserWindow({
        show: false,
        webPreferences: { preload: `${app.getAppPath()}/out/preload/index.cjs` },
      });
      try {
        await stranger.loadURL(url);
        return (await stranger.webContents.executeJavaScript(script)) as unknown;
      } finally {
        stranger.destroy();
      }
    },
    { url, script },
  );
}

describe("the page's policy", () => {
  it("is the release policy, with connect-src 'none' before a controller is saved", async () => {
    const { page } = await launchForTest();

    const violation = await readEnforcedPolicy(page, "http://127.0.0.1:9/");
    expect(violation, "the page is under no Content-Security-Policy").not.toBeNull();
    expect(violation!.directive).toBe("connect-src");
    expect(violation!.policy).toBe(POLICY_WITHOUT_CONTROLLER);
  });

  it("names the saved controller in connect-src, and nothing else", async () => {
    const controller = await startServerForTest((_request, response) => response.end());
    const { page } = await launchWithSavedController(controller.url);
    const ws = controller.url.replace(/^http:/, "ws:");

    const violation = await readEnforcedPolicy(page, "http://127.0.0.1:9/");
    expect(violation, "the page is under no Content-Security-Policy").not.toBeNull();
    expect(violation!.directive).toBe("connect-src");
    expect(violation!.policy).toBe(
      POLICY_WITHOUT_CONTROLLER.replace(
        "connect-src 'none'",
        `connect-src ${controller.url} ${ws}`,
      ),
    );
  });

  it("comes as a header with every file the app scheme serves, and with its 404", async () => {
    const { app } = await launchForTest();

    // Every file of the renderer's build, read from the package itself, so a
    // file added to the build is checked without a change here. Main serves
    // only the kinds of file it knows, and answers any other with 404, so a
    // build that gains a new kind of file (an .svg, say) fails here, not in
    // front of a user.
    const archive = join(findPackagedApp("test"), "Contents/Resources/app.asar");
    const files = listPackage(archive, { isPack: false })
      .filter((path) => path.startsWith("/out/renderer/") && extname(path) !== "")
      .map((path) => path.slice("/out/renderer".length));
    expect(new Set(files.map((path) => extname(path)))).toEqual(
      new Set([".html", ".js", ".css", ".woff2"]),
    );
    const paths = ["/", ...files, "/no-such-file.js"];

    // Main fetches each file the way the page would, through the scheme's
    // handler.
    const answers = await app.evaluate(
      ({ net }, urls) =>
        Promise.all(
          urls.map(async (url) => {
            const response = await net.fetch(url);
            return {
              url,
              status: response.status,
              policy: response.headers.get("content-security-policy"),
            };
          }),
        ),
      paths.map((path) => `${APP_ORIGIN}${path}`),
    );
    expect(answers).toEqual(
      paths.map((path) => ({
        url: `${APP_ORIGIN}${path}`,
        status: path === "/no-such-file.js" ? 404 : 200,
        policy: POLICY_WITHOUT_CONTROLLER,
      })),
    );
  });
});

describe("the window's web preferences", () => {
  it("keep context isolation, the sandbox and web security on, and Node integration off", async () => {
    const { app } = await launchForTest();

    // `getLastWebPreferences` is missing from electron.d.ts but present in
    // Electron 44. It returns the preferences the page was created with,
    // defaults filled in.
    const preferences = await app.evaluate(({ BrowserWindow }) =>
      (
        BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
          getLastWebPreferences(): Record<string, unknown> | null;
        }
      ).getLastWebPreferences(),
    );
    expect(preferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
    });
  });
});

describe("navigation and new windows", () => {
  it("refuses to navigate the window away from app://hercule, and opens an http or https destination in the default browser", async () => {
    const { app, page } = await launchForTest();
    const readOpened = await recordExternalOpens(app);

    // The listener is added after main's own, so by the time it runs, main
    // has had its say on the event.
    const prevented = await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents;
      const seen = new Promise<boolean>((resolve) => {
        contents.once("will-navigate", (event) => resolve(event.defaultPrevented));
      });
      await contents.executeJavaScript('location.href = "https://example.com/"');
      return seen;
    });

    expect(prevented).toBe(true);
    expect(page.url()).toBe(`${APP_ORIGIN}/`);
    await expect.poll(readOpened).toEqual(["https://example.com/"]);
  });

  it("opens a link that names no target in the default browser, and stays on app://hercule", async () => {
    const { app, page } = await launchForTest();
    const readOpened = await recordExternalOpens(app);

    await page.evaluate(() => {
      const link = document.createElement("a");
      link.href = "https://example.com/linked";
      document.body.append(link);
      link.click();
    });

    await expect.poll(readOpened).toEqual(["https://example.com/linked"]);
    expect(page.url()).toBe(`${APP_ORIGIN}/`);
  });

  it("denies window.open, opening http and https links in the default browser and nothing else", async () => {
    const { app, page } = await launchForTest();
    const readOpened = await recordExternalOpens(app);

    // Chromium drops `file:` and `javascript:` URLs before main's handler
    // sees them, so they would pass whatever the handler did. `ftp:` and a
    // page of the app's own origin do reach it.
    const opened = await page.evaluate(() => [
      window.open("https://example.com/") === null,
      window.open("http://example.com/") === null,
      window.open("ftp://example.com/") === null,
      window.open("app://hercule/x") === null,
      window.open("mailto:someone@example.com") === null,
    ]);

    expect(opened).toEqual([true, true, true, true, true]);
    expect(await readOpened()).toEqual(["https://example.com/", "http://example.com/"]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  });
});

describe("permissions", () => {
  /**
   * A sample of Electron 44's permission types: the three local-network ones,
   * and some a page commonly asks for. None of them can raise a macOS prompt
   * when queried, so the test cannot either, even if the app were wrong.
   */
  const PERMISSIONS = [
    "local-network-access",
    "local-network",
    "loopback-network",
    "notifications",
    "geolocation",
    "camera",
    "microphone",
    "clipboard-read",
    "midi",
  ];

  /** Builds a page script that queries each permission and returns its state by name. */
  const buildPermissionQueryScript = (names: readonly string[]) =>
    `Promise.all(${JSON.stringify(names)}.map(async (name) => [name, (await navigator.permissions.query({ name })).state])).then(Object.fromEntries)`;

  /** Builds the query result in which every permission of `names` is denied. */
  const buildAllDenied = (names: readonly string[]) =>
    Object.fromEntries(names.map((name) => [name, "denied"]));

  it("denies every permission to app://hercule", async () => {
    const { page } = await launchForTest();

    const states = await page.evaluate<Record<string, string>>(
      buildPermissionQueryScript(PERMISSIONS),
    );
    expect(states).toEqual(buildAllDenied(PERMISSIONS));

    // Asking, rather than querying, goes through main's request handler.
    const asked = await page.evaluate(async () => ({
      notifications: await Notification.requestPermission(),
      midi: await navigator.requestMIDIAccess().then(
        () => "granted",
        (error: Error) => error.name,
      ),
    }));
    expect(asked).toEqual({ notifications: "denied", midi: "NotAllowedError" });
  });

  /**
   * A canary for Electron upgrades. Electron 44 turns off Chromium's Local
   * Network Access checks, so the page reaches a controller on loopback even
   * though main denies it the local-network permissions. The day an Electron
   * release turns the checks on, this test fails, and main's permission
   * handler must then grant `local-network-access`, `local-network` and
   * `loopback-network` to app://hercule alone (spec 17, §Security baseline).
   */
  it("reaches a loopback controller with every permission denied", async () => {
    const controller = await startServerForTest((_request, response) => {
      response.setHeader("access-control-allow-origin", APP_ORIGIN);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ complete: true }));
    });
    const { page } = await launchWithSavedController(controller.url);

    expect(await page.evaluate(() => (globalThis as PageGlobal).bridge.controllerUrl.read())).toBe(
      controller.url,
    );
    const localNetwork = ["local-network-access", "local-network", "loopback-network"];
    expect(
      await page.evaluate<Record<string, string>>(buildPermissionQueryScript(localNetwork)),
    ).toEqual(buildAllDenied(localNetwork));

    const answer = await page.evaluate(async (url) => {
      const response = await fetch(`${url}/api/v1/setup`);
      return { status: response.status, body: (await response.json()) as unknown };
    }, controller.url);
    expect(answer).toEqual({ status: 200, body: { complete: true } });
  });
});

describe("IPC", () => {
  it("refuses a message that does not decode against the IPC contract", async () => {
    const { app, page, userDataDir } = await launchForTest();

    // The bridge sends only well-formed messages, so the test adds a second
    // preload that exposes `ipcRenderer.invoke` as it is, then reloads the
    // page to run it. The app ships nothing like it.
    const rawPreload = join(userDataDir, "raw-ipc.cjs");
    writeFileSync(
      rawPreload,
      `const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("rawIpc", { invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args) });`,
    );
    await app.evaluate(({ session }, filePath) => {
      session.defaultSession.registerPreloadScript({ type: "frame", filePath });
    }, rawPreload);
    await page.reload();

    const reply = await page.evaluate(() =>
      (
        globalThis as unknown as {
          rawIpc: { invoke(channel: string, ...args: unknown[]): unknown };
        }
      ).rawIpc.invoke("controllerUrl.read", 42),
    );
    // Main answers with a refusal rather than an error, so the page is told
    // why. The text after the colon comes from the schema's decode error.
    expect(reply).toEqual({
      refusal: expect.stringMatching(
        /^Main refused a message on controllerUrl\.read: its request does not match the contract: /,
      ) as string,
    });
  });

  it("refuses a message from a page whose origin is not app://hercule", async () => {
    const { app } = await launchForTest();
    const stranger = await startServerForTest(answerWithEmptyPage);

    const outcome = await runScriptInWindowAt(
      app,
      `${stranger.url}/`,
      "window.bridge.controllerUrl.read().then((value) => ({ value }), (error) => ({ refused: error.message }))",
    );
    expect(outcome).toEqual({
      refused: `Main refused a message on controllerUrl.read: it comes from ${stranger.url}, not app://hercule.`,
    });
  });

  it("refuses a synchronous message from a page whose origin is not app://hercule", async () => {
    const { app } = await launchForTest();
    const stranger = await startServerForTest(answerWithEmptyPage);

    // `appearance.read` is answered synchronously, so the bridge throws
    // main's refusal rather than rejecting a promise.
    const outcome = await runScriptInWindowAt(
      app,
      `${stranger.url}/`,
      "(() => { try { return { value: window.bridge.appearance.read() }; } catch (error) { return { refused: error.message }; } })()",
    );
    expect(outcome).toEqual({
      refused: `Main refused a message on appearance.read: it comes from ${stranger.url}, not app://hercule.`,
    });
  });
});

describe("the stored token", () => {
  /**
   * Answers as a set-up controller that accepts the app, preflights
   * included, so that nothing but the app itself keeps a request with the
   * token from arriving.
   */
  const answerAsController = (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("access-control-allow-origin", APP_ORIGIN);
    if (request.method === "OPTIONS") {
      // What the controller answers: every method in the operation table.
      response.setHeader("access-control-allow-methods", "DELETE, GET, PATCH, POST, PUT");
      response.setHeader("access-control-allow-headers", "authorization, content-type");
      response.writeHead(204).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ complete: true }));
  };

  it("is removed, and never sent, when another program saves another controller URL", async () => {
    const first = await startServerForTest(answerAsController);
    const authorizations: Array<string> = [];
    const second = await startServerForTest((request, response) => {
      if (request.headers.authorization !== undefined) {
        authorizations.push(request.headers.authorization);
      }
      answerAsController(request, response);
    });
    const launched = await launchWithSavedController(first.url);
    await launched.page.evaluate(() =>
      (globalThis as PageGlobal).bridge.token.write("secret-token"),
    );
    await launched.close();

    // What a program that can write the settings file could do: point the
    // saved controller at its own server, and keep the encrypted token.
    const settings = readSettings(launched.userDataDir);
    expect(settings).toHaveProperty("token");
    writeFileSync(
      join(launched.userDataDir, "settings.json"),
      JSON.stringify({ ...settings, controllerUrl: second.url }),
    );
    const { page } = await launchForTest(launched.userDataDir);

    await page.getByRole("button", { name: "Sign in" }).waitFor();
    expect(await page.evaluate(() => (globalThis as PageGlobal).bridge.token.read())).toBeNull();
    const settingsAfter = readSettings(launched.userDataDir);
    expect(settingsAfter["controllerUrl"]).toBe(second.url);
    expect(settingsAfter).not.toHaveProperty("token");
    expect(authorizations).toEqual([]);
  });
});
