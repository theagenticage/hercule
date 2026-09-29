/**
 * The app's menu bar: the app menu, File, Edit and Window, each with the
 * items macOS users expect there, and the MainMenu service, through which
 * main enables and disables Sign Out.
 *
 * Main carries out none of the app's own items itself. It shows the window
 * and sends the page a menu command, and the page acts on it.
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
import { AppSettings } from "./app-settings";
import { MainWindow } from "./main-window";

/** The id of the Sign Out item, by which main finds it to enable or disable it. */
const SIGN_OUT_ITEM_ID = "signOut";

/**
 * Builds the menu bar's template, for `Menu.buildFromTemplate`.
 *
 * - The app menu holds what Electron's own app menu holds: About, Services,
 *   Hide, Hide Others, Show All and Quit. Sign Out sits above Quit, between
 *   separators. It is enabled when `signOutEnabled` is true, and choosing it
 *   calls `signOut`.
 * - File holds New Thread, ⌘N, which calls `newThread`, and Close Window,
 *   ⌘W, where macOS users look for it. Closing the window hides it; the app
 *   keeps running.
 * - Edit and Window are Electron's own.
 * - `development` adds the View menu.
 *
 * The app menu lists its items itself, because Electron's own app menu takes
 * no extra item. Its role still names it after the app.
 */
export const buildMenuTemplate = (options: {
  readonly development: boolean;
  readonly signOutEnabled: boolean;
  readonly signOut: () => void;
  readonly newThread: () => void;
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
        id: SIGN_OUT_ITEM_ID,
        label: "Sign Out",
        enabled: options.signOutEnabled,
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
    { role: "windowMenu" },
  ];
};

/** The app's menu bar, as main changes it while the app runs. */
export class MainMenu extends Context.Service<
  MainMenu,
  {
    /** Enables Sign Out when `enabled` is true, and disables it otherwise. */
    readonly setSignOutEnabled: (enabled: boolean) => Effect.Effect<void>;
  }
>()("hercule/desktop/MainMenu") {}

/**
 * Builds the MainMenu service on Electron's `Menu`: it builds the menu bar and
 * makes it the app's. Sign Out starts enabled when a login token is stored.
 * Choosing Sign Out or New Thread shows the window and sends the page the
 * `signOut` or `newThread` menu command, and the page carries it out.
 * `development` adds the View menu.
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
      const signOutEnabled = (yield* settings.readEncryptedToken) !== null;
      const menu = Menu.buildFromTemplate(
        buildMenuTemplate({
          development,
          signOutEnabled,
          signOut: () =>
            runFork(Effect.andThen(window.show, window.send("menu.command", "signOut"))),
          newThread: () =>
            runFork(Effect.andThen(window.show, window.send("menu.command", "newThread"))),
        }),
      );
      Menu.setApplicationMenu(menu);
      // The template has the item, so the menu built from it has it too.
      const signOut = menu.getMenuItemById(SIGN_OUT_ITEM_ID)!;
      return {
        setSignOutEnabled: (enabled) =>
          Effect.sync(() => {
            signOut.enabled = enabled;
          }),
      };
    }),
  );
