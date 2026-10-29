/**
 * Tests that the app asks the saved controller for brotli, and only that
 * controller (spec 17, §Reaching the controller).
 *
 * Chromium offers brotli to a localhost address on its own, so a stand-in on
 * 127.0.0.1 would see brotli asked for with or without main's hook. The
 * stand-ins are therefore reached by names that are not localhost, which
 * `--host-resolver-rules` maps to 127.0.0.1. To Chromium they are addresses
 * on the network, like a controller on the LAN or a tailnet.
 *
 * Run `pnpm build:desktop` first.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { writeSettings } from "../../apps/desktop/scripts/packaged-app";
import { createUserDataDirForTest, launchForTest, startServerForTest } from "./harness";

/** Chromium's `Accept-Encoding` for an address that is neither HTTPS nor localhost. */
const CHROMIUM_PLAIN_HTTP_ENCODING = "gzip, deflate";

/**
 * Starts a stand-in server for the current test that records the
 * `Accept-Encoding` of each request to `/probe`, and answers every request
 * with an empty JSON object the app's page may read.
 */
async function startRecordingServer() {
  const acceptEncodings: Array<string | undefined> = [];
  const server = await startServerForTest((request: IncomingMessage, response: ServerResponse) => {
    if (request.url === "/probe") acceptEncodings.push(request.headers["accept-encoding"]);
    response.setHeader("access-control-allow-origin", "app://hercule");
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  return { port: new URL(server.url).port, acceptEncodings };
}

describe("the Accept-Encoding of a request", () => {
  it("asks the saved controller for brotli from the page and from main, and asks another origin as Chromium does", async () => {
    const controller = await startRecordingServer();
    const other = await startRecordingServer();
    const controllerUrl = `http://controller.test:${controller.port}`;
    const otherUrl = `http://other.test:${other.port}`;
    const userDataDir = createUserDataDirForTest();
    writeSettings(userDataDir, { controllerUrl });

    const { app, page } = await launchForTest(userDataDir, undefined, {
      extraArgs: ["--host-resolver-rules=MAP controller.test 127.0.0.1, MAP other.test 127.0.0.1"],
    });

    // The page's own fetch, as every call the renderer makes to the controller.
    await page.evaluate(
      (url) => fetch(`${url}/probe`).then((response) => response.text()),
      controllerUrl,
    );
    expect(controller.acceptEncodings).toEqual(["gzip, deflate, br"]);

    // Main's own requests go through the same session. The page's policy
    // lets it reach only the controller, so main fetches the other origin too.
    const fetchFromMain = (url: string) =>
      app.evaluate(
        ({ net }, url) => net.fetch(`${url}/probe`).then((response) => response.text()),
        url,
      );
    await fetchFromMain(controllerUrl);
    expect(controller.acceptEncodings).toEqual(["gzip, deflate, br", "gzip, deflate, br"]);
    await fetchFromMain(otherUrl);
    expect(other.acceptEncodings).toEqual([CHROMIUM_PLAIN_HTTP_ENCODING]);
  });
});
