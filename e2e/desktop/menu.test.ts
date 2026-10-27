/**
 * Tests the menu bar in the packaged app (spec 17, §Native behaviour):
 *
 * - the menus stand in the order macOS users expect; while signed out, View
 *   holds a dimmed Threads and Hercule, and Go a dimmed Office, Intake,
 *   Workflows and "No Threads";
 * - Go lists the sidebar's threads under Office, Intake and Workflows, top
 *   to bottom, with ⌘1 and on, and choosing one opens it;
 * - Thread > Send sends what the open thread's composer holds;
 * - Edit > Undo and Edit > Redo step through the edits of the thread's
 *   composer and of a plain text field, go to a native control that has the
 *   focus, such as the folder sheet's, and never show a hidden window.
 *
 * Signed in, the app reaches a real controller whose threads run on a
 * scripted runner. Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { isWindowVisible } from "../../apps/desktop/scripts/packaged-app";
import {
  arrangeFleet,
  chooseMenuItem,
  chooseMenuItemWithPageFocused,
  copyToClipboard,
  focusWindow,
  hideWindow,
  keepWindowOnTop,
  launchForTest,
  openSignedIn,
  openThread,
  readFieldText,
  readMenuItems,
  readMenuLabels,
  readOpenThreadTitle,
} from "./harness";

/** Opens the one thread of a scripted runner in a signed-in app, and returns the app, its page and its composer's message field. */
async function openThreadComposer() {
  const { url, fleet, waitForStatus } = await arrangeFleet();
  const runner = await fleet.enlistRunner("studio");
  const { thread, played } = await fleet.spawnScriptedThread(
    { runner, prompt: "Why does the checkout test fail?" },
    [{ kind: "end", state: "completed" }],
  );
  await played;
  await waitForStatus(thread.id, "idle");
  const { app, page } = await openSignedIn(url);
  await keepWindowOnTop(app);
  await openThread(page, "Why does the checkout test fail?");
  await focusWindow(app);
  return { app, page, field: page.getByRole("textbox", { name: "Message" }) };
}

/** Returns the titles of the sidebar's thread rows, top to bottom. */
function readSidebarTitles(page: Page): Promise<string[]> {
  return page
    .locator('nav[aria-label="Threads"] a.side-row:not(.side-row--wait) .side-name')
    .allTextContents();
}

