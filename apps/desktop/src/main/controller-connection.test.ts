import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ControllerConnection,
  makeControllerConnectionLayer,
  parseControllerUrl,
} from "./controller-connection";
import { StoredToken } from "./stored-token";
import {
  type FakeHttpServer,
  makeFakeMainWindow,
  makeTemporarySettingsFile,
  nodeFetchWithoutRedirects,
  startFakeHttpServer,
  type TemporarySettingsFile,
} from "./testing";

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
  let settingsFile: TemporarySettingsFile;
  let server: FakeHttpServer;
  let origin: string;
  /** How many requests the fake controller received. */
  let requestCount: number;
  /** Whether the fake controller is set up. */
  let setUp: boolean;
  /** Where the fake controller redirects the setup read, or null when it answers it. */
  let redirectTo: string | null;

  beforeEach(() => {
    settingsFile = makeTemporarySettingsFile();
    return settingsFile.remove;
  });

  beforeEach(async () => {
    requestCount = 0;
    setUp = true;
    redirectTo = null;
    server = await startFakeHttpServer((request, response) => {
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
    origin = server.origin;
    return server.close;
  });

  /**
   * Saves `input` through a connection service built on the temporary
   * settings file, with fakes of the stored token, the window and the
   * browser. Returns the outcome, each token written, how many times the
   * window reloaded, and each URL opened in the browser.
   */
  const save = async (input: string) => {
    const tokenWrites: Array<string | null> = [];
    const opened: Array<string> = [];
    const storedToken = Layer.succeed(StoredToken)({
      read: Effect.succeed(null),
      write: (token) =>
        Effect.sync(() => {
          tokenWrites.push(token);
        }),
    });
    const window = makeFakeMainWindow();
    const layer = makeControllerConnectionLayer(
      (url) =>
        Effect.sync(() => {
          opened.push(url);
        }),
      nodeFetchWithoutRedirects,
    ).pipe(Layer.provide(Layer.mergeAll(settingsFile.layer, storedToken, window.layer)));
    const outcome = await Effect.runPromise(
      Effect.provide(
        ControllerConnection.use((connection) => connection.save(input)),
        layer,
      ),
    );
    const reloads = window.calls.filter((call) => call === "reload").length;
    return { outcome, tokenWrites, reloads, opened };
  };

  const readFileObject = (): unknown => JSON.parse(readFileSync(settingsFile.path, "utf8"));

  it("signs the user out, saves the origin of a ready controller, and reloads the window", async () => {
    writeFileSync(
      settingsFile.path,
      JSON.stringify({ controllerUrl: "http://127.0.0.1:1", token: "AAEC" }),
    );
    expect(await save(` ${origin.toUpperCase()}/ `)).toEqual({
      outcome: { _tag: "Saved", origin },
      tokenWrites: [null],
      reloads: 1,
      opened: [],
    });
    expect(readFileObject()).toEqual({ controllerUrl: origin });
  });

  it("keeps the user signed in when the ready controller is the one already saved", async () => {
    writeFileSync(settingsFile.path, JSON.stringify({ controllerUrl: origin, token: "AAEC" }));
    expect(await save(origin)).toEqual({
      outcome: { _tag: "Saved", origin },
      tokenWrites: [],
      reloads: 1,
      opened: [],
    });
    expect(readFileObject()).toEqual({ controllerUrl: origin, token: "AAEC" });
  });

  it("refuses an invalid URL without a request, and saves nothing", async () => {
    expect(await save(`${origin}/api`)).toEqual({
      outcome: { _tag: "InvalidUrl" },
      tokenWrites: [],
      reloads: 0,
      opened: [],
    });
    expect(requestCount).toBe(0);
    expect(() => readFileSync(settingsFile.path)).toThrow();
  });

  it("opens the setup page of a controller that is not set up, and saves nothing", async () => {
    setUp = false;
    expect(await save(origin)).toEqual({
      outcome: { _tag: "SetupIncomplete", origin },
      tokenWrites: [],
      reloads: 0,
      opened: [`${origin}/setup`],
    });
    expect(() => readFileSync(settingsFile.path)).toThrow();
  });

  it("returns any other outcome of the check with the origin, and saves nothing", async () => {
    redirectTo = "https://hercule.example.com/api/v1/setup";
    expect(await save(origin)).toEqual({
      outcome: { _tag: "Redirected", origin, targetOrigin: "https://hercule.example.com" },
      tokenWrites: [],
      reloads: 0,
      opened: [],
    });
    expect(() => readFileSync(settingsFile.path)).toThrow();
  });
});
