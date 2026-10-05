/**
 * Tests the menu bar in the packaged app (spec 17, §Native behaviour):
 *
 * - the menus stand in the order macOS users expect, and Go holds a dimmed
 *   Office and a dimmed "No Threads" while signed out;
 * - Go lists the sidebar's threads under Office, top to bottom, with ⌘1 and
 *   on, and choosing one opens it;
 * - Thread > Send sends what the open thread's composer holds.
 *
 * Signed in, the app reaches a real controller whose threads run on a
 * scripted runner. Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import {
  arrangeFleet,
  chooseMenuItem,
  keepWindowOnTop,
  launchForTest,
  openSignedIn,
  openThread,
  readMenuItems,
  readMenuLabels,
  readOpenThreadTitle,
} from "./harness";

/** Returns the titles of the sidebar's thread rows, top to bottom. */
function readSidebarTitles(page: Page): Promise<string[]> {
  return page
    .locator('nav[aria-label="Threads"] a.side-row:not(.side-row--wait) .side-name')
    .allTextContents();
}

describe("the menu bar", () => {
  it("has the app menu, File, Edit, Go, Thread and Window, and a dimmed Office and No Threads in Go while signed out", async () => {
    const { app } = await launchForTest();

    expect(await readMenuLabels(app)).toEqual([
      "Hercule",
      "File",
      "Edit",
      "Go",
      "Thread",
      "Window",
    ]);
    expect(await readMenuItems(app, "Go")).toEqual([
      { label: "Office", accelerator: "CmdOrCtrl+Shift+O", enabled: false },
      { label: "No Threads", accelerator: null, enabled: false },
    ]);
  });

  it("lists the sidebar's threads in Go under Office, top to bottom, and opens the one chosen", async () => {
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
    expect(await field.inputValue()).toBe("");
    await fleet.waitForTurn(thread.id, 2, "running");
  });
});