describe("the menu bar", () => {
  it("has the app menu, File, Edit, View, Go, Thread and Window, and dims View's faces and Go's items while signed out", async () => {
    const { app } = await launchForTest();

    expect(await readMenuLabels(app)).toEqual([
      "Hercule",
      "File",
      "Edit",
      "View",
      "Go",
      "Thread",
      "Window",
    ]);
    expect(await readMenuItems(app, "View")).toEqual([
      { label: "Threads", accelerator: "Alt+CmdOrCtrl+1", enabled: false },
      { label: "Hercule", accelerator: "Alt+CmdOrCtrl+2", enabled: false },
      { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", enabled: false },
    ]);
    expect(await readMenuItems(app, "Go")).toEqual([
      { label: "Office", accelerator: "CmdOrCtrl+Shift+O", enabled: false },
      { label: "Intake", accelerator: "CmdOrCtrl+Shift+I", enabled: false },
      { label: "Workflows", accelerator: "CmdOrCtrl+Shift+W", enabled: false },
      { label: "No Threads", accelerator: null, enabled: false },
    ]);
  });

  it("lists the sidebar's threads in Go under Office, Intake and Workflows, top to bottom, and opens the one chosen", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const threads = await fleet.spawnThreads(2, { runner });
    for (const thread of threads) await waitForStatus(thread.id, "busy");
    const { app, page } = await openSignedIn(url);
    await expect.poll(() => readSidebarTitles(page)).toHaveLength(2);
    const titles = await readSidebarTitles(page);

    await expect
      .poll(() => readMenuItems(app, "Go"))
      .toEqual([
        { label: "Office", accelerator: "CmdOrCtrl+Shift+O", enabled: true },
        { label: "Intake", accelerator: "CmdOrCtrl+Shift+I", enabled: true },
        { label: "Workflows", accelerator: "CmdOrCtrl+Shift+W", enabled: true },
        ...titles.map((label, index) => ({
          label,
          accelerator: `CmdOrCtrl+${String(index + 1)}`,
          enabled: true,
        })),
      ]);

    await chooseMenuItem(app, "Go", titles[1]!);
    await page.locator('section[aria-label="Transcript"]').waitFor();
    expect(await readOpenThreadTitle(page)).toBe(titles[1]);
  });

  it("sends what the open thread's composer holds with Thread > Send", async () => {
    const { url, fleet, waitForStatus } = await arrangeFleet();
    const runner = await fleet.enlistRunner("studio");
    const { thread, played } = await fleet.spawnScriptedThread(
      { runner, prompt: "Why does the checkout test fail?" },
      [{ kind: "end", state: "completed" }],
    );
    await played;
    await waitForStatus(thread.id, "idle");
    const { app, page } = await openSignedIn(url);
    await keepWindowOnTop(app);
    await openThread(page, "Why does the checkout test fail?");
    const field = page.getByRole("textbox", { name: "Message" });

    await field.fill("Add a retry");
    await chooseMenuItem(app, "Thread", "Send");

    await page.locator(".msg--me .bubble", { hasText: "Add a retry" }).waitFor();
    expect(await readFieldText(field)).toBe("");
    await fleet.waitForTurn(thread.id, 2, "running");
  });

  it("undoes and redoes typing in the thread's composer with Edit > Undo and Edit > Redo", async () => {
    const { app, field } = await openThreadComposer();
    await field.click();
    await field.pressSequentially("Add a retry");
    expect(await readFieldText(field)).toBe("Add a retry");

    await chooseMenuItemWithPageFocused(app, "Edit", "Undo");
    await expect.poll(() => readFieldText(field)).toBe("");
    await chooseMenuItemWithPageFocused(app, "Edit", "Redo");
    await expect.poll(() => readFieldText(field)).toBe("Add a retry");
  });

  it("undoes and redoes a paste into the thread's composer with Edit > Undo and Edit > Redo", async () => {
    const { app, page, field } = await openThreadComposer();
    await field.click();
    await copyToClipboard(app, "Add a retry");
    await page.keyboard.press("Meta+V");
    await expect.poll(() => readFieldText(field)).toBe("Add a retry");

    await chooseMenuItemWithPageFocused(app, "Edit", "Undo");
    await expect.poll(() => readFieldText(field)).toBe("");
    await chooseMenuItemWithPageFocused(app, "Edit", "Redo");
    await expect.poll(() => readFieldText(field)).toBe("Add a retry");
  });

  it("undoes and redoes typing in a plain text field with Edit > Undo and Edit > Redo", async () => {
    const { app, page } = await launchForTest();
    await page.getByRole("button", { name: "Connect to it" }).click();
    await focusWindow(app);
    const address = page.getByRole("textbox", { name: "Address", exact: true });
    await address.click();
    await address.pressSequentially("http://127.0.0.1:4937");

    await chooseMenuItemWithPageFocused(app, "Edit", "Undo");
    await expect.poll(() => address.inputValue()).toBe("");
    await chooseMenuItemWithPageFocused(app, "Edit", "Redo");
    await expect.poll(() => address.inputValue()).toBe("http://127.0.0.1:4937");
  });

  it.each([
    ["Undo", "undo:"],
    ["Redo", "redo:"],
  ])(
    "sends Edit > %s to the native control that has the focus, such as the folder sheet's field",
    async (label, action) => {
      const { app } = await launchForTest();
      await focusWindow(app);
      // The sheet's fields cannot be typed into from a test, so main's call
      // that would reach them is recorded instead. The sheet stays open until
      // the app quits.
      await app.evaluate(({ BrowserWindow, dialog, Menu }) => {
        const sent: string[] = [];
        Object.assign(globalThis, { sentToFirstResponder: sent });
        Menu.sendActionToFirstResponder = (actionName) => void sent.push(actionName);
        void dialog.showOpenDialog(BrowserWindow.getAllWindows()[0]!, {
          properties: ["openDirectory"],
        });
      });
      await expect
        .poll(() => app.evaluate(({ webContents }) => webContents.getFocusedWebContents() === null))
        .toBe(true);

      await chooseMenuItem(app, "Edit", label);

      await expect
        .poll(() =>
          app.evaluate(
            () =>
              (globalThis as unknown as { sentToFirstResponder: string[] }).sentToFirstResponder,
          ),
        )
        .toEqual([action]);
    },
  );

  it.each(["Undo", "Redo"])(
    "keeps a hidden window hidden when Edit > %s is chosen",
    async (label) => {
      const { app } = await launchForTest();
      await hideWindow(app);

      await chooseMenuItem(app, "Edit", label);

      // Showing the window is asynchronous, so there is nothing to wait for
      // when it stays hidden: the test gives it time to show, and it must not.
      await sleep(500);
      expect(await isWindowVisible(app)).toBe(false);
    },
  );
});
