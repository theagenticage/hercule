/**
 * The app's menu bar: the app menu, File, Edit, Go, Thread and Window, and
 * the MainMenu service, through which main changes it while the app runs.
 *
 * Main carries out none of the app's own items itself. It shows the window
 * and sends the page a menu command, or asks it to open a thread, and the
 * page acts on it.
 *
 * There is no View menu in the packaged app, so it has no page zoom and no
 * reload. In development a View menu adds Reload and Toggle Developer Tools.
 *
 * This module imports only Electron's types, and the layer takes Electron's
 * `Menu` as an argument, so unit tests can use the module without Electron.
 */
import type { Menu as ElectronMenu, MenuItemConstructorOptions } from "electron";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import type { GoMenuThread, MenuCommand } from "../ipc/contract";
import { AppSettings } from "./app-settings";
import { MainWindow } from "./main-window";

/**
 * Builds the menu bar's template, for `Menu.buildFromTemplate`.
 *
 * - The app menu holds what Electron's own app menu holds: About, Services,
 *   Hide, Hide Others, Show All and Quit. Sign Out sits above Quit, between
 *   separators. It is enabled when `signedIn` is true, and choosing it calls
 *   `signOut`.
 * - File holds New Thread, ⌘N, which calls `newThread`, and Close Window,
 *   ⌘W, where macOS users look for it. Closing the window hides it; the app
 *   keeps running.
 * - Go starts with Office, ⌘⇧O, which calls `openOffice`, because the
 *   Office is a place to go, as a thread is. Below a separator it lists
 *   `goThreads`, the first nine threads of the sidebar, with ⌘1 to ⌘9, each
 *   titled with its thread's title. Choosing one calls `openThread` with its
 *   session id. With no thread, one dimmed "No Threads" stands in for them.
 * - Thread holds Send, ⌘↵, which calls `send`. It is always enabled: main
 *   cannot tell whether the page has anything to send, and with nothing to
 *   send the page does nothing, as ⏎ in an empty field does.
 * - Edit and Window are Electron's own.
 * - `development` adds the View menu.
 *
 * The app menu lists its items itself, because Electron's own app menu takes
 * no extra item. Its role still names it after the app.
 *
 * The page sees a key press before the menu does, and a page that handles
 * the press stops the menu's item. So ⌘1 to ⌘9 pick a project while the
 * project picker is open, and ⌘↵ in a message field sends once, from the
 * field.
 */
const buildMenuTemplate = (options: {
  readonly development: boolean;
  readonly signedIn: boolean;
  readonly goThreads: ReadonlyArray<GoMenuThread>;
  readonly signOut: () => void;
  readonly newThread: () => void;
  readonly openOffice: () => void;
  readonly openThread: (sessionId: string) => void;
  readonly send: () => void;
}): Array<MenuItemConstructorOptions> => {
  const appMenu: MenuItemConstructorOptions = {
    role: "appMenu",
    submenu: [
      { role: "about" },
      { type: "separator" },
      { role: "services" },
      { type: "separator" },
      { role: "hide" },
      { role: "hideOthers" },
      { role: "unhide" },
      { type: "separator" },
      {
        id: "signOut",
        label: "Sign Out",
        enabled: options.signedIn,
        click: options.signOut,
      },
      { type: "separator" },
      { role: "quit" },
    ],
  };
  const view: MenuItemConstructorOptions = {
    label: "View",
    submenu: [{ role: "reload" }, { role: "toggleDevTools" }],
  };
  return [
    appMenu,
    {
      label: "File",
      submenu: [
        {
          label: "New Thread",
          accelerator: "CmdOrCtrl+N",
          click: options.newThread,
        },
        { type: "separator" },
        // The accelerator is the role's own; it is spelled out so that a test
        // can check it without Electron.
        { role: "close", accelerator: "CmdOrCtrl+W" },
      ],
    },
    { role: "editMenu" },
    ...(options.development ? [view] : []),
    {
      label: "Go",
      submenu: [
        { label: "Office", accelerator: "CmdOrCtrl+Shift+O", click: options.openOffice },
        { type: "separator" },
        ...(options.goThreads.length === 0
          ? [{ label: "No Threads", enabled: false }]
          : options.goThreads.map((thread, index) => ({
              label: thread.title,
              accelerator: `CmdOrCtrl+${String(index + 1)}`,
              click: () => options.openThread(thread.sessionId),
            }))),
      ],
    },
    {
      label: "Thread",
      submenu: [{ label: "Send", accelerator: "CmdOrCtrl+Enter", click: options.send }],
    },
    { role: "windowMenu" },
  ];
};

