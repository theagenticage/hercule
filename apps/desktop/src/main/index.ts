/**
 * Starts the desktop app's main process.
 *
 * First, it refuses to start, printing why and exiting with code 1, when the
 * packaged app is given a command-line argument it does not allow, because
 * some would let another program read the signed-in session; see
 * `findRefusedArgument`.
 *
 * Then, before Electron is ready, and synchronously, it:
 *
 * - registers the `app` scheme's privileges, which Electron takes only then;
 * - takes the single-instance lock, and quits when another instance of the
 *   app holds it;
 * - installs the security hooks on every session and every web contents to
 *   come.
 *
 * The rest runs on one Effect runtime, made here. Each Electron callback is
 * one line that runs an effect on it. The runtime is disposed when the app
 * quits.
 *
 * The top level stays synchronous and does little: Electron waits for this
 * module to finish before it emits `ready`.
 */
import { writeSync } from "node:fs";
import inspector from "node:inspector";
import path from "node:path";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { app, Menu, protocol, safeStorage } from "electron";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { answerAppRequest, makeAppSchemeLayer } from "./app-scheme";
import { makeAppSettingsLayer } from "./app-settings";
import { makeControllerConnectionLayer } from "./controller-connection";
import { fetchWithoutRedirects } from "./fetch-without-redirects";
import { registerIpcHandlers } from "./ipc";
import { loadMainWindow, showMainWindow } from "./main-window";
import { makeMainMenuLayer } from "./menu";
import { findRefusedArgument } from "./refused-arguments";
import { APP_SCHEME } from "./renderer-origin";
import { makeRunnerIdentityLayer } from "./runner-identity";
import { makeSafeStorageLayer } from "./safe-storage";
import { openInBrowser, secureSession, secureWebContents } from "./security";
import { StoredTokenLayer } from "./stored-token";
import { MainWindowLayer } from "./window";

/**
 * The address of the renderer's dev server, set by `scripts/dev.ts`. A
 * packaged app never reads it, so no environment variable can make the
 * packaged app load its page from anywhere but its own bundle.
 */
const devServerUrl = app.isPackaged ? null : (process.env.HERCULE_DESKTOP_DEV_SERVER_URL ?? null);

/** Starts the app; see this module's comment. Call it once the single-instance lock is held. */
const startApp = (): void => {
  const windowAndMenu = makeMainMenuLayer(Menu, !app.isPackaged).pipe(
    Layer.provideMerge(MainWindowLayer),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      StoredTokenLayer.pipe(Layer.provide(makeSafeStorageLayer(safeStorage))),
      makeControllerConnectionLayer(openInBrowser, fetchWithoutRedirects),
      makeRunnerIdentityLayer(fetchWithoutRedirects),
      makeAppSchemeLayer(devServerUrl),
    ).pipe(
      Layer.provideMerge(windowAndMenu),
      Layer.provideMerge(makeAppSettingsLayer(path.join(app.getPath("userData"), "settings.json"))),
      Layer.provide(NodeFileSystem.layer),
    ),
  );

  app.on("session-created", secureSession);
  app.on("web-contents-created", (_event, contents) =>
    secureWebContents(contents, (effect) => runtime.runFork(effect)),
  );
  registerIpcHandlers(runtime);

  app.on("activate", () => runtime.runFork(showMainWindow));
  // A second launch comes from another app, often a terminal, and macOS
  // leaves that app in front. The user launched Hercule to use it, so the
  // app takes focus from whichever app has it.
  app.on("second-instance", () => {
    app.focus({ steal: true });
    runtime.runFork(showMainWindow);
  });
  // The app exits only once the runtime has shut down, so that a save of the
  // window's state that is under way finishes first. It exits even when the
  // shutdown fails, so that quitting never hangs.
  app.on("will-quit", (event) => {
    event.preventDefault();
    void runtime.dispose().finally(() => app.exit());
  });

  void app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, (request) => runtime.runPromise(answerAppRequest(request)));
    runtime.runFork(loadMainWindow);
  });
};

// The first argument is the executable's path.
const refusedArgument = findRefusedArgument(
  process.argv.slice(1),
  app.isPackaged,
  inspector.url() !== undefined,
);
if (refusedArgument !== undefined) {
  // Written synchronously: on macOS a write to a pipe is asynchronous, and
  // the app exits right after. The argument is quoted as a JSON string, so a
  // space, tab or newline in it shows.
  writeSync(
    process.stderr.fd,
    `Hercule does not start with the argument ${JSON.stringify(refusedArgument)}: it refuses every command-line argument but a few, because some would let another program read your signed-in session. Start it without that argument.\n`,
  );
  app.exit(1);
} else {
  // Spec 17 (§Reaching the controller) says why the renderer needs each of
  // these privileges.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        codeCache: true,
      },
    },
  ]);

  if (app.requestSingleInstanceLock()) {
    startApp();
  } else {
    app.quit();
  }
}
