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
import { homedir } from "node:os";
import path from "node:path";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { app, Menu, Notification, protocol, safeStorage, shell } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { AppScheme, makeAppSchemeLayer } from "./app-scheme";
import { makeAppSettingsLayer } from "./app-settings";
import { makeControllerConnectionLayer } from "./controller-connection";
import { fetchWithoutRedirects } from "./fetch-without-redirects";
import { makeThisMacLayer } from "./this-mac";
import { registerIpcHandlers } from "./ipc";
import { MainWindow } from "./main-window";
import { makeMainMenuLayer } from "./menu";
import { findRefusedArgument, readBinaryPathArgument } from "./refused-arguments";
import { APP_SCHEME } from "./renderer-origin";
import { makeRunnerIdentityLayer } from "./runner-identity";
import { makeSafeStorageLayer } from "./safe-storage";
import { secureSession, secureWebContents } from "./security";
import { StoredTokenLayer } from "./stored-token";
import { makeThreadNotificationsLayer } from "./thread-notifications";
import { MainWindowLayer } from "./window";

/**
 * The address of the renderer's dev server, set by `scripts/dev.ts`. A
 * packaged app never reads it, so no environment variable can make the
 * packaged app load its page from anywhere but its own bundle.
 */
const devServerUrl = app.isPackaged ? null : (process.env.HERCULE_DESKTOP_DEV_SERVER_URL ?? null);

/**
 * The Hercule binary main runs to find and start Hercule on this Mac: the
 * installed one, where the install script puts it, unless an end-to-end test
 * names a stand-in; see `readBinaryPathArgument`. The first argument is the
 * executable's path.
 */
const binaryPath =
  readBinaryPathArgument(process.argv.slice(1), app.isPackaged, inspector.url() !== undefined) ??
  path.join(homedir(), ".local", "bin", "hercule");

/** Opens `folder` in Finder. A folder Finder cannot open is logged as a warning. */
const openFolder = (folder: string): Effect.Effect<void> =>
  Effect.promise(() => shell.openPath(folder)).pipe(
    // `openPath` answers an empty string when it opened the folder.
    Effect.flatMap((error) =>
      error === "" ? Effect.void : Effect.logWarning(`Could not open ${folder}: ${error}`),
    ),
  );

/** Starts the app; see this module's comment. Call it once the single-instance lock is held. */
const startApp = (): void => {
  const threadNotifications = makeThreadNotificationsLayer({
    Notification,
    setBadgeCount: (count) => app.setBadgeCount(count),
    // Electron has no call that only asks. The first call that needs
    // notifications, `isSupported` among them, sets up Electron's
    // notification support, and on macOS that asks the user, once. This was
    // observed with Electron 44.
    askToNotify: () => {
      Notification.isSupported();
    },
  });
  const windowMenuAndNotifications = Layer.mergeAll(
    makeMainMenuLayer(Menu, !app.isPackaged),
    threadNotifications,
  ).pipe(Layer.provideMerge(MainWindowLayer));
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      makeThisMacLayer({ binaryPath, openFolder }).pipe(
        Layer.provideMerge(makeControllerConnectionLayer(fetchWithoutRedirects)),
        Layer.provideMerge(StoredTokenLayer.pipe(Layer.provide(makeSafeStorageLayer(safeStorage)))),
      ),
      makeRunnerIdentityLayer(fetchWithoutRedirects),
      makeAppSchemeLayer(devServerUrl),
    ).pipe(
      Layer.provideMerge(windowMenuAndNotifications),
      Layer.provideMerge(makeAppSettingsLayer(path.join(app.getPath("userData"), "settings.json"))),
      Layer.provide(NodeFileSystem.layer),
    ),
  );

  app.on("session-created", secureSession);
  app.on("web-contents-created", (_event, contents) =>
    secureWebContents(contents, (effect) => runtime.runFork(effect)),
  );
  registerIpcHandlers(runtime);

  app.on("activate", () => runtime.runFork(MainWindow.use((window) => window.show)));
  // A second launch comes from another app, often a terminal, and macOS
  // leaves that app in front. The user launched Hercule to use it, so the
  // app takes focus from whichever app has it.
  app.on("second-instance", () => {
    app.focus({ steal: true });
    runtime.runFork(MainWindow.use((window) => window.show));
  });
  // The app exits only once the runtime has shut down, so that a save of the
  // window's state that is under way finishes first. It exits even when the
  // shutdown fails, so that quitting never hangs.
  app.on("will-quit", (event) => {
    event.preventDefault();
    void runtime.dispose().finally(() => app.exit());
  });

  void app.whenReady().then(() => {
    protocol.handle(APP_SCHEME, (request) =>
      runtime.runPromise(AppScheme.use((scheme) => scheme.answer(request))),
    );
    runtime.runFork(MainWindow.use((window) => window.load));
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
