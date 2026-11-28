/**
 * Tests the connect check of the desktop app on addresses that are not a usable
 * controller (spec 17, §Reaching the controller): nothing answers, the server
 * is not a controller, the controller does not accept the desktop app yet, the
 * address redirects, never answers, or answers with a header in UTF-8 or a
 * status no browser knows. The check says so, saves nothing, and main raises no
 * error. An app with no saved controller opens on the first run's welcome, so
 * the tests connect through the first run's remote screen, which runs the same
 * check.
 *
 * Each test starts the packaged test package with a fresh user data
 * directory. The servers are loopback servers in the test. Run
 * `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { ElectronApplication } from "playwright";
import { describe, expect, it } from "vitest";
import { readSettings } from "../../apps/desktop/scripts/packaged-app";
import {
  answerWithEmptyPage,
  connectTo,
  findUnusedLoopbackUrl,
  launchForTest,
  readAlertText,
  startServerForTest,
} from "./harness";

/**
 * Starts recording every uncaught exception in the app's main process, and
 * returns a function that reads the recorded errors. The errors are kept on
 * main's `globalThis`, because a function handed to `app.evaluate` cannot
 * close over anything in this file.
 *
 * While the recording listens, Electron does not show its "A JavaScript error
 * occurred in the main process" dialog, which it shows only when nothing else
 * listens. So an error fails the test instead of blocking the app.
 */
async function recordMainProcessErrors(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(() => {
    const errors: string[] = [];
    (globalThis as { uncaughtErrors?: string[] }).uncaughtErrors = errors;
    process.on("uncaughtException", (error) => errors.push(String(error)));
  });
  return () =>
    app.evaluate(() => (globalThis as { uncaughtErrors?: string[] }).uncaughtErrors ?? []);
}

/**
 * A header value that is `€` in UTF-8. Node sends each character of a header
 * value as one byte, so these three characters reach the app as the three
 * bytes of `€`. Electron decodes them to a character past U+00FF, which a
 * standard `Headers` refuses.
 */
const EURO_IN_UTF8 = Buffer.from("€").toString("latin1");

describe("the connect screen, refusing an address", () => {
  it("says so when nothing answers at the address, and saves nothing", async () => {
    const url = await findUnusedLoopbackUrl();
    const { page, userDataDir } = await launchForTest();

    await connectTo(page, url);

    expect(await readAlertText(page)).toBe(
      `Could not reach ${url}. Check that the controller is running.`,
    );
    expect(readSettings(userDataDir)).not.toHaveProperty("controllerUrl");
  });

  it("says so when the server at the address is not a controller", async () => {
    const server = await startServerForTest(answerWithEmptyPage);
    const { page, userDataDir } = await launchForTest();

    await connectTo(page, server.url);

    expect(await readAlertText(page)).toBe(
      `${server.url} answered, but it is not a Hercule controller.`,
    );
    expect(readSettings(userDataDir)).not.toHaveProperty("controllerUrl");
  });

  it("says so when the controller does not accept the desktop app yet", async () => {
    // A controller from before the desktop app answers its setup state, but
    // without the CORS header that lets the app's origin read the answer.
    const server = await startServerForTest((request, response) => {
      if (request.method === "GET" && request.url === "/api/v1/setup") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ complete: true }));
      } else {
        response.statusCode = 404;
        response.end();
      }
    });
    const { page, userDataDir } = await launchForTest();

    await connectTo(page, server.url);

    expect(await readAlertText(page)).toBe(
      `${server.url} does not accept the desktop app yet. Update the controller.`,
    );
    expect(readSettings(userDataDir)).not.toHaveProperty("controllerUrl");
  });

  it("names the origin the address redirects to, and saves nothing", async () => {
    // A proxy that sends http to https answers every request with a redirect
    // to the same path on the https origin.
    const server = await startServerForTest((request, response) => {
      response.writeHead(301, { location: `https://hercule.example.com${request.url ?? "/"}` });
      response.end();
    });
    const { page, userDataDir } = await launchForTest();

    await connectTo(page, server.url);

    expect(await readAlertText(page)).toBe(
      `${server.url} redirects to https://hercule.example.com. Connect to that address instead.`,
    );
    expect(readSettings(userDataDir)).not.toHaveProperty("controllerUrl");
  });

  it("gives up after 5 seconds on an address that never answers, and closes the connection", async () => {
    let connectionClosed = false;
    // The server accepts the request and never answers it.
    const server = await startServerForTest((_request, response) => {
      response.once("close", () => (connectionClosed = true));
    });
    const { page, userDataDir } = await launchForTest();

    const connectedAt = Date.now();
    await connectTo(page, server.url);

    expect(await readAlertText(page)).toBe(
      `Could not reach ${server.url}. Check that the controller is running.`,
    );
    expect(Date.now() - connectedAt).toBeGreaterThanOrEqual(5_000);
    await expect.poll(() => connectionClosed).toBe(true);
    expect(readSettings(userDataDir)).not.toHaveProperty("controllerUrl");
  });

  it.each<{
    answer: string;
    handle: Parameters<typeof startServerForTest>[0];
    readExpectedLine: (url: string) => string;
  }>([
    {
      answer: "a page with a header in UTF-8",
      handle: (_request, response) => {
        response.writeHead(200, { "content-type": "text/html", "x-name": EURO_IN_UTF8 });
        response.end("<!doctype html><title>not a controller</title>");
      },
      readExpectedLine: (url) => `${url} answered, but it is not a Hercule controller.`,
    },
    {
      answer: "a redirect with a header in UTF-8",
      handle: (request, response) => {
        response.writeHead(302, {
          location: `https://hercule.example.com${request.url ?? "/"}`,
          "x-name": EURO_IN_UTF8,
        });
        response.end();
      },
      readExpectedLine: (url) =>
        `${url} redirects to https://hercule.example.com. Connect to that address instead.`,
    },
    {
      answer: "the status 999",
      handle: (_request, response) => {
        response.writeHead(999);
        response.end();
      },
      readExpectedLine: (url) => `${url} answered, but it is not a Hercule controller.`,
    },
  ])(
    "reads $answer without an error in main, and saves nothing",
    async ({ handle, readExpectedLine }) => {
      const server = await startServerForTest(handle);
      const { app, page, userDataDir } = await launchForTest();
      const readMainProcessErrors = await recordMainProcessErrors(app);

      await connectTo(page, server.url);

      expect(await readAlertText(page)).toBe(readExpectedLine(server.url));
      expect(await readMainProcessErrors()).toEqual([]);
      expect(readSettings(userDataDir)).not.toHaveProperty("controllerUrl");
    },
  );
});
