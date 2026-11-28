import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { DesktopPlatform } from "../ipc/platform/desktop-platform";
import { MainWindow } from "./main-window";
import { makeTemporarySettingsFile, type TemporarySettingsFile } from "./testing";

/**
 * What the faked `electron` module shows: the focused web contents, which
 * `webContents.getFocusedWebContents` returns, and the calls to
 * `Menu.sendActionToFirstResponder`.
 */
const electron = vi.hoisted(() => ({
  focused: null as unknown,
  sentToFirstResponder: [] as Array<string>,
  hasFirstResponder: true,
}));

/** Returns an object whose every method is a no-op, for the parts of Electron the test does not look at. */
const quiet = (): Record<string, unknown> =>
  new Proxy({}, { get: (_target, name) => (name === "then" ? undefined : () => undefined) });

vi.mock("electron", () => {
  class FakeBrowserWindow {
    webContents = quiet();
    getNormalBounds = () => ({ x: 0, y: 0, width: 1440, height: 900 });
    isFullScreen = () => false;
    isDestroyed = () => true;
    on = () => this;
    once = () => this;
  }
  return {
    app: { whenReady: () => Promise.resolve(), on: () => undefined, off: () => undefined },
    BrowserWindow: FakeBrowserWindow,
    dialog: quiet(),
    nativeTheme: { shouldUseDarkColors: false, on: () => undefined, off: () => undefined },
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getAllDisplays: () => [],
    },
    webContents: { getFocusedWebContents: () => electron.focused },
    // Linux's Electron has no `sendActionToFirstResponder`, so calling it throws there.
    get Menu() {
      return electron.hasFirstResponder
        ? {
            sendActionToFirstResponder: (action: string) =>
              electron.sentToFirstResponder.push(action),
          }
        : {};
    },
  };
});

let settingsFile: TemporarySettingsFile;

beforeEach(() => {
  settingsFile = makeTemporarySettingsFile();
  electron.focused = null;
  electron.sentToFirstResponder = [];
  return settingsFile.remove;
});

/** Steps `step` in the focused contents of a window built for `platform`. */
const step = async (platform: DesktopPlatform, step: "undo" | "redo"): Promise<void> => {
  const { makeMainWindowLayer } = await import("./window");
  const layer = makeMainWindowLayer(platform).pipe(Layer.provide(settingsFile.layer));
  await Effect.runPromise(
    Effect.scoped(
      MainWindow.use((window) => window.stepHistoryInFocusedContents(step)).pipe(
        Effect.provide(layer),
      ),
    ),
  );
};

describe("stepping the history of the focused contents with Undo or Redo", () => {
  it("steps the first responder on macOS when no web contents has the focus", async () => {
    electron.hasFirstResponder = true;
    await step("mac", "undo");
    await step("mac", "redo");
    expect(electron.sentToFirstResponder).toEqual(["undo:", "redo:"]);
  });

  it("does nothing on Linux when no web contents has the focus, where the first responder call does not exist", async () => {
    electron.hasFirstResponder = false;
    await expect(step("linux", "undo")).resolves.toBeUndefined();
    await expect(step("linux", "redo")).resolves.toBeUndefined();
  });

  it.each(["mac", "linux"] as const)(
    "steps another web contents of the app that has the focus on %s",
    async (platform) => {
      electron.hasFirstResponder = platform === "mac";
      const undo = vi.fn();
      electron.focused = { undo, redo: vi.fn() };
      await step(platform, "undo");
      expect(undo).toHaveBeenCalledOnce();
      expect(electron.sentToFirstResponder).toEqual([]);
    },
  );
});
