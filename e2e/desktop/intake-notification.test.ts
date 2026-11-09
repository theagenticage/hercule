/**
 * Tests the notification of a new Now signal in the packaged app, signed in
 * to a real controller whose signals the test raises with `hercule signal
 * raise` (spec 17 §Testing): a new Now signal notifies while the window is not
 * focused, and a click on the notification opens Intake with the signal
 * selected.
 *
 * Run `pnpm build:desktop` and `pnpm build:binary` first.
 */
import { describe, expect, it } from "vitest";
import { isWindowVisible } from "../../apps/desktop/scripts/packaged-app";
import {
  arrangeFleet,
  clickWaitingNotification,
  hideWindow,
  openSignedIn,
  readWaitingNotifications,
} from "./harness";
import {
  raiseSignal,
  writeSignalColumns,
  readScreenTitle,
  readSelectedTitle,
  readToDoCounts,
  openSignalPane,
} from "./intake-helpers";

/** Raises the signal `signalId` to the priority `urgent`, in the controller's database. */
const makeSignalUrgent = (home: string, signalId: string): void =>
  writeSignalColumns(home, signalId, { priority: "urgent" });

describe("Intake, the notification", () => {
  it("notifies a new Now signal while the window is not focused, and opens Intake on it when the notification is clicked", async () => {
    const arranged = await arrangeFleet();
    await raiseSignal(arranged, "fyi", "Earlier news");
    const { app, page } = await openSignedIn(arranged.url);
    await expect.poll(() => readToDoCounts(page)).toMatchObject({ segment: "Hercule, 1 to do" });
    await hideWindow(app);

    const urgent = await raiseSignal(arranged, "fyi", "Checkout is down", ["--priority", "high"]);
    await expect.poll(() => readToDoCounts(page)).toMatchObject({ segment: "Hercule, 2 to do" });
    expect(await readWaitingNotifications(app)).toEqual([]);
    // The app reads To do again once it reconnects, and the list then holds
    // an urgent signal it has not seen.
    await arranged.restartController(() => makeSignalUrgent(arranged.home, urgent));

    await expect
      .poll(() => readWaitingNotifications(app))
      .toEqual([{ title: expect.any(String) as string, body: "Checkout is down", state: "shown" }]);

    await clickWaitingNotification(app, 0);
    await expect.poll(() => isWindowVisible(app)).toBe(true);
    await expect.poll(() => readScreenTitle(page)).toBe("Intake");
    await expect.poll(() => readSelectedTitle(page)).toBe("Checkout is down");
    expect(await openSignalPane(page).locator(".ad-title").textContent()).toBe("Checkout is down");
    expect(await page.locator(".asks-sec", { hasText: "Now" }).count()).toBe(1);
  });
});
