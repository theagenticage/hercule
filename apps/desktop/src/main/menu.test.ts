import { describe, expect, it } from "vitest";
import { buildMenuTemplate } from "./menu";

/** Returns every role in a template, depth first. */
const listRoles = (items: ReturnType<typeof buildMenuTemplate>): Array<string> =>
  items.flatMap((item) => [
    ...(item.role === undefined ? [] : [item.role]),
    ...(Array.isArray(item.submenu) ? listRoles(item.submenu) : []),
  ]);

describe("buildMenuTemplate", () => {
  it("has the app menu, File, Edit and Window in the packaged app", () => {
    expect(listRoles(buildMenuTemplate(false))).toEqual([
      "appMenu",
      "close",
      "editMenu",
      "windowMenu",
    ]);
  });

  it("keeps the app menu Electron's own, so it has Services", () => {
    const appMenu = buildMenuTemplate(false)[0];
    expect(appMenu).toEqual({ role: "appMenu" });
  });

  it("closes the window from File with ⌘W", () => {
    const file = buildMenuTemplate(false).find((item) => item.label === "File");
    expect(file?.submenu).toEqual([{ role: "close", accelerator: "CmdOrCtrl+W" }]);
  });

  it("has no reload, developer tools or zoom in the packaged app", () => {
    const roles = listRoles(buildMenuTemplate(false));
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
    const view = buildMenuTemplate(true).find((item) => item.label === "View");
    expect(view?.submenu).toEqual([{ role: "reload" }, { role: "toggleDevTools" }]);
    expect(listRoles(buildMenuTemplate(true))).toContain("windowMenu");
  });
});
