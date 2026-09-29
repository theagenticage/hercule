/**
 * Starts the desktop app's main process.
 *
 * Before Electron is ready, and synchronously, it:
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
import path from "node:path";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import { app, Menu, protocol } from "electron";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { answerAppRequest, makeAppSchemeLayer } from "./app-scheme";
import { makeAppSettingsLayer } from "./app-settings";
import { registerIpcHandlers } from "./ipc";
import { buildMenuTemplate } from "./menu";
import { APP_SCHEME } from "./renderer-origin";
import { secureSession, secureWebContents } from "./security";
import { loadMainWindow, MainWindowLayer, showMainWindow } from "./window";

/**
 * The address of the renderer's dev server, set by `scripts/dev.ts`. A
 * packaged app never reads it, so no environment variable can make the
 * packaged app load its page from anywhere but its own bundle.
 */
const devServerUrl = app.isPackaged ? null : (process.env.HERCULE_DESKTOP_DEV_SERVER_URL ?? null);

/** Starts the app; see this module's comment. Call it once the single-instance lock is held. */
const startApp = (): void => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(MainWindowLayer, makeAppSchemeLayer(devServerUrl)).pipe(
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
  app.on("second-instance", () => runtime.runFork(showMainWindow));
  // The app exits only once the runtime has shut down, so that a save of the
  // window's state that is under way finishes first. It exits even when the
  // shutdown fails, so that quitting never hangs.
  app.on("will-quit", (event) => {
    event.preventDefault();
    void runtime.dispose().finally(() => app.exit());
  });

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(!app.isPackaged)));
    protocol.handle(APP_SCHEME, (request) => runtime.runPromise(answerAppRequest(request)));
    runtime.runFork(loadMainWindow);
  });
};

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
