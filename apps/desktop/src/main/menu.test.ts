import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem";
import type { Menu as ElectronMenu } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { GoMenuThread } from "../ipc/contract";
import { makeAppSettingsLayer } from "./app-settings";
import { MainWindow } from "./main-window";
import { buildMenuTemplate, MainMenu, makeMainMenuLayer } from "./menu";

type MenuTemplate = ReturnType<typeof buildMenuTemplate>;
type MenuTemplateOptions = Parameters<typeof buildMenuTemplate>[0];

/** Returns every role in a template, depth first. */
const listRoles = (items: MenuTemplate): Array<string> =>
  items.flatMap((item) => [
    ...(item.role === undefined ? [] : [item.role]),
    ...(Array.isArray(item.submenu) ? listRoles(item.submenu) : []),
  ]);

/** Builds a template of the packaged app, signed out, with `overrides` applied. */
const buildTemplate = (overrides: Partial<MenuTemplateOptions> = {}): MenuTemplate =>
  buildMenuTemplate({
    development: false,
    signedIn: false,
    goThreads: [],
    signOut: () => undefined,
    newThread: () => undefined,
    openThread: () => undefined,
    send: () => undefined,
    ...overrides,
  });

/** Returns the items of the menu labelled `label`. */
const listMenuItems = (template: MenuTemplate, label: string): MenuTemplate => {
  const submenu = template.find((item) => item.label === label)?.submenu;
  if (!Array.isArray(submenu)) throw new Error(`the ${label} menu has no list of items`);
  return submenu;
};

/** Returns the items of the app menu, the first menu of `template`. */
const listAppMenuItems = (template: MenuTemplate): MenuTemplate => {
  const submenu = template[0]?.submenu;
  if (!Array.isArray(submenu)) throw new Error("the app menu has no list of items");
  return submenu;
};

/**
 * Chooses `item`. Electron passes the item, the focused window and the
 * event; the app's items read none of them.
 */
const choose = (item: MenuTemplate[number] | undefined): void => {
  (item?.click as () => void)();
};

const THREADS: ReadonlyArray<GoMenuThread> = [
  { sessionId: "session-1", title: "Fix the login bug" },
  { sessionId: "session-2", title: "Write the release notes" },
];

