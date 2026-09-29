/**
 * The app's menu bar: the app menu, File, Edit and Window, each with the
 * items macOS users expect there.
 *
 * There is no View menu in the packaged app, so it has no page zoom and no
 * reload. In development a View menu adds Reload and Toggle Developer Tools.
 *
 * This module imports only Electron's types, so unit tests can use it without
 * Electron.
 */
import type { MenuItemConstructorOptions } from "electron";

/**
 * Builds the menu bar's template, for `Menu.buildFromTemplate`. `development`
 * adds the View menu.
 *
 * - The app menu is Electron's own, named after the app: About, Services,
 *   Hide, Hide Others, Show All and Quit.
 * - File holds Close Window, ⌘W, where macOS users look for it. Closing the
 *   window hides it; the app keeps running.
 * - Edit and Window are Electron's own.
 */
export const buildMenuTemplate = (development: boolean): Array<MenuItemConstructorOptions> => {
  const view: MenuItemConstructorOptions = {
    label: "View",
    submenu: [{ role: "reload" }, { role: "toggleDevTools" }],
  };
  return [
    { role: "appMenu" },
    // The accelerator is the role's own; it is spelled out so that a test
    // can check it without Electron.
    { label: "File", submenu: [{ role: "close", accelerator: "CmdOrCtrl+W" }] },
    { role: "editMenu" },
    ...(development ? [view] : []),
    { role: "windowMenu" },
  ];
};
