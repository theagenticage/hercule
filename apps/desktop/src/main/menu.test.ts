import { beforeEach, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import type { Menu as ElectronMenu, MenuItemConstructorOptions } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { GoMenuItem } from "../ipc/contract";
import { MainMenu, makeMainMenuLayer } from "./menu";
import {
  makeFakeMainWindow,
  makeTemporarySettingsFile,
  type TemporarySettingsFile,
} from "./testing";

type MenuTemplate = Array<MenuItemConstructorOptions>;

/** Returns every role in a template, depth first. */
const listRoles = (items: MenuTemplate): Array<string> =>
  items.flatMap((item) => [
    ...(item.role === undefined ? [] : [item.role]),
    ...(Array.isArray(item.submenu) ? listRoles(item.submenu) : []),
  ]);

/**
 * Returns the items of the menu of `menuBar` labelled `name`, or with the
 * role `name` when it has no label, as the app menu has.
 */
const listMenuItems = (menuBar: MenuTemplate, name: string): MenuTemplate => {
  const submenu = menuBar.find((item) => (item.label ?? item.role) === name)?.submenu;
  if (!Array.isArray(submenu)) throw new Error(`the ${name} menu has no list of items`);
  return submenu;
};

/** Returns the item labelled `label` in the menu `name` of `menuBar`, if there is one. */
const findMenuItem = (menuBar: MenuTemplate, name: string, label: string) =>
  listMenuItems(menuBar, name).find((item) => item.label === label);

/**
 * Returns whether each item only a signed-in user can choose is enabled in
 * `menuBar`: Settings…, Sign Out, New Thread, View's Threads and Hercule,
 * and Office, in that order.
 */
const readSignedInItemsEnabled = (menuBar: MenuTemplate): Array<boolean | undefined> =>
  [
    findMenuItem(menuBar, "appMenu", "Settings…"),
    findMenuItem(menuBar, "appMenu", "Sign Out"),
    findMenuItem(menuBar, "File", "New Thread"),
    findMenuItem(menuBar, "View", "Threads"),
    findMenuItem(menuBar, "View", "Hercule"),
    findMenuItem(menuBar, "Go", "Office"),
  ].map((item) => item?.enabled);

/** Chooses an item of the menu bar, as the user does, by its menu's name and its label. */
type ChooseMenuItem = (name: string, label: string) => Effect.Effect<void>;

/** What a run of the service left behind. */
interface MenuRun {
  /** The menu bar the app installed last. */
  readonly menuBar: MenuTemplate;
  /** Each call the menu made to the window, as the fake window records it. */
  readonly window: Array<string>;
}

const GO_ITEMS: ReadonlyArray<GoMenuItem> = [
  { destination: { kind: "thread", sessionId: "session-1" }, title: "Fix the login bug" },
  { destination: { kind: "thread", sessionId: "session-2" }, title: "Write the release notes" },
  { destination: { kind: "assistant", assistantId: "assistant-1" }, title: "Ada" },
];

/** The controller URL a settings file with a stored token names. */
const CONTROLLER_URL = "http://127.0.0.1:4937";

let settingsFile: TemporarySettingsFile;

beforeEach(() => {
  settingsFile = makeTemporarySettingsFile();
  return settingsFile.remove;
});

/**
 * Runs `use` against the service built on a fake of Electron's `Menu`, a fake
 * window and the temporary settings file, in the packaged app unless
 * `development` is true. `use` receives the service and a function that
 * chooses an item of the menu bar installed last. Returns that menu bar and
 * the calls made to the window.
 */
const runWithMenu = async (
  use: (menu: MainMenu["Service"], choose: ChooseMenuItem) => Effect.Effect<unknown>,
  development = false,
): Promise<MenuRun> => {
  let menuBar: MenuTemplate = [];
  // The fake builds no menu: the template stands in for the menu it builds.
  const Menu = {
    buildFromTemplate: (template: MenuTemplate) => template as unknown as ElectronMenu,
    setApplicationMenu: (menu: ElectronMenu | null) => {
      menuBar = menu as unknown as MenuTemplate;
    },
  };
  // Electron passes a click the item, the focused window and the event; the
  // app's items read none of them.
  const choose: ChooseMenuItem = (name, label) =>
    Effect.sync(() => (findMenuItem(menuBar, name, label)?.click as () => void)());
  const window = makeFakeMainWindow();
  const layer = makeMainMenuLayer(Menu, development).pipe(
    Layer.provide(Layer.mergeAll(settingsFile.layer, window.layer)),
  );
  await Effect.runPromise(
    Effect.provide(
      MainMenu.use((menu) => use(menu, choose)),
      layer,
    ),
  );
  return { menuBar, window: window.calls };
};

/** Returns the menu bar the service installs at start, in the packaged app unless `development` is true. */
const readFirstMenuBar = async (development = false): Promise<MenuTemplate> =>
  (await runWithMenu(() => Effect.void, development)).menuBar;

describe("MainMenu", () => {
  it("has the app menu, File, Edit, View, Go, Thread and Window, in that order", async () => {
    expect((await readFirstMenuBar()).map((item) => item.label ?? item.role)).toEqual([
      "appMenu",
      "File",
      "editMenu",
      "View",
      "Go",
      "Thread",
      "windowMenu",
    ]);
  });

  it("holds About, Settings…, Services, Hide, Hide Others, Show All, Sign Out and Quit in the app menu", async () => {
    expect(
      listMenuItems(await readFirstMenuBar(), "appMenu").flatMap(
        (item) => item.role ?? item.label ?? [],
      ),
    ).toEqual([
      "about",
      "Settings…",
      "services",
      "hide",
      "hideOthers",
      "unhide",
      "Sign Out",
      "quit",
    ]);
  });

  it("puts Settings… with ⌘, under About, between separators, in the app menu", async () => {
    const items = listMenuItems(await readFirstMenuBar(), "appMenu");
    expect(
      items.slice(0, 5).map((item) => [item.role ?? item.label ?? item.type, item.accelerator]),
    ).toEqual([
      ["about", undefined],
      ["separator", undefined],
      ["Settings…", "CmdOrCtrl+,"],
      ["separator", undefined],
      ["services", undefined],
    ]);
  });

  it("shows the window and sends the page openSettings when Settings… is chosen", async () => {
    const { window } = await runWithMenu((menu, choose) =>
      Effect.all([menu.setSignedIn(true), choose("appMenu", "Settings…")]),
    );
    expect(window).toEqual(['showAndSend menu.command "openSettings"']);
  });

  it("puts Sign Out above Quit, between separators, in the app menu", async () => {
    const items = listMenuItems(await readFirstMenuBar(), "appMenu");
    const signOut = items.findIndex((item) => item.label === "Sign Out");
    expect(items.slice(signOut - 1, signOut + 3).map((item) => item.type ?? item.role)).toEqual([
      "separator",
      undefined,
      "separator",
      "quit",
    ]);
  });

  it.each([
    [
      "enabled when a login token is stored",
      { controllerUrl: CONTROLLER_URL, token: "AAEC" },
      [true, true, true, true, true, true],
    ],
    ["disabled when none is stored", null, [false, false, false, false, false, false]],
  ])(
    "starts with Settings…, Sign Out, New Thread, Threads, Hercule and Office %s",
    async (_case, settings, enabled) => {
      if (settings !== null) writeFileSync(settingsFile.path, JSON.stringify(settings));
      expect(readSignedInItemsEnabled(await readFirstMenuBar())).toEqual(enabled);
    },
  );

  it("enables Settings…, Sign Out, New Thread, Threads, Hercule and Office when the user signs in, and disables them when the user signs out", async () => {
    const readEnabled = async (use: (menu: MainMenu["Service"]) => Effect.Effect<unknown>) =>
      readSignedInItemsEnabled((await runWithMenu(use)).menuBar);
    expect(await readEnabled((menu) => menu.setSignedIn(true))).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(
      await readEnabled((menu) => Effect.all([menu.setSignedIn(true), menu.setSignedIn(false)])),
    ).toEqual([false, false, false, false, false, false]);
  });

  it("shows the window and sends the page signOut when Sign Out is chosen", async () => {
    const { window } = await runWithMenu((menu, choose) =>
      Effect.all([menu.setSignedIn(true), choose("appMenu", "Sign Out")]),
    );
    expect(window).toEqual(['showAndSend menu.command "signOut"']);
  });

  it("has New Thread with ⌘N, then Close Window with ⌘W, in File", async () => {
    const items = listMenuItems(await readFirstMenuBar(), "File");
    expect(items.map((item) => [item.label ?? item.role ?? item.type, item.accelerator])).toEqual([
      ["New Thread", "CmdOrCtrl+N"],
      ["separator", undefined],
      ["close", "CmdOrCtrl+W"],
    ]);
  });

  it("shows the window and sends the page newThread when New Thread is chosen", async () => {
    const { window } = await runWithMenu((menu, choose) =>
      Effect.all([menu.setSignedIn(true), choose("File", "New Thread")]),
    );
    expect(window).toEqual(['showAndSend menu.command "newThread"']);
  });

  it("has Threads with ⌥⌘1, then Hercule with ⌥⌘2, in View", async () => {
    const items = listMenuItems(await readFirstMenuBar(), "View");
    expect(items.map((item) => [item.label ?? item.role ?? item.type, item.accelerator])).toEqual([
      ["Threads", "Alt+CmdOrCtrl+1"],
      ["Hercule", "Alt+CmdOrCtrl+2"],
    ]);
  });

  it.each([
    ["Threads", "showThreadsFace"],
    ["Hercule", "showOrchestrationFace"],
  ])("shows the window and sends the page the face when %s is chosen", async (label, command) => {
    const { window } = await runWithMenu((menu, choose) =>
      Effect.all([menu.setSignedIn(true), choose("View", label)]),
    );
    expect(window).toEqual([`showAndSend menu.command "${command}"`]);
  });

  it("holds Office with ⌘⇧O, then a separator and one dimmed No Threads, in Go at start", async () => {
    const items = listMenuItems(await readFirstMenuBar(), "Go");
    expect(items.map((item) => [item.label ?? item.type, item.accelerator, item.enabled])).toEqual([
      ["Office", "CmdOrCtrl+Shift+O", false],
      ["separator", undefined, undefined],
      ["No Threads", undefined, false],
    ]);
  });

  it("shows the window and sends the page openOffice when Office is chosen", async () => {
    const { window } = await runWithMenu((menu, choose) =>
      Effect.all([menu.setSignedIn(true), choose("Go", "Office")]),
    );
    expect(window).toEqual(['showAndSend menu.command "openOffice"']);
  });

  it("lists the items the page sends in Go, with ⌘1, ⌘2 and on, while the user is signed in", async () => {
    const { menuBar } = await runWithMenu((menu) =>
      Effect.all([menu.setSignedIn(true), menu.setGoItems(GO_ITEMS)]),
    );
    expect(listMenuItems(menuBar, "Go").map((item) => [item.label, item.accelerator])).toEqual([
      ["Office", "CmdOrCtrl+Shift+O"],
      [undefined, undefined],
      ["Fix the login bug", "CmdOrCtrl+1"],
      ["Write the release notes", "CmdOrCtrl+2"],
      ["Ada", "CmdOrCtrl+3"],
    ]);
  });

  it("shows the window and asks the page to open the item's destination when an item in Go is chosen", async () => {
    const { window } = await runWithMenu((menu, choose) =>
      Effect.all([
        menu.setSignedIn(true),
        menu.setGoItems(GO_ITEMS),
        choose("Go", "Write the release notes"),
        choose("Go", "Ada"),
      ]),
    );
    expect(window).toEqual([
      'showAndSend destination.open {"kind":"thread","sessionId":"session-2"}',
      'showAndSend destination.open {"kind":"assistant","assistantId":"assistant-1"}',
    ]);
  });

  it("empties Go when the user signs out, and ignores the items the page sends after", async () => {
    const { menuBar } = await runWithMenu((menu) =>
      Effect.all([
        menu.setSignedIn(true),
        menu.setGoItems(GO_ITEMS),
        menu.setSignedIn(false),
        menu.setGoItems(GO_ITEMS),
      ]),
    );
    expect(listMenuItems(menuBar, "Go").map((item) => item.label)).toEqual([
      "Office",
      undefined,
      "No Threads",
    ]);
  });

  it("has Send with ⌘↵ in Thread, always enabled", async () => {
    const items = listMenuItems(await readFirstMenuBar(), "Thread");
    expect(items.map((item) => [item.label, item.accelerator, item.enabled])).toEqual([
      ["Send", "CmdOrCtrl+Enter", undefined],
    ]);
  });

  it("shows the window and sends the page send when Send is chosen", async () => {
    const { window } = await runWithMenu((_menu, choose) => choose("Thread", "Send"));
    expect(window).toEqual(['showAndSend menu.command "send"']);
  });

  it("has no reload, developer tools or zoom in the packaged app", async () => {
    const roles = listRoles(await readFirstMenuBar());
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

  it("adds Reload and Toggle Developer Tools to View, under a separator, in development", async () => {
    const items = listMenuItems(await readFirstMenuBar(true), "View");
    expect(items.map((item) => item.label ?? item.role ?? item.type)).toEqual([
      "Threads",
      "Hercule",
      "separator",
      "reload",
      "toggleDevTools",
    ]);
  });
});
