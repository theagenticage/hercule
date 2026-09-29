import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { makeAppSettingsLayer } from "./app-settings";
import {
  ControllerConnection,
  makeControllerConnectionLayer,
  parseControllerUrl,
} from "./controller-connection";
import type { FetchWithoutRedirects } from "./fetch-without-redirects";
import { MainWindow } from "./main-window";

/**
 * Node's `fetch`, told not to follow redirects, in place of the app's, which
 * sends through Chromium's network stack and which only Electron can run.
 */
const fetchWithoutRedirects: FetchWithoutRedirects = (url, init) =>
  fetch(url, { ...init, redirect: "manual" });

describe("parseControllerUrl", () => {
  it.each([
    ["http://127.0.0.1:4937", "http://127.0.0.1:4937"],
    ["http://127.0.0.1:4937/", "http://127.0.0.1:4937"],
    ["https://hercule.example.com", "https://hercule.example.com"],
    ["  http://127.0.0.1:4937  ", "http://127.0.0.1:4937"],
    ["HTTP://Hercule.Example.COM", "http://hercule.example.com"],
    ["http://hercule.example.com:80", "http://hercule.example.com"],
    ["https://hercule.example.com:443/", "https://hercule.example.com"],
    ["https://hercule.example.com:8443", "https://hercule.example.com:8443"],
    ["http://[::1]:4937", "http://[::1]:4937"],
  ])("saves %j as %j", (text, origin) => expect(parseControllerUrl(text)).toBe(origin));

  it.each([
    ["an empty field", ""],
    ["a host and port with no scheme", "127.0.0.1:4937"],
    ["a host name with no scheme", "hercule.example.com"],
    ["another scheme", "ftp://hercule.example.com"],
    ["a WebSocket URL", "ws://127.0.0.1:4937"],
    ["the app's own origin", "app://hercule"],
    ["a file URL", "file:///Users/me"],
    ["a user name", "http://me@127.0.0.1:4937"],
    ["a user name and password", "http://me:secret@127.0.0.1:4937"],
    ["a path", "http://127.0.0.1:4937/api"],
    ["a path ending in /", "http://127.0.0.1:4937/hercule/"],
    ["a query", "http://127.0.0.1:4937/?x=1"],
    ["an empty query", "http://127.0.0.1:4937/?"],
    ["a fragment", "http://127.0.0.1:4937/#top"],
    ["an empty fragment", "http://127.0.0.1:4937#"],
  ])("refuses %s", (_case, text) => expect(parseControllerUrl(text)).toBeNull());
});

describe("ControllerConnection.save", () => {
  let folder: string;
  let file: string;
  let server: Server;
  let origin: string;
  /** How many requests the fake controller received. */
  let requestCount: number;
  /** Whether the fake controller is set up. */
  let setUp: boolean;
  /** Where the fake controller redirects the setup read, or null when it answers it. */
  let redirectTo: string | null;

  beforeEach(async () => {
    folder = mkdtempSync(join(tmpdir(), "hercule-desktop-connection-"));
    file = join(folder, "settings.json");
    requestCount = 0;
    setUp = true;
    redirectTo = null;
    server = createServer((request, response) => {
      requestCount++;
      const allowsApp = { "access-control-allow-origin": "app://hercule" };
      if (request.method === "OPTIONS") {
        response
          .writeHead(204, {
            ...allowsApp,
            "access-control-allow-methods": "DELETE, GET, PATCH, POST, PUT",
            "access-control-allow-headers": "authorization, content-type",
          })
          .end();
      } else if (redirectTo !== null) {
        response.writeHead(301, { location: redirectTo }).end();
      } else {
        response
          .writeHead(200, { ...allowsApp, "content-type": "application/json" })
          .end(JSON.stringify({ complete: setUp }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(folder, { recursive: true, force: true });
  });

  /**
   * Saves `input` through a connection service built on the settings file
   * `file`, with fakes of the window and the browser. Returns the outcome,
   * how many times the window reloaded, and each URL opened in the browser.
   */
  const save = async (input: string) => {
    let reloads = 0;
    const opened: Array<string> = [];
    const window = Layer.succeed(MainWindow)({
      load: Effect.void,
      reload: Effect.sync(() => {
        reloads++;
      }),
      show: Effect.void,
      showFirstTime: Effect.void,
      send: () => Effect.void,
      showWarning: () => Effect.void,
    });
    const layer = makeControllerConnectionLayer(
      (url) =>
        Effect.sync(() => {
          opened.push(url);
        }),
      fetchWithoutRedirects,
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          makeAppSettingsLayer(file).pipe(Layer.provide(NodeFileSystem.layer)),
          window,
        ),
      ),
    );
    const outcome = await Effect.runPromise(
      Effect.provide(
        ControllerConnection.use((connection) => connection.save(input)),
        layer,
      ),
    );
    return { outcome, reloads, opened };
  };

  const readFileObject = (): unknown => JSON.parse(readFileSync(file, "utf8"));

  it("saves the origin of a ready controller, drops the old token, and reloads the window", async () => {
    writeFileSync(file, JSON.stringify({ controllerUrl: "http://127.0.0.1:1", token: "AAEC" }));
    expect(await save(` ${origin.toUpperCase()}/ `)).toEqual({
      outcome: { _tag: "Saved", origin },
      reloads: 1,
      opened: [],
    });
    expect(readFileObject()).toEqual({ controllerUrl: origin });
  });

  it("refuses an invalid URL without a request, and saves nothing", async () => {
    expect(await save(`${origin}/api`)).toEqual({
      outcome: { _tag: "InvalidUrl" },
      reloads: 0,
      opened: [],
    });
    expect(requestCount).toBe(0);
    expect(() => readFileSync(file)).toThrow();
  });

  it("opens the setup page of a controller that is not set up, and saves nothing", async () => {
    setUp = false;
    expect(await save(origin)).toEqual({
      outcome: { _tag: "SetupIncomplete", origin },
      reloads: 0,
      opened: [`${origin}/setup`],
    });
    expect(() => readFileSync(file)).toThrow();
  });

  it("returns any other outcome of the check with the origin, and saves nothing", async () => {
    redirectTo = "https://hercule.example.com/api/v1/setup";
    expect(await save(origin)).toEqual({
      outcome: { _tag: "Redirected", origin, targetOrigin: "https://hercule.example.com" },
      reloads: 0,
      opened: [],
    });
    expect(() => readFileSync(file)).toThrow();
  });
});
