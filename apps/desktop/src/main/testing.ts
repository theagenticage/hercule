/**
 * Test doubles for main's unit tests: a fake window, a fake of Electron's
 * `Notification`, a settings file in a
 * temporary folder, a fake HTTP server with Node's `fetch` to reach it, and
 * helpers for tests that run programs.
 * Imported only by `*.test.ts`.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { type AppSettings, makeAppSettingsLayer } from "./app-settings";
import type { FetchWithoutRedirects } from "./fetch-without-redirects";
import { MainWindow } from "./main-window";
import type { NativeNotification } from "./waiting-notifications";

/** A fake of the app's window, and what it was asked to do. */
export interface FakeMainWindow {
  /** Provides the fake as the MainWindow service. */
  readonly layer: Layer.Layer<MainWindow>;
  /**
   * Each call made to the window, in order: the method's name, followed by
   * its arguments, such as `reload` or
   * `showAndSend destination.open {"kind":"thread","sessionId":"session-1"}`.
   */
  readonly calls: Array<string>;
  /** What `isFocused` returns; a test may change it. */
  focused: boolean;
  /** The folder `pickFolder` returns, or null for a cancelled dialog; a test may change it. */
  pickedFolder: string | null;
}

/**
 * Builds a fake window that records each call, that starts without the
 * focus, and whose folder dialog is cancelled.
 */
export const makeFakeMainWindow = (): FakeMainWindow => {
  const calls: Array<string> = [];
  const record = (call: string): Effect.Effect<void> =>
    Effect.sync(() => {
      calls.push(call);
    });
  const fake: FakeMainWindow = {
    calls,
    focused: false,
    pickedFolder: null,
    layer: Layer.succeed(MainWindow)({
      load: record("load"),
      reload: record("reload"),
      show: record("show"),
      showFirstTime: record("showFirstTime"),
      paintBackground: record("paintBackground"),
      isFocused: Effect.sync(() => fake.focused),
      showAndSend: (name, payload) => record(`showAndSend ${name} ${JSON.stringify(payload)}`),
      showWarning: (message) => record(`showWarning ${message}`),
      pickFolder: record("pickFolder").pipe(Effect.map(() => fake.pickedFolder)),
    }),
  };
  return fake;
};

/** A fake of Electron's `Notification` that records what is done to it. */
export interface FakeNotification extends NativeNotification {
  readonly title: string;
  readonly body: string;
  state: "new" | "shown" | "closed";
  /** Clicks the notification, as the user does. */
  click(): void;
}

/**
 * Builds a fake of Electron's `Notification` class. Returns the class, and
 * the list it adds each notification to as it is created.
 */
export const makeFakeNotificationClass = (): {
  readonly Notification: new (options: {
    readonly title: string;
    readonly body: string;
  }) => FakeNotification;
  readonly notifications: Array<FakeNotification>;
} => {
  const notifications: Array<FakeNotification> = [];
  class Notification implements FakeNotification {
    readonly title: string;
    readonly body: string;
    state: "new" | "shown" | "closed" = "new";
    private clickListener: (...args: never[]) => void = () => undefined;
    constructor(options: { readonly title: string; readonly body: string }) {
      this.title = options.title;
      this.body = options.body;
      notifications.push(this);
    }
    show() {
      this.state = "shown";
    }
    close() {
      this.state = "closed";
    }
    // Takes a listener of either event's type. Only the click's is kept, and
    // it is called with no argument, as the services' click listeners take
    // none.
    once(event: "click" | "failed", listener: (...args: never[]) => void): this {
      if (event === "click") this.clickListener = listener;
      return this;
    }
    click() {
      this.clickListener();
    }
  }
  return { Notification, notifications };
};

/** Writes a `/bin/sh` script with `body` at `path`, and makes it executable. */
export const writeShellScript = (path: string, body: string): void => {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
};

// The desktop scripts and the end-to-end suite check for a running process
// too, and they cannot import this file, so the one copy lives with them.
export { isProcessRunning } from "../../scripts/processes.ts";

/**
 * Waits until `check` returns true, checking every 20 milliseconds, and
 * fails after 5 seconds.
 */
export const waitUntil = async (check: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 250; tries++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("The condition did not hold within 5 seconds.");
};

/** A settings file in a temporary folder of its own. */
export interface TemporarySettingsFile {
  /** The file's path. No file is there until a test or a save writes one. */
  readonly path: string;
  /** Builds the settings service on the file, with Node's file system. */
  readonly layer: Layer.Layer<AppSettings>;
  /** Removes the folder and everything in it. */
  readonly remove: () => void;
}

/**
 * Creates a temporary folder for a settings file. Call it in `beforeEach`,
 * and return its `remove` from there, so the folder goes after each test.
 */
export const makeTemporarySettingsFile = (): TemporarySettingsFile => {
  const folder = mkdtempSync(join(tmpdir(), "hercule-desktop-settings-"));
  const path = join(folder, "settings.json");
  return {
    path,
    layer: makeAppSettingsLayer(path).pipe(Layer.provide(NodeFileSystem.layer)),
    remove: () => rmSync(folder, { recursive: true, force: true }),
  };
};

/**
 * Node's `fetch`, told not to follow redirects, in place of the app's, which
 * sends through Chromium's network stack and which only Electron can run.
 */
export const nodeFetchWithoutRedirects: FetchWithoutRedirects = (url, init) =>
  fetch(url, { ...init, redirect: "manual" });

/** How a fake HTTP server answers one request, `request`. */
export type HttpAnswer = (response: ServerResponse, request: IncomingMessage) => void;

/**
 * The headers of a fake HTTP server's answer. A header given an array of
 * values is sent once per value, as a proxy that adds its own value does.
 */
export type HttpHeaders = Record<string, string | Array<string>>;

/** Builds the answer with `status`, `headers` and `body`. */
export const buildHttpAnswer =
  (status: number, headers: HttpHeaders = {}, body = ""): HttpAnswer =>
  (response) =>
    response.writeHead(status, headers).end(body);

/** A fake HTTP server, listening on 127.0.0.1. */
export interface FakeHttpServer {
  /** The server's origin, such as `http://127.0.0.1:53124`. */
  readonly origin: string;
  /** The port the server listens on. */
  readonly port: number;
  /**
   * Stops the server and drops its open connections. Does nothing once the
   * server has stopped, so a test can stop it early, to have nothing listen
   * at its origin, and `afterEach` can still stop it again.
   */
  readonly close: () => Promise<void>;
}

/**
 * Starts an HTTP server on 127.0.0.1, at a port the system picks, that hands
 * each request to `listener`. Returns once the server listens.
 */
export const startFakeHttpServer = async (listener: RequestListener): Promise<FakeHttpServer> => {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    port,
    close: async () => {
      // Node never calls back the close of a server that has stopped.
      if (!server.listening) return;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