/** The app's menu bar, as main changes it while the app runs. */
export class MainMenu extends Context.Service<
  MainMenu,
  {
    /**
     * Enables Sign Out when `signedIn` is true. Otherwise disables it and
     * removes the Go menu's threads, which the app can no longer open.
     */
    readonly setSignedIn: (signedIn: boolean) => Effect.Effect<void>;

    /**
     * Replaces the threads the Go menu lists, the first nine of the sidebar.
     * Does nothing while the user is signed out: a page that is still
     * leaving the shell may send its threads after the user signed out.
     */
    readonly setGoThreads: (threads: ReadonlyArray<GoMenuThread>) => Effect.Effect<void>;
  }
>()("hercule/desktop/MainMenu") {}

/**
 * Builds the MainMenu service on Electron's `Menu`: it builds the menu bar and
 * makes it the app's. Sign Out starts enabled when a login token is stored,
 * and Go lists no thread until the page lists the sidebar's threads.
 *
 * Choosing Sign Out, New Thread, Office or Send shows the window and sends
 * the page that menu command. Choosing a thread in Go shows the window and
 * asks the page to open it. `development` adds the View menu.
 *
 * Each change builds the menu bar again, because macOS does not show a new
 * label on an item that is already built.
 *
 * The layer needs the window, which is built only once the app is ready, so
 * the menu is also made the app's only then, as Electron requires.
 */
export const makeMainMenuLayer = (
  Menu: Pick<typeof ElectronMenu, "buildFromTemplate" | "setApplicationMenu">,
  development: boolean,
): Layer.Layer<MainMenu, never, AppSettings | MainWindow> =>
  Layer.effect(MainMenu)(
    Effect.gen(function* () {
      const window = yield* MainWindow;
      const settings = yield* AppSettings;
      const runFork = yield* FiberSet.makeRuntime();
      /** Shows the window and sends the page `command`. */
      const sendMenuCommand = (command: MenuCommand): void => {
        runFork(window.showAndSend("menu.command", command));
      };
      // Read from the settings file, so that Sign Out is right in the first
      // menu bar, while the page still loads; the page's first token read
      // sets it again. The threads' notifications start signed out, for the
      // reason makeThreadNotificationsLayer gives.
      let signedIn = (yield* settings.readEncryptedToken) !== null;
      let goThreads: ReadonlyArray<GoMenuThread> = [];

      /** Builds the menu bar from the current state and makes it the app's. */
      const installMenuBar = (): void => {
        Menu.setApplicationMenu(
          Menu.buildFromTemplate(
            buildMenuTemplate({
              development,
              signedIn,
              goThreads,
              signOut: () => sendMenuCommand("signOut"),
              newThread: () => sendMenuCommand("newThread"),
              openOffice: () => sendMenuCommand("openOffice"),
              send: () => sendMenuCommand("send"),
              openThread: (sessionId) => runFork(window.showAndSend("thread.open", { sessionId })),
            }),
          ),
        );
      };
      installMenuBar();

      return {
        setSignedIn: (next) =>
          Effect.sync(() => {
            signedIn = next;
            if (!next) goThreads = [];
            installMenuBar();
          }),
        setGoThreads: (threads) =>
          Effect.sync(() => {
            if (!signedIn) return;
            goThreads = threads;
            installMenuBar();
          }),
      };
    }),
  );
