/**
 * Tests the dock badge and the threads' notifications in the packaged app,
 * signed in to a real controller whose threads run on a scripted runner
 * (spec 17, §Native behaviour):
 *
 * - the badge counts the threads waiting on the user, and a Request that
 *   opens while the window is hidden shows a notification;
 * - a Request answered elsewhere, here through the API, removes its
 *   notification and lowers the badge;
 * - clicking a notification shows the window and opens its thread;
 * - signing out hides the badge, removes the notifications and empties Go.
 *
 * The harness records main's notifications instead of showing them
 * (see `launchForTest`), so a test hides the window to have main make one,
 * and clicks it through `clickWaitingNotification`.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { describe, expect, it } from "vitest";
import { isWindowVisible } from "../../apps/desktop/scripts/packaged-app";
import {
  arrangeFleet,
  chooseMenuItem,
  clickWaitingNotification,
  hideWindow,
  openSignedIn,
  readBadgeCount,
  readMenuItems,
  readOpenThreadTitle,
  readWaitingNotifications,
} from "./harness";

/**
 * Starts a controller with one busy thread, "Thread 1", on a scripted runner,
 * and the app signed in to it with its window hidden.
 */
async function arrangeHiddenApp() {
  const arranged = await arrangeFleet();
  const runner = await arranged.fleet.enlistRunner("studio");
  const [thread] = await arranged.fleet.spawnThreads(1, { runner });
  await arranged.waitForStatus(thread!.id, "busy");
  const launched = await openSignedIn(arranged.url);
  await hideWindow(launched.app);
  return { ...arranged, ...launched, runner, thread: thread! };
}

describe("the dock badge and the threads' notifications", () => {
  it("counts a thread that starts waiting and shows its notification, then removes both once the Request is answered elsewhere", async () => {
    const { app, client, runner, thread } = await arrangeHiddenApp();
    expect(await readBadgeCount(app)).toBe(0);

    const requestId = runner.openRequest(thread.id, "command_approval");

    await expect.poll(() => readBadgeCount(app)).toBe(1);
    await expect
      .poll(() => readWaitingNotifications(app))
      .toEqual([{ title: "Thread 1", body: "Run pnpm test?", state: "shown" }]);

    await client.session.respondToApprovalRequest({
      params: { id: thread.id },
      payload: { requestId, decision: "allow" },
    });

    await expect.poll(() => readBadgeCount(app)).toBe(0);
    await expect
      .poll(() => readWaitingNotifications(app))
      .toEqual([{ title: "Thread 1", body: "Run pnpm test?", state: "closed" }]);
  });

  it("shows the window and opens the thread when its notification is clicked", async () => {
    const { app, page, runner, thread } = await arrangeHiddenApp();
    runner.openRequest(thread.id, "command_approval");
    await expect.poll(() => readWaitingNotifications(app)).toHaveLength(1);

    await clickWaitingNotification(app, 0);

    await page.locator('section[aria-label="Transcript"]').waitFor();
    expect(await isWindowVisible(app)).toBe(true);
    expect(await readOpenThreadTitle(page)).toBe("Thread 1");
  });

  it("hides the badge, removes the notifications and empties Go when the user signs out", async () => {
    const { app, page, runner, thread } = await arrangeHiddenApp();
    runner.openRequest(thread.id, "command_approval");
    await expect.poll(() => readWaitingNotifications(app)).toHaveLength(1);
    expect(await readBadgeCount(app)).toBe(1);
    await expect
      .poll(async () => (await readMenuItems(app, "Go")).map((item) => item.label))
      .toEqual(["Office", "Thread 1"]);

    await chooseMenuItem(app, "Hercule", "Sign Out");

    await page.getByRole("button", { name: "Sign in" }).waitFor();
    await expect.poll(() => readBadgeCount(app)).toBe(0);
    expect(await readWaitingNotifications(app)).toEqual([
      { title: "Thread 1", body: "Run pnpm test?", state: "closed" },
    ]);
    expect(await readMenuItems(app, "Go")).toEqual([
      { label: "Office", accelerator: "CmdOrCtrl+Shift+O", enabled: false },
      { label: "No Threads", accelerator: null, enabled: false },
    ]);
  });
});
