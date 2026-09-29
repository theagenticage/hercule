import { describe, expect, it } from "vitest";
import { buildMenuTemplate } from "./menu";

type MenuTemplate = ReturnType<typeof buildMenuTemplate>;

/** Returns every role in a template, depth first. */
const listRoles = (items: MenuTemplate): Array<string> =>
  items.flatMap((item) => [
    ...(item.role === undefined ? [] : [item.role]),
    ...(Array.isArray(item.submenu) ? listRoles(item.submenu) : []),
  ]);

/** Builds the template of the packaged app, or of development. */
const buildTemplate = (development: boolean, signOutEnabled = false): MenuTemplate =>
  buildMenuTemplate({ development, signOutEnabled, signOut: () => undefined });

/** Returns the items of the app menu, the first menu of `template`. */
const listAppMenuItems = (template: MenuTemplate): MenuTemplate => {
  const submenu = template[0]?.submenu;
  if (!Array.isArray(submenu)) throw new Error("the app menu has no list of items");
  return submenu;
};

describe("buildMenuTemplate", () => {
  it("has the app menu, File, Edit and Window in the packaged app", () => {
    expect(listRoles(buildTemplate(false))).toEqual([
      "appMenu",
      "about",
      "services",
      "hide",
      "hideOthers",
      "unhide",
      "quit",
      "close",
      "editMenu",
      "windowMenu",
    ]);
  });

  it("puts Sign Out above Quit, between separators, in the app menu", () => {
    const items = listAppMenuItems(buildTemplate(false));
    const signOut = items.findIndex((item) => item.id === "signOut");
    expect(items[signOut]?.label).toBe("Sign Out");
    expect(items.slice(signOut - 1, signOut + 3).map((item) => item.type ?? item.role)).toEqual([
      "separator",
      undefined,
      "separator",
      "quit",
    ]);
  });

  it("enables Sign Out only when asked to", () => {
    const signOut = (signOutEnabled: boolean) =>
      listAppMenuItems(buildTemplate(false, signOutEnabled)).find((item) => item.id === "signOut");
    expect(signOut(false)?.enabled).toBe(false);
    expect(signOut(true)?.enabled).toBe(true);
  });

  it("calls signOut when Sign Out is chosen", () => {
    let calls = 0;
    const template = buildMenuTemplate({
      development: false,
      signOutEnabled: true,
      signOut: () => calls++,
    });
    const signOut = listAppMenuItems(template).find((item) => item.id === "signOut");
    // Electron passes the item, the focused window and the event; Sign Out
    // reads none of them.
    (signOut?.click as () => void)();
    expect(calls).toBe(1);
  });

  it("closes the window from File with ⌘W", () => {
    const file = buildTemplate(false).find((item) => item.label === "File");
    expect(file?.submenu).toEqual([{ role: "close", accelerator: "CmdOrCtrl+W" }]);
  });

  it("has no reload, developer tools or zoom in the packaged app", () => {
    const roles = listRoles(buildTemplate(false));
    for (const role of [
      "reload",
      "forceReload",
      "toggleDevTools",
      "viewMenu",
      "zoomIn",
      "resetZoom",
    ]) {
      expect(roles).not.toContain(role);
    }
  });

  it("adds a View menu with Reload and Toggle Developer Tools in development", () => {
    const view = buildTemplate(true).find((item) => item.label === "View");
    expect(view?.submenu).toEqual([{ role: "reload" }, { role: "toggleDevTools" }]);
    expect(listRoles(buildTemplate(true))).toContain("windowMenu");
  });
});