describe("buildMenuTemplate", () => {
  it("has the app menu, File, Edit, Go, Thread and Window, in that order", () => {
    expect(buildTemplate().map((item) => item.label ?? item.role)).toEqual([
      "appMenu",
      "File",
      "editMenu",
      "Go",
      "Thread",
      "windowMenu",
    ]);
  });

  it("holds About, Services, Hide, Hide Others, Show All, Sign Out and Quit in the app menu", () => {
    expect(
      listAppMenuItems(buildTemplate()).flatMap((item) => item.role ?? item.label ?? []),
    ).toEqual(["about", "services", "hide", "hideOthers", "unhide", "Sign Out", "quit"]);
  });

  it("puts Sign Out above Quit, between separators, in the app menu", () => {
    const items = listAppMenuItems(buildTemplate());
    const signOut = items.findIndex((item) => item.id === "signOut");
    expect(items[signOut]?.label).toBe("Sign Out");
    expect(items.slice(signOut - 1, signOut + 3).map((item) => item.type ?? item.role)).toEqual([
      "separator",
      undefined,
      "separator",
      "quit",
    ]);
  });

  it("enables Sign Out only while signed in", () => {
    const signOut = (signedIn: boolean) =>
      listAppMenuItems(buildTemplate({ signedIn })).find((item) => item.id === "signOut");
    expect(signOut(false)?.enabled).toBe(false);
    expect(signOut(true)?.enabled).toBe(true);
  });

  it("calls signOut when Sign Out is chosen", () => {
    let calls = 0;
    const template = buildTemplate({ signedIn: true, signOut: () => calls++ });
    choose(listAppMenuItems(template).find((item) => item.id === "signOut"));
    expect(calls).toBe(1);
  });

  it("has New Thread with ⌘N, then Close Window with ⌘W, in File", () => {
    const items = listMenuItems(buildTemplate(), "File");
    expect(items.map((item) => [item.label ?? item.role ?? item.type, item.accelerator])).toEqual([
      ["New Thread", "CmdOrCtrl+N"],
      ["separator", undefined],
      ["close", "CmdOrCtrl+W"],
    ]);
  });

  it("calls newThread when New Thread is chosen", () => {
    let calls = 0;
    const template = buildTemplate({ newThread: () => calls++ });
    choose(listMenuItems(template, "File").find((item) => item.label === "New Thread"));
    expect(calls).toBe(1);
  });

  it("lists the threads in Go, with ⌘1, ⌘2 and on", () => {
    const items = listMenuItems(buildTemplate({ goThreads: THREADS }), "Go");
    expect(items.map((item) => [item.label, item.accelerator])).toEqual([
      ["Fix the login bug", "CmdOrCtrl+1"],
      ["Write the release notes", "CmdOrCtrl+2"],
    ]);
  });

  it("calls openThread with the thread's session id when a thread in Go is chosen", () => {
    const opened: Array<string> = [];
    const template = buildTemplate({
      goThreads: THREADS,
      openThread: (sessionId) => opened.push(sessionId),
    });
    choose(listMenuItems(template, "Go")[1]);
    expect(opened).toEqual(["session-2"]);
  });

  it("holds one dimmed No Threads in Go when there is no thread", () => {
    expect(listMenuItems(buildTemplate(), "Go")).toEqual([{ label: "No Threads", enabled: false }]);
  });

  it("has Send with ⌘↵ in Thread, always enabled, which calls send", () => {
    let calls = 0;
    const items = listMenuItems(buildTemplate({ send: () => calls++ }), "Thread");
    expect(items.map((item) => [item.label, item.accelerator, item.enabled])).toEqual([
      ["Send", "CmdOrCtrl+Enter", undefined],
    ]);
    choose(items[0]);
    expect(calls).toBe(1);
  });

  it("has no reload, developer tools or zoom in the packaged app", () => {
    const roles = listRoles(buildTemplate());
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

  it("adds a View menu with Reload and Toggle Developer Tools after Edit in development", () => {
    const template = buildTemplate({ development: true });
    expect(template.map((item) => item.label ?? item.role)).toEqual([
      "appMenu",
      "File",
      "editMenu",
      "View",
      "Go",
      "Thread",
      "windowMenu",
    ]);
    expect(listMenuItems(template, "View")).toEqual([
      { role: "reload" },
      { role: "toggleDevTools" },
    ]);
  });
});

/** The controller URL a settings file with a stored token names. */
const CONTROLLER_URL = "http://127.0.0.1:4937";

describe("MainMenu", () => {
  let folder: string | undefined;

  afterEach(() => {
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  });

  /**
   * Runs `use` against the service built on a fake of Electron's `Menu` and on
   * a settings file that holds `settings`, or on no settings file when
   * `settings` is null. Returns the menu bar the app last installed.
   */
  const readMenuBarAfter = async (
    settings: object | null,
    use: (menu: MainMenu["Service"]) => Effect.Effect<unknown>,
  ): Promise<MenuTemplate> => {
    folder = mkdtempSync(join(tmpdir(), "hercule-desktop-menu-"));
    const file = join(folder, "settings.json");
    if (settings !== null) writeFileSync(file, JSON.stringify(settings));
    let installed: MenuTemplate = [];
    // The fake builds no menu: the template stands in for the menu it builds.
    const Menu = {
      buildFromTemplate: (template: MenuTemplate) => template as unknown as ElectronMenu,
      setApplicationMenu: (menu: ElectronMenu | null) => {
        installed = menu as unknown as MenuTemplate;
      },
    };
    const window = Layer.succeed(MainWindow)({
      load: Effect.void,
      reload: Effect.void,
      show: Effect.void,
      showFirstTime: Effect.void,
      isFocused: Effect.succeed(false),
      send: () => Effect.void,
      showWarning: () => Effect.void,
    });
    const layer = makeMainMenuLayer(Menu, false).pipe(
      Layer.provide(
        Layer.mergeAll(
          makeAppSettingsLayer(file).pipe(Layer.provide(NodeFileSystem.layer)),
          window,
        ),
      ),
    );
    await Effect.runPromise(Effect.provide(MainMenu.use(use), layer));
    return installed;
  };

  /** Returns the labels of the Go menu in `menuBar`. */
  const listGoLabels = (menuBar: MenuTemplate) =>
    listMenuItems(menuBar, "Go").map((item) => item.label);

  it.each([
    [
      "enabled when a login token is stored",
      { controllerUrl: CONTROLLER_URL, token: "AAEC" },
      true,
    ],
    ["disabled when none is stored", null, false],
  ])("starts with Sign Out %s", async (_case, settings, enabled) => {
    const menuBar = await readMenuBarAfter(settings, () => Effect.void);
    expect(listAppMenuItems(menuBar).find((item) => item.label === "Sign Out")?.enabled).toBe(
      enabled,
    );
  });

  it("lists the threads the page sends in Go while the user is signed in", async () => {
    const menuBar = await readMenuBarAfter(null, (menu) =>
      Effect.all([menu.setSignedIn(true), menu.setGoThreads(THREADS)]),
    );
    expect(listGoLabels(menuBar)).toEqual(["Fix the login bug", "Write the release notes"]);
  });

  it("empties Go when the user signs out, and ignores the threads the page sends after", async () => {
    const menuBar = await readMenuBarAfter(null, (menu) =>
      Effect.all([
        menu.setSignedIn(true),
        menu.setGoThreads(THREADS),
        menu.setSignedIn(false),
        menu.setGoThreads(THREADS),
      ]),
    );
    expect(listGoLabels(menuBar)).toEqual(["No Threads"]);
  });
});
